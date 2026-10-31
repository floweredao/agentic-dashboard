
import { afterEach, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { join } from "node:path";

import { NARRATION_LIMITS } from "../shared/contracts";
import { ProviderError } from "../server/narration";

import { recordResult } from "./backend-helper";
import { cleanupNarration, deferred, setup, read, research, narration, waits, busy, TRIES } from "./narration-helper";
afterEach(cleanupNarration);

test("the owner makes a narration and plays it, with byte ranges for seeking", async () => {
  const { f, tts, audioFiles, idle } = (await setup());
  const owner = await f.login();
  const record = await research(f, owner);

  // When: the owner asks for a narration.
  const queued = await f.call(narration(record.id), "POST", {}, owner);
  expect(queued.status).toBe(202);
  expect((await read(queued)).narration?.status).toBe("queued");
  await idle();

  // Then: it is ready, the script was polished without the URL or Markdown, and one second of audio per chunk was stored.
  const state = await read(await f.call(narration(record.id), "GET", undefined, owner));
  expect(state.available).toBe(true);
  expect(state.narration).toMatchObject({ status: "ready", stale: false, attempts: 0, error: null });
  expect(state.narration?.audio).toMatchObject({ mime: "audio/wav", bytes: 44 + 48000, durationMs: 1000, model: "fake-tts", voice: "Kore" });
  expect(state.narration?.script).toBe("조사 제목\n첫 문단입니다. 자세한 내용은 에 있어요.\n\n둘째 문단입니다.");
  expect(tts.calls.speak).toEqual([state.narration?.script ?? ""]);
  const files = audioFiles();
  expect(files).toHaveLength(1);
  expect(statSync(join(f.dir, "audio", files[0] ?? "")).mode & 0o777).toBe(0o600);

  // And: the audio URL serves the file, and a Range request answers 206 with that slice.
  const url = state.narration?.audio?.url ?? "";
  const full = await f.call(url, "GET", undefined, owner);
  expect(full.status).toBe(200);
  expect(full.headers.get("content-type")).toBe("audio/wav");
  expect(full.headers.get("accept-ranges")).toBe("bytes");
  const bytes = new Uint8Array(await full.arrayBuffer());
  expect(bytes.byteLength).toBe(44 + 48000);
  expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("RIFF");
  const part = await f.call(url, "GET", undefined, { ...owner, Range: "bytes=0-99" });
  expect(part.status).toBe(206);
  expect(part.headers.get("content-range")).toBe(`bytes 0-99/${44 + 48000}`);
  expect((await part.arrayBuffer()).byteLength).toBe(100);
  expect((await f.call(url, "GET", undefined, { ...owner, Range: "bytes=999999-" })).status).toBe(416);

  // And: asking again for unchanged content returns the same audio without a new generation.
  const again = await f.call(narration(record.id), "POST", {}, owner);
  expect(again.status).toBe(200);
  expect(tts.calls.script).toBe(1);
});

test("changed content marks the audio stale; regenerating replaces the file and keeps the old one playable meanwhile", async () => {
  const { f, tts, audioFiles, idle } = (await setup());
  const owner = await f.login();
  const record = await research(f, owner);
  await f.call(narration(record.id), "POST", {}, owner);
  await idle();
  const first = audioFiles();

  // A tag change is not content: still fresh.
  const tagged = recordResult.parse(await (await f.call(`/api/v1/records/${record.id}`, "PATCH", { expectedVersion: record.version, changes: { tags: ["새태그"] } }, owner)).json()).record;
  expect((await read(await f.call(narration(record.id), "GET", undefined, owner))).narration?.stale).toBe(false);

  // A body change is: stale, and the old audio is still there.
  await f.call(`/api/v1/records/${record.id}`, "PATCH", { expectedVersion: tagged.version, changes: { body: "바뀐 본문" } }, owner);
  const stale = await read(await f.call(narration(record.id), "GET", undefined, owner));
  expect(stale.narration).toMatchObject({ status: "ready", stale: true });

  const queued = await read(await f.call(narration(record.id), "POST", {}, owner));
  expect(queued.narration?.audio?.url).toBe(stale.narration?.audio?.url ?? "missing");
  await idle();
  const fresh = await read(await f.call(narration(record.id), "GET", undefined, owner));
  expect(fresh.narration).toMatchObject({ status: "ready", stale: false });
  expect(fresh.narration?.audio?.url).not.toBe(stale.narration?.audio?.url ?? "");
  expect(tts.calls.script).toBe(2);
  const second = audioFiles();
  expect(second).toHaveLength(1);
  expect(second[0]).not.toBe(first[0]);
});

test("a busy script model is retried with growing waits on the same model, and when every try fails the job fails without audio", async () => {
  // Given: the script model answers 503 (high demand) to every try.
  const clock = waits();
  const { f, tts, idle, audioFiles } = (await setup(undefined, { retryDelayMs: 1000, sleep: clock.sleep }));
  const owner = await f.login();
  const record = await research(f, owner);
  tts.scriptErrors = Array.from({ length: TRIES }, busy);
  // When: the owner asks for audio.
  await f.call(narration(record.id), "POST", {}, owner);
  await idle();
  // Then: only the script model is tried, 1 + retries times with exponential waits (plus a little jitter); no other model writes
  // a script, nothing is spoken and the job fails with the model's own failure (2026-10-07: the owner wants no lighter model).
  expect(tts.calls.models).toEqual(Array.from({ length: TRIES }, () => "fake-script"));
  expect(clock.slept).toHaveLength(NARRATION_LIMITS.retries);
  clock.slept.forEach((ms, index) => {
    expect(ms).toBeGreaterThanOrEqual(1000 * 2 ** index);
    expect(ms).toBeLessThanOrEqual(1000 * 2 ** index * 1.25);
  });
  expect(tts.calls.speak).toEqual([]);
  expect(tts.calls.converse).toEqual([]);
  expect(audioFiles()).toEqual([]);
  expect((await read(await f.call(narration(record.id), "GET", undefined, owner))).narration).toMatchObject({ status: "failed", error: "http_503", attempts: 1, audio: null });
});

for (const code of ["stalled", "timeout"]) test(`a script model that ${code === "stalled" ? "stalls" : "times out"} is tried again at once, with the same model`, async () => {
  const clock = waits();
  const { f, tts, idle } = (await setup(undefined, { retryDelayMs: 1000, sleep: clock.sleep }));
  const owner = await f.login();
  const record = await research(f, owner);
  // Given: the script model hangs once (2026-10-07: gemini-3.8-flash on the AI Studio key sent nothing for minutes).
  tts.scriptErrors = [new ProviderError(code, true)];
  await f.call(narration(record.id), "POST", {}, owner);
  await idle();
  // Then: no wait, the same model wrote the script on the second try, and the audio is ready.
  expect(clock.slept).toEqual([]);
  expect(tts.calls.models).toEqual(["fake-script", "fake-script"]);
  expect((await read(await f.call(narration(record.id), "GET", undefined, owner))).narration?.status).toBe("ready");
});

test("a script model that stalls on every try fails the job as stalled after 1 + retries tries, with no wait and no other model", async () => {
  const clock = waits();
  const { f, tts, idle } = (await setup(undefined, { retryDelayMs: 1000, sleep: clock.sleep }));
  const owner = await f.login();
  const record = await research(f, owner);
  tts.scriptErrors = Array.from({ length: TRIES }, () => new ProviderError("stalled", true));
  await f.call(narration(record.id), "POST", {}, owner);
  await idle();
  expect(clock.slept).toEqual([]);
  expect(tts.calls.models).toEqual(Array.from({ length: TRIES }, () => "fake-script"));
  expect(tts.calls.speak).toEqual([]);
  expect((await read(await f.call(narration(record.id), "GET", undefined, owner))).narration).toMatchObject({ status: "failed", error: "stalled", attempts: 1, audio: null });
});

test("with two routes to the same model, a try alternates between them and a route that fails for good is not asked again", async () => {
  const clock = waits();
  const { f, tts, idle } = (await setup(undefined, { retryDelayMs: 1000, sleep: clock.sleep }));
  (tts.provider as { scriptRoutes?: readonly string[] }).scriptRoutes = ["vertex", "gemini"];
  const owner = await f.login();
  const record = await research(f, owner);
  // Given: Vertex stalls, the key route stalls, Vertex's login is refused (final), then the key route answers.
  tts.scriptErrors = [new ProviderError("stalled", true), new ProviderError("stalled", true), new ProviderError("vertex_auth", false)];
  await f.call(narration(record.id), "POST", {}, owner);
  await idle();
  // Then: vertex, gemini, vertex, then only gemini; no waits, and the audio is ready.
  expect(tts.calls.models).toEqual(["vertex", "gemini", "vertex", "gemini"]);
  expect(clock.slept).toEqual([]);
  expect((await read(await f.call(narration(record.id), "GET", undefined, owner))).narration?.status).toBe("ready");
});

test("while a script is being tried again, the job says which try is running", async () => {
  const { f, tts, idle } = (await setup());
  const owner = await f.login();
  const record = await research(f, owner);
  // Given: the first try stalled and the second is streaming in.
  tts.scriptErrors = [new ProviderError("stalled", true)];
  const gate = (tts.scriptHold = { entered: deferred<AbortSignal>(), release: deferred<void>() });
  expect((await f.call(narration(record.id), "POST", {}, owner)).status).toBe(202);
  await gate.entered.promise;
  // Then: the state names try 2; once the speech starts there is no script try to show.
  expect((await read(await f.call(narration(record.id), "GET", undefined, owner))).narration).toMatchObject({ status: "scripting", scriptTry: 2 });
  gate.release.resolve();
  await idle();
  // The key is left out rather than null, so clients built before it (strict schemas: the CLI, a cached app) still read the state.
  const after = await (await f.call(narration(record.id), "GET", undefined, owner)).json() as { narration: Record<string, unknown> };
  expect(after.narration.status).toBe("ready");
  expect(Object.keys(after.narration)).not.toContain("scriptTry");
});

test("a used-up daily quota is not retried: the script fails as quota_daily and nothing is spoken", async () => {
  const clock = waits();
  const { f, tts, idle } = (await setup(undefined, { retryDelayMs: 1000, sleep: clock.sleep }));
  const owner = await f.login();
  const record = await research(f, owner);
  // Given: the script model's daily free quota is used up.
  tts.scriptErrors = [new ProviderError("quota_daily", false)];
  await f.call(narration(record.id), "POST", {}, owner);
  await idle();
  // Then: no waits, one try of the same model, no speech, and the failure says why.
  expect(clock.slept).toEqual([]);
  expect(tts.calls.models).toEqual(["fake-script"]);
  expect(tts.calls.speak).toEqual([]);
  expect((await read(await f.call(narration(record.id), "GET", undefined, owner))).narration).toMatchObject({ status: "failed", error: "quota_daily", attempts: 1 });
});

test("a used-up daily speech quota is not retried and fails as quota_daily", async () => {
  const clock = waits();
  const { f, tts, idle } = (await setup(undefined, { retryDelayMs: 1000, sleep: clock.sleep }));
  const owner = await f.login();
  const record = await research(f, owner);
  tts.speakErrors = [new ProviderError("quota_daily", false)];
  await f.call(narration(record.id), "POST", {}, owner);
  await idle();
  expect(clock.slept).toEqual([]);
  expect(tts.calls.speak).toHaveLength(1);
  expect((await read(await f.call(narration(record.id), "GET", undefined, owner))).narration).toMatchObject({ status: "failed", error: "quota_daily", attempts: 1 });
});

test("a per-minute 429 waits as long as the provider asks, then keeps that pace between the chunks; a wait over a minute is not sat out", async () => {
  const clock = waits();
  const { f, tts, idle } = (await setup(undefined, { retryDelayMs: 1000, sleep: clock.sleep }));
  const owner = await f.login();
  const record = await research(f, owner);
  // Given: a script of three chunks, and a rate limit on the first chunk that asks for 7 seconds.
  tts.scriptText = Array.from({ length: 3 }, (_, index) => `Paragraph ${index}. ${"a".repeat(NARRATION_LIMITS.chunkChars - 15)}`).join("\n\n");
  tts.speakErrors = [Object.assign(new ProviderError("http_429", true), { retryAfterMs: 7000 })];
  await f.call(narration(record.id), "POST", {}, owner);
  await idle();
  // Then: one 7 s wait for the retry, and a 7 s pause before each later chunk.
  expect(tts.calls.speak).toHaveLength(4);
  expect(clock.slept).toEqual([7000, 7000, 7000]);
  expect((await read(await f.call(narration(record.id), "GET", undefined, owner))).narration?.status).toBe("ready");

  // And: when the provider asks for more than a minute, the job fails as a rate limit instead of hanging.
  const other = await research(f, owner);
  clock.slept.length = 0;
  tts.speakErrors = [Object.assign(new ProviderError("http_429", true), { retryAfterMs: 120_000 })];
  await f.call(narration(other.id), "POST", {}, owner);
  await idle();
  expect(clock.slept).toEqual([]);
  expect((await read(await f.call(narration(other.id), "GET", undefined, owner))).narration).toMatchObject({ status: "failed", error: "http_429" });
});
