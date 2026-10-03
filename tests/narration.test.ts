import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { digestOfPartId, digestPartId, NARRATION_LIMITS, NarrationStateSchema } from "../shared/contracts";
import { dialogueChunks, normalizeScript, PODCAST_SCRIPT_SYSTEM, ProviderError, SCRIPT_SYSTEM, splitChunks } from "../server/narration";
import type { NarrationOptions, NarrationProvider, SpeechTurn } from "../server/narration";
import { agentRecord, bearer, fixture, payload, recordResult } from "./backend-helper";

const SCRIPT = "# 조사 제목\n첫 문단입니다. 자세한 내용은 https://example.com/a?b=1 에 있어요.\n\n**둘째** 문단입니다.";
/** Holds every speak call until `release` (or the call's abort, like a real fetch); `entered` hands over the first call's signal. */
type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
type Hold = { entered: Deferred<AbortSignal>; release: Deferred<void> };
function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
type Fake = {
  provider: NarrationProvider; calls: { script: number; speak: string[]; prompts: string[]; systems: string[]; converse: SpeechTurn[][]; models: string[] }; available: boolean;
  failSpeak: number | "always"; error: Error | null; scriptText: string; hold: Hold | null;
  /** Thrown, one per call and in order, by the next script and speak calls. */
  scriptErrors: ProviderError[]; speakErrors: ProviderError[];
};

/** A TTS provider that returns one second of silence per chunk and records what it was asked. */
function fake(): Fake {
  const state: Fake = { calls: { script: 0, speak: [], prompts: [], systems: [], converse: [], models: [] }, available: true, failSpeak: 0, error: null, scriptText: SCRIPT,
    hold: null, scriptErrors: [], speakErrors: [], provider: null as never };
  state.provider = {
    ttsModel: "fake-tts", scriptModel: "fake-script", fallbackScriptModel: "fake-lite", voice: "Kore", hosts: ["Kore", "Puck"],
    available: async () => state.available,
    script: async (system, prompt, _signal, model) => {
      state.calls.models.push(model ?? "fake-script");
      const failure = state.scriptErrors.shift();
      if (failure) throw failure;
      state.calls.script += 1; state.calls.prompts.push(prompt); state.calls.systems.push(system); return state.scriptText;
    },
    converse: async (turns, _style, signal) => {
      state.calls.converse.push([...turns]);
      const hold = state.hold;
      if (hold) {
        hold.entered.resolve(signal);
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          void hold.release.promise.then(resolve);
        });
      }
      return new Uint8Array(48000);
    },
    speak: async (text, _style, signal) => {
      state.calls.speak.push(text);
      const hold = state.hold;
      if (hold) {
        hold.entered.resolve(signal);
        await new Promise<void>((resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          void hold.release.promise.then(resolve);
        });
      }
      if (state.error) throw state.error;
      const failure = state.speakErrors.shift();
      if (failure) throw failure;
      if (state.failSpeak === "always" || state.failSpeak > 0) {
        if (state.failSpeak !== "always") state.failSpeak -= 1;
        throw new ProviderError("http_500", true);
      }
      return new Uint8Array(48000);
    },
  };
  return state;
}
const wavOnly = async (path: string) => ({ path, mime: "audio/wav" });
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

function setup(dailyLimit?: number, extra: Partial<Omit<NarrationOptions, "store" | "provider" | "audioDir">> = {}) {
  const tts = fake();
  const f = fixture(10000, Date.now, { narration: { provider: tts.provider, encode: wavOnly, retryDelayMs: 0, ...(dailyLimit ? { dailyLimit } : {}), ...extra } });
  cleanups.push(() => f.close());
  const audioFiles = () => existsSync(join(f.dir, "audio")) ? readdirSync(join(f.dir, "audio")) : [];
  return { f, tts, audioFiles, idle: () => f.app.narration.idle() };
}
type Fixture = ReturnType<typeof setup>["f"];
const read = async (response: Response) => NarrationStateSchema.parse(await response.json());
async function research(f: Fixture, headers: HeadersInit) {
  const response = await f.call("/api/v1/records", "POST", { requestId: crypto.randomUUID(), record: {
    kind: "research", title: "조사", body: "| 항목 | 값 |\n|---|---|\n| A | 1 |", fields: { summary: "요약", conclusion: "결론" },
  } }, headers);
  expect(response.status).toBe(201);
  return recordResult.parse(await response.json()).record;
}
const narration = (id: string) => `/api/v1/records/${id}/narration`;
const hold = (tts: Fake): Hold => (tts.hold = { entered: deferred<AbortSignal>(), release: deferred<void>() });
/** Two paragraphs that cannot share one chunk, so a job has a second paid call left to skip. */
const TWO_CHUNKS = `${"첫 문단입니다. ".repeat(100)}\n\n${"둘째 문단입니다. ".repeat(100)}`;

test("cancelling while speaking aborts the call, makes no further call and fails as cancelled without an attempt", async () => {
  const { f, tts, audioFiles, idle } = setup();
  const owner = await f.login();
  const record = await research(f, owner);
  tts.scriptText = TWO_CHUNKS;
  const gate = hold(tts);
  // Given: the first of two chunks is being spoken.
  expect((await f.call(narration(record.id), "POST", {}, owner)).status).toBe(202);
  const signal = await gate.entered.promise;
  expect(tts.calls.speak).toHaveLength(1);

  // When: the owner cancels.
  const cancelled = await f.call(`${narration(record.id)}/cancel`, "POST", {}, owner);

  // Then: the in-flight call is aborted, the job fails as cancelled without counting an attempt, and nothing more is spoken.
  expect(cancelled.status).toBe(200);
  expect((await read(cancelled)).narration).toMatchObject({ status: "failed", error: "cancelled", attempts: 0, progress: null });
  expect(signal.aborted).toBe(true);
  await idle();
  expect(tts.calls.speak).toHaveLength(1);
  const after = await read(await f.call(narration(record.id), "GET", undefined, owner));
  expect(after.narration).toMatchObject({ status: "failed", error: "cancelled", attempts: 0, audio: null });
  expect(after.narration?.script).toBeTruthy();
  expect(audioFiles()).toEqual([]);
});

test("cancelling a regeneration keeps the earlier audio ready and playable", async () => {
  const { f, tts, audioFiles, idle } = setup();
  const owner = await f.login();
  const record = await research(f, owner);
  await f.call(narration(record.id), "POST", {}, owner);
  await idle();
  const earlier = (await read(await f.call(narration(record.id), "GET", undefined, owner))).narration?.audio?.url ?? "";
  // Given: a forced regeneration is speaking.
  const gate = hold(tts);
  expect((await f.call(narration(record.id), "POST", { force: true }, owner)).status).toBe(202);
  await gate.entered.promise;

  // When: the owner cancels it.
  const cancelled = await read(await f.call(`${narration(record.id)}/cancel`, "POST", {}, owner));
  await idle();

  // Then: the earlier audio is ready again and still served.
  expect(cancelled.narration).toMatchObject({ status: "ready", error: null, progress: null, attempts: 0 });
  expect(cancelled.narration?.audio?.url).toBe(earlier);
  expect((await read(await f.call(narration(record.id), "GET", undefined, owner))).narration).toMatchObject({ status: "ready" });
  expect((await f.call(earlier, "GET", undefined, owner)).status).toBe(200);
  expect(audioFiles()).toHaveLength(1);
});

test("a job cancelled while queued behind another never reaches the provider", async () => {
  const { f, tts, idle } = setup();
  const owner = await f.login();
  const first = await research(f, owner);
  const second = await research(f, owner);
  // Given: the first job is speaking and the second waits behind it.
  const gate = hold(tts);
  await f.call(narration(first.id), "POST", {}, owner);
  expect((await read(await f.call(narration(second.id), "POST", {}, owner))).narration?.status).toBe("queued");
  await gate.entered.promise;

  // When: the waiting job is cancelled and the first one finishes.
  const cancelled = await read(await f.call(`${narration(second.id)}/cancel`, "POST", {}, owner));
  gate.release.resolve();
  await idle();

  // Then: only the first job was scripted and spoken.
  expect(cancelled.narration).toMatchObject({ status: "failed", error: "cancelled", attempts: 0 });
  expect((await read(await f.call(narration(first.id), "GET", undefined, owner))).narration?.status).toBe("ready");
  expect((await read(await f.call(narration(second.id), "GET", undefined, owner))).narration).toMatchObject({ status: "failed", error: "cancelled" });
  expect(tts.calls.script).toBe(1);
  expect(tts.calls.speak).toHaveLength(1);
});

test("a new request after a cancel runs to ready and reuses the saved script", async () => {
  const { f, tts, idle } = setup();
  const owner = await f.login();
  const record = await research(f, owner);
  const gate = hold(tts);
  await f.call(narration(record.id), "POST", {}, owner);
  await gate.entered.promise;
  await f.call(`${narration(record.id)}/cancel`, "POST", {}, owner);
  tts.hold = null;

  // When: the owner asks again.
  expect((await f.call(narration(record.id), "POST", {}, owner)).status).toBe(202);
  await idle();

  // Then: the new job is not stopped by the old cancel, and the script was not paid for twice.
  expect((await read(await f.call(narration(record.id), "GET", undefined, owner))).narration).toMatchObject({ status: "ready", error: null, attempts: 0 });
  expect(tts.calls.script).toBe(1);
  expect(tts.calls.speak).toHaveLength(2);
});

test("cancel is owner-only with CSRF, answers 404 for unknown ids and works for digests", async () => {
  const { f, tts, idle } = setup();
  const owner = await f.login();
  const record = await research(f, owner);
  const { Cookie, Origin } = owner;
  const cancel = `${narration(record.id)}/cancel`;

  // Owner with CSRF: 200 with the state (nothing to stop here), with {} or without a body.
  const idleState = await f.call(cancel, "POST", {}, owner);
  expect(idleState.status).toBe(200);
  expect((await read(idleState)).narration).toBeNull();
  expect((await f.call(cancel, "POST", undefined, owner)).status).toBe(200);
  expect((await f.call(cancel, "POST", { force: true }, owner)).status).toBe(400);
  // Missing CSRF, an agent that can read the record, and an unknown record are refused.
  expect((await f.call(cancel, "POST", {}, { Cookie, Origin })).status).toBe(403);
  const agent = await f.call(cancel, "POST", {}, bearer("omo"));
  expect(agent.status).toBe(403);
  expect(await agent.text()).toContain("Owner session required");
  expect((await f.call(`${narration(crypto.randomUUID())}/cancel`, "POST", {}, owner)).status).toBe(404);

  // A digest's narration is cancelled through its own route.
  const created = await f.call("/api/v1/digests", "POST", { date: "2026-10-01", slot: "morning", notify: false, sections: [
    { key: "domestic", title: "Domestic", kind: "articles", items: [{ key: "a", title: "국내 소식", source: "연합뉴스", summary: "요약", url: "https://news.example.com/a" }] }] }, bearer("omo"));
  const id = (await created.json() as { digest: { id: string } }).digest.id;
  const path = `/api/v1/digests/${id}/narration`;
  const gate = hold(tts);
  expect((await f.call(path, "POST", {}, owner)).status).toBe(202);
  await gate.entered.promise;
  expect((await f.call(`${path}/cancel`, "POST", {}, { Cookie, Origin })).status).toBe(403);
  expect((await f.call(`${path}/cancel`, "POST", {}, bearer("omo"))).status).toBe(403);
  const stopped = await f.call(`${path}/cancel`, "POST", {}, owner);
  expect(stopped.status).toBe(200);
  expect((await read(stopped)).narration).toMatchObject({ status: "failed", error: "cancelled" });
  await idle();
  expect(tts.calls.speak).toHaveLength(1);
  expect((await f.call(`/api/v1/digests/${crypto.randomUUID()}/narration/cancel`, "POST", {}, owner)).status).toBe(404);
});

test("the owner makes a narration and plays it, with byte ranges for seeking", async () => {
  const { f, tts, audioFiles, idle } = setup();
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
  const { f, tts, audioFiles, idle } = setup();
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

/** A recorder for the waits between retries, which returns at once. */
function waits() {
  const slept: number[] = [];
  return { slept, sleep: async (ms: number) => { slept.push(ms); } };
}
const busy = () => new ProviderError("http_503", true);

test("a busy script model is retried with growing waits, then the lighter model writes the script", async () => {
  // Given: the script model answers 503 (high demand) to every try.
  const clock = waits();
  const { f, tts, idle } = setup(undefined, { retryDelayMs: 1000, sleep: clock.sleep });
  const owner = await f.login();
  const record = await research(f, owner);
  tts.scriptErrors = Array.from({ length: NARRATION_LIMITS.retries + 1 }, busy);
  // When: the owner asks for audio.
  await f.call(narration(record.id), "POST", {}, owner);
  await idle();
  // Then: the main model is tried 1 + retries times with exponential waits (plus a little jitter), then the fallback succeeds.
  expect(tts.calls.models).toEqual([...Array.from({ length: NARRATION_LIMITS.retries + 1 }, () => "fake-script"), "fake-lite"]);
  expect(clock.slept).toHaveLength(NARRATION_LIMITS.retries);
  clock.slept.forEach((ms, index) => {
    expect(ms).toBeGreaterThanOrEqual(1000 * 2 ** index);
    expect(ms).toBeLessThanOrEqual(1000 * 2 ** index * 1.25);
  });
  expect((await read(await f.call(narration(record.id), "GET", undefined, owner))).narration?.status).toBe("ready");
});

test("a used-up daily quota is not retried: the script moves to the lighter model, and speech fails as quota_daily", async () => {
  const clock = waits();
  const { f, tts, idle } = setup(undefined, { retryDelayMs: 1000, sleep: clock.sleep });
  const owner = await f.login();
  const record = await research(f, owner);
  // Given: the script model's daily free quota is used up, and so is the speech model's.
  tts.scriptErrors = [new ProviderError("quota_daily", false)];
  tts.speakErrors = [new ProviderError("quota_daily", false)];
  await f.call(narration(record.id), "POST", {}, owner);
  await idle();
  // Then: no waits, the script came from the fallback, speech was tried once, and the failure says why.
  expect(clock.slept).toEqual([]);
  expect(tts.calls.models).toEqual(["fake-script", "fake-lite"]);
  expect(tts.calls.speak).toHaveLength(1);
  expect((await read(await f.call(narration(record.id), "GET", undefined, owner))).narration).toMatchObject({ status: "failed", error: "quota_daily", attempts: 1 });
});

test("a per-minute 429 waits as long as the provider asks, then keeps that pace between the chunks; a wait over a minute is not sat out", async () => {
  const clock = waits();
  const { f, tts, idle } = setup(undefined, { retryDelayMs: 1000, sleep: clock.sleep });
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

test("a failed TTS reuses the saved script, retries each chunk, and stops after the attempt limit", async () => {
  const { f, tts, idle } = setup();
  const owner = await f.login();
  const record = await research(f, owner);

  // A transient error is retried once inside the run.
  tts.failSpeak = 1;
  await f.call(narration(record.id), "POST", {}, owner);
  await idle();
  expect((await read(await f.call(narration(record.id), "GET", undefined, owner))).narration?.status).toBe("ready");
  expect(tts.calls.speak).toHaveLength(2);

  // Persistent failures count attempts; the script is written once per record and reused.
  const other = await research(f, owner);
  tts.failSpeak = "always";
  for (let attempt = 1; attempt <= NARRATION_LIMITS.attempts; attempt += 1) {
    expect((await f.call(narration(other.id), "POST", {}, owner)).status).toBe(202);
    await idle();
    expect((await read(await f.call(narration(other.id), "GET", undefined, owner))).narration).toMatchObject({ status: "failed", attempts: attempt, error: "http_500" });
  }
  expect(tts.calls.script).toBe(2);

  // An agent cannot start a fourth paid attempt; the owner can, by forcing it.
  const blocked = await f.call(narration(other.id), "POST", {}, bearer("omo"));
  expect(blocked.status).toBe(409);
  expect(await blocked.text()).toContain("narration_attempts_exhausted");
  tts.failSpeak = 0;
  expect((await f.call(narration(other.id), "POST", { force: true }, owner)).status).toBe(202);
  await idle();
  expect((await read(await f.call(narration(other.id), "GET", undefined, owner))).narration?.status).toBe("ready");
});

test("errors keep only a code: provider messages never reach the response", async () => {
  const { f, tts, idle } = setup();
  const owner = await f.login();
  const record = await research(f, owner);
  tts.error = new Error("leaked AIza-SECRET-KEY and script text");
  await f.call(narration(record.id), "POST", {}, owner);
  await idle();
  const response = await f.call(narration(record.id), "GET", undefined, owner);
  const text = await response.text();
  expect(text).not.toContain("SECRET");
  expect(NarrationStateSchema.parse(JSON.parse(text)).narration).toMatchObject({ status: "failed", error: "provider" });
});

test("narration access follows the record read scope; only the owner deletes", async () => {
  const { f, idle } = setup();
  const owner = await f.login();
  const record = await research(f, owner);
  const { Cookie, Origin } = owner;

  expect((await f.call(narration(record.id))).status).toBe(401);
  expect((await f.call(narration(record.id), "POST", {}, { Cookie, Origin })).status).toBe(403);
  expect((await f.call(narration(record.id), "POST", {}, {}, true)).status).toBe(404);

  // omo may narrate its own report and the owner's research it can read.
  const own = recordResult.parse(await (await f.call("/api/v1/records", "POST", payload(agentRecord()), bearer("omo"))).json()).record;
  expect((await f.call(narration(own.id), "POST", {}, bearer("omo"))).status).toBe(202);
  expect((await f.call(narration(record.id), "POST", {}, bearer("omo"))).status).toBe(202);
  await idle();
  const audio = (await read(await f.call(narration(own.id), "GET", undefined, bearer("omo")))).narration?.audio?.url ?? "";
  expect((await f.call(audio, "GET", undefined, bearer("omo"))).status).toBe(200);

  // codex cannot see omo's task; tasks are not narrated at all; agents cannot delete audio.
  const task = recordResult.parse(await (await f.call("/api/v1/records", "POST", payload({ kind: "task", title: "할 일", tags: ["테스트"] }), bearer("omo"))).json()).record;
  expect((await f.call(narration(task.id), "POST", {}, bearer("codex"))).status).toBe(404);
  const unsupported = await f.call(narration(task.id), "POST", {}, bearer("omo"));
  expect(unsupported.status).toBe(400);
  expect(await unsupported.text()).toContain("narration_unsupported");
  expect((await f.call(narration(own.id), "DELETE", undefined, bearer("omo"))).status).toBe(403);
});

test("no TTS key answers 503 and makes nothing", async () => {
  const { f, tts, audioFiles } = setup();
  const owner = await f.login();
  const record = await research(f, owner);
  tts.available = false;
  expect((await read(await f.call(narration(record.id), "GET", undefined, owner))).available).toBe(false);
  const refused = await f.call(narration(record.id), "POST", {}, owner);
  expect(refused.status).toBe(503);
  expect(await refused.text()).toContain("narration_unavailable");
  expect(tts.calls.script).toBe(0);
  expect(audioFiles()).toEqual([]);
});

test("the daily limit refuses further generations with 429", async () => {
  const { f, idle } = setup(1);
  const owner = await f.login();
  const first = await research(f, owner);
  const second = await research(f, owner);
  expect((await f.call(narration(first.id), "POST", {}, owner)).status).toBe(202);
  await idle();
  const refused = await f.call(narration(second.id), "POST", {}, owner);
  expect(refused.status).toBe(429);
  expect(await refused.text()).toContain("narration_daily_limit");
});

test("audio survives the trash and is removed with the record or on request", async () => {
  const { f, audioFiles, idle } = setup();
  const owner = await f.login();
  const record = await research(f, owner);
  await f.call(narration(record.id), "POST", {}, owner);
  await idle();

  // Owner delete of the narration removes the file and the state.
  expect((await f.call(narration(record.id), "DELETE", undefined, owner)).status).toBe(204);
  expect(audioFiles()).toEqual([]);
  expect((await read(await f.call(narration(record.id), "GET", undefined, owner))).narration).toBeNull();

  // Moving the record to the trash keeps the audio for a restore; deleting it for good removes it.
  await f.call(narration(record.id), "POST", {}, owner);
  await idle();
  const current = recordResult.parse(await (await f.call(`/api/v1/records/${record.id}`, "GET", undefined, owner)).json()).record;
  expect((await f.call(`/api/v1/records/${record.id}`, "DELETE", { expectedVersion: current.version }, owner)).status).toBe(204);
  expect(audioFiles()).toHaveLength(1);
  expect((await f.call(`/api/v1/trash/${record.id}/restore`, "POST", undefined, owner)).status).toBe(200);
  expect((await read(await f.call(narration(record.id), "GET", undefined, owner))).narration?.status).toBe("ready");
  const restored = recordResult.parse(await (await f.call(`/api/v1/records/${record.id}`, "GET", undefined, owner)).json()).record;
  await f.call(`/api/v1/records/${record.id}`, "DELETE", { expectedVersion: restored.version }, owner);
  expect((await f.call(`/api/v1/trash/${record.id}`, "DELETE", undefined, owner)).status).toBe(204);
  expect(audioFiles()).toEqual([]);
});

test("the listening script drops URLs and Markdown and splits into bounded chunks", () => {
  expect(normalizeScript("## 결론\n- **A** 앱이 [가장 싸다](https://a.example)\n```\ncode\n```\n원문: www.example.com/x")).toBe("결론\nA 앱이 가장 싸다\n\n원문:");
  const long = Array.from({ length: 40 }, (_, index) => `${index + 1}번째 문장은 비교 결과를 설명합니다.`).join(" ");
  const script = normalizeScript(`${long}\n\n${long}\n\n${"가".repeat(NARRATION_LIMITS.scriptChars)}`);
  expect(script.length).toBeLessThanOrEqual(NARRATION_LIMITS.scriptChars);
  const chunks = splitChunks(script);
  expect(chunks.every(chunk => chunk.length > 0 && chunk.length <= NARRATION_LIMITS.chunkChars)).toBe(true);
  expect(chunks.join("").replace(/\s/g, "")).toBe(script.replace(/\s/g, ""));
});

test("the owner narrates a digest's articles; its audio lives under the digest, survives pruning and goes stale when articles are added", async () => {
  const { f, tts, idle } = setup();
  const owner = await f.login();
  const upload = (sections: unknown[]) => f.call("/api/v1/digests", "POST", { date: "2026-10-01", slot: "morning", notify: false, sections }, bearer("omo"));
  const created = await upload([{ key: "domestic", title: "Domestic", kind: "articles", items: [{ key: "a", title: "국내 소식", source: "연합뉴스", summary: "요약", url: "https://news.example.com/a" }] }]);
  const id = (await created.json() as { digest: { id: string } }).digest.id;
  const path = `/api/v1/digests/${id}/narration`;
  // When: the owner asks for the digest's narration.
  expect((await f.call(path, "POST", {}, owner)).status).toBe(202);
  await idle();
  f.app.purgeTrash();
  // Then: it is ready, made from the digest's articles, with audio under the digest's path.
  const state = await read(await f.call(path, "GET", undefined, owner));
  expect(state.narration).toMatchObject({ status: "ready", stale: false });
  expect(state.narration?.audio?.url).toStartWith(`${path}/audio?v=`);
  expect((await f.call(state.narration?.audio?.url ?? "", "GET", undefined, owner)).status).toBe(200);
  expect(tts.calls.script).toBe(1);
  expect(tts.calls.prompts[0]).toContain("국내 소식");
  // When: messages arrive later the articles audio stays current; more articles make it stale. Agents and unknown digests get no narration.
  await upload([{ key: "inbox", title: "Inbox", kind: "messages", items: [{ key: "m", importance: "check", from: "Carrier", subject: "접속 알림" }] }]);
  expect((await read(await f.call(path, "GET", undefined, owner))).narration?.stale).toBe(false);
  await upload([{ key: "ai", title: "AI", kind: "articles", items: [{ key: "z", title: "AI 소식", source: "Blog", summary: "요약", url: "https://news.example.com/z" }] }]);
  expect((await read(await f.call(path, "GET", undefined, owner))).narration?.stale).toBe(true);
  expect((await f.call(path, "GET", undefined, bearer("omo"))).status).toBe(403);
  expect((await f.call(`/api/v1/digests/${crypto.randomUUID()}/narration`, "GET", undefined, owner)).status).toBe(404);
});

test("the owner narrates a digest's messages on their own: the messages part has its own id, script and audio", async () => {
  const { f, tts, idle } = setup();
  const owner = await f.login();
  const created = await f.call("/api/v1/digests", "POST", { date: "2026-10-01", slot: "morning", notify: false, sections: [
    { key: "domestic", title: "Domestic", kind: "articles", items: [{ key: "a", title: "국내 소식", source: "연합뉴스", summary: "요약", url: "https://news.example.com/a" }] },
    { key: "inbox", title: "Inbox", kind: "messages", items: [{ key: "m", importance: "urgent", from: "Carrier", subject: "접속 알림" }] }] }, bearer("omo"));
  const id = (await created.json() as { digest: { id: string } }).digest.id;
  const mailId = digestPartId(id, "messages");
  expect(mailId).not.toBe(id);
  expect(digestPartId(id, "articles")).toBe(id);
  const path = `/api/v1/digests/${mailId}/narration`;
  // When: the owner asks for the messages' narration.
  expect((await f.call(path, "POST", {}, owner)).status).toBe(202);
  await idle();
  f.app.purgeTrash();
  // Then: it is made from the messages alone, labelled as digest messages, and its audio lives under the messages part's path.
  expect(tts.calls.prompts[0]).toContain("접속 알림");
  expect(tts.calls.prompts[0]).toContain("Digest messages");
  expect(tts.calls.prompts[0]).not.toContain("국내 소식");
  const state = await read(await f.call(path, "GET", undefined, owner));
  expect(state.narration).toMatchObject({ recordId: mailId, status: "ready", stale: false });
  expect(state.narration?.audio?.url).toStartWith(`${path}/audio?v=`);
  expect((await f.call(state.narration?.audio?.url ?? "", "GET", undefined, owner)).status).toBe(200);
  // And: the articles have no narration yet, and a digest without messages has no messages part.
  expect((await read(await f.call(`/api/v1/digests/${id}/narration`, "GET", undefined, owner))).narration).toBeNull();
  const evening = await f.call("/api/v1/digests", "POST", { date: "2026-10-01", slot: "evening", notify: false, sections: [
    { key: "domestic", title: "Domestic", kind: "articles", items: [{ key: "e", title: "저녁 소식", source: "", summary: "", url: "https://news.example.com/e" }] }] }, bearer("omo"));
  const eveningId = (await evening.json() as { digest: { id: string } }).digest.id;
  expect((await f.call(`/api/v1/digests/${digestPartId(eveningId, "messages")}/narration`, "GET", undefined, owner)).status).toBe(404);
});

test("the owner narrates a whole digest at once, articles then messages, under its own id beside the separate parts", async () => {
  const { f, tts, idle } = setup();
  const owner = await f.login();
  const upload = (sections: unknown[]) => f.call("/api/v1/digests", "POST", { date: "2026-10-01", slot: "morning", notify: false, sections }, bearer("omo"));
  const created = await upload([
    { key: "domestic", title: "Domestic", kind: "articles", items: [{ key: "a", title: "Local news", source: "Wire", summary: "Summary", url: "https://news.example.com/a" }] },
    { key: "inbox", title: "Inbox", kind: "messages", items: [{ key: "m", importance: "urgent", from: "Carrier", subject: "Sign-in alert" }] }]);
  const id = (await created.json() as { digest: { id: string } }).digest.id;
  const allId = digestPartId(id, "all");
  // The whole digest has an id of its own that maps back, distinct from both parts.
  expect(new Set([allId, id, digestPartId(id, "messages")]).size).toBe(3);
  expect(digestOfPartId(allId)).toEqual({ id, part: "all" });
  const path = `/api/v1/digests/${allId}/narration`;
  // When: the owner asks for the whole digest.
  expect((await f.call(path, "POST", {}, owner)).status).toBe(202);
  await idle();
  // Then: one script covers the articles, then the messages.
  const prompt = tts.calls.prompts[0] ?? "";
  expect(prompt).toContain("Whole digest");
  expect(prompt.indexOf("Local news")).toBeGreaterThan(-1);
  expect(prompt.indexOf("Sign-in alert")).toBeGreaterThan(prompt.indexOf("Local news"));
  const state = await read(await f.call(path, "GET", undefined, owner));
  expect(state.narration).toMatchObject({ recordId: allId, status: "ready", stale: false });
  expect(state.narration?.audio?.url).toStartWith(`${path}/audio?v=`);
  expect((await f.call(state.narration?.audio?.url ?? "", "GET", undefined, owner)).status).toBe(200);
  // And: the parts keep their own (still empty) narrations, and new messages make the whole audio stale.
  expect((await read(await f.call(`/api/v1/digests/${id}/narration`, "GET", undefined, owner))).narration).toBeNull();
  await upload([{ key: "inbox", title: "Inbox", kind: "messages", items: [{ key: "n", importance: "todo", from: "Bank", subject: "Deposit notice" }] }]);
  expect((await read(await f.call(path, "GET", undefined, owner))).narration?.stale).toBe(true);
  expect((await f.call(path, "POST", { style: "podcast" }, owner)).status).toBe(400);
});

const DIALOGUE = "A: Today we look at the app price comparison.\n\nB: Shall we start with the conclusion?\n\nA: The cheapest is app A.\nIt costs five dollars a month.";

test("a podcast narration writes a two-host script, speaks it as dialogue turns and becomes the default for the next request", async () => {
  const { f, tts, idle } = setup();
  const owner = await f.login();
  const record = await research(f, owner);
  tts.scriptText = DIALOGUE;

  // When: the owner picks Podcast.
  const queued = await f.call(narration(record.id), "POST", { style: "podcast" }, owner);
  expect(queued.status).toBe(202);
  expect((await read(queued)).narration?.style).toBe("podcast");
  await idle();

  // Then: the script was asked for as a dialogue and reached the provider as A/B turns with both hosts, not read by one voice.
  expect(tts.calls.systems).toEqual([PODCAST_SCRIPT_SYSTEM]);
  expect(tts.calls.speak).toEqual([]);
  expect(tts.calls.converse).toEqual([[
    { speaker: "A", text: "Today we look at the app price comparison." },
    { speaker: "B", text: "Shall we start with the conclusion?" },
    { speaker: "A", text: "The cheapest is app A.\nIt costs five dollars a month." },
  ]]);
  const ready = await read(await f.call(narration(record.id), "GET", undefined, owner));
  expect(ready.narration).toMatchObject({ status: "ready", style: "podcast", stale: false });
  expect(ready.narration?.audio).toMatchObject({ style: "podcast", voice: "Kore, Puck" });

  // And: a request without a style keeps Podcast and, for unchanged content, makes nothing new.
  const again = await f.call(narration(record.id), "POST", {}, owner);
  expect(again.status).toBe(200);
  expect((await read(again)).narration?.style).toBe("podcast");
  expect(tts.calls.script).toBe(1);

  // And: switching to Read aloud makes a new read script and audio, which then becomes the default.
  tts.scriptText = SCRIPT;
  expect((await f.call(narration(record.id), "POST", { style: "read" }, owner)).status).toBe(202);
  await idle();
  expect(tts.calls.systems).toEqual([PODCAST_SCRIPT_SYSTEM, SCRIPT_SYSTEM]);
  expect(tts.calls.speak).toHaveLength(1);
  const read2 = await read(await f.call(narration(record.id), "GET", undefined, owner));
  expect(read2.narration).toMatchObject({ status: "ready", style: "read" });
  expect(read2.narration?.audio).toMatchObject({ style: "read", voice: "Kore" });
  expect((await f.call(narration(record.id), "POST", {}, owner)).status).toBe(200);
});

test("cancelling a podcast over earlier read audio keeps Read aloud as the default", async () => {
  const { f, tts, idle } = setup();
  const owner = await f.login();
  const record = await research(f, owner);
  await f.call(narration(record.id), "POST", {}, owner);
  await idle();
  tts.scriptText = DIALOGUE;
  // Given: a podcast is being spoken over the earlier read audio.
  const gate = hold(tts);
  const started = await read(await f.call(narration(record.id), "POST", { style: "podcast" }, owner));
  expect(started.narration?.style).toBe("podcast");
  await gate.entered.promise;
  // When: the owner cancels it.
  const cancelled = await read(await f.call(`${narration(record.id)}/cancel`, "POST", {}, owner));
  await idle();
  // Then: the earlier read audio is ready and Read aloud stays the default.
  expect(tts.calls.converse).toHaveLength(1);
  expect(cancelled.narration).toMatchObject({ status: "ready", style: "read" });
  expect(cancelled.narration?.audio?.style).toBe("read");
});

test("digests are always read aloud: a podcast request is refused, and an unknown style is invalid", async () => {
  const { f, tts, idle } = setup();
  const owner = await f.login();
  const created = await f.call("/api/v1/digests", "POST", { date: "2026-10-01", slot: "morning", notify: false, sections: [
    { key: "domestic", title: "Domestic", kind: "articles", items: [{ key: "a", title: "Local news", source: "Wire", summary: "Summary", url: "https://news.example.com/a" }] }] }, bearer("omo"));
  const id = (await created.json() as { digest: { id: string } }).digest.id;
  const path = `/api/v1/digests/${id}/narration`;
  const refused = await f.call(path, "POST", { style: "podcast" }, owner);
  expect(refused.status).toBe(400);
  expect(await refused.text()).toContain("narration_style_unsupported");
  expect(tts.calls.script).toBe(0);
  expect((await f.call(path, "POST", { style: "read" }, owner)).status).toBe(202);
  await idle();
  expect((await read(await f.call(path, "GET", undefined, owner))).narration).toMatchObject({ status: "ready", style: "read" });
  expect(tts.calls.converse).toEqual([]);
  const record = await research(f, owner);
  expect((await f.call(narration(record.id), "POST", { style: "radio" }, owner)).status).toBe(400);
  // An agent may choose the style too.
  expect((await f.call(narration(record.id), "POST", { style: "podcast" }, bearer("omo"))).status).toBe(202);
});

test("a dialogue script becomes speaker turns packed into bounded chunks", () => {
  // Unlabelled lines continue the previous speaker (A at the start); full-width colons and spaces are accepted.
  expect(dialogueChunks("Opening\n\nB： A question?\n\nA line that carries on\n\nA:An answer.")).toEqual([[
    { speaker: "A", text: "Opening" }, { speaker: "B", text: "A question?\n\nA line that carries on" }, { speaker: "A", text: "An answer." },
  ]]);
  const long = Array.from({ length: 12 }, (_, index) => `${index % 2 ? "B" : "A"}: ${"This is a sentence. ".repeat(25)}`).join("\n\n");
  const chunks = dialogueChunks(normalizeScript(long));
  expect(chunks.length).toBeGreaterThan(1);
  for (const chunk of chunks) expect(chunk.reduce((sum, turn) => sum + turn.text.length, 0)).toBeLessThanOrEqual(NARRATION_LIMITS.chunkChars);
  expect(chunks.flat().every(turn => turn.text.length > 0 && !/^[AB]\s*[:：]/.test(turn.text))).toBe(true);
});
