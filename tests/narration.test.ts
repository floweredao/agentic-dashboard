import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { digestOfPartId, digestPartId, NARRATION_LIMITS, NarrationStateSchema, NarrationVoiceSettingsSchema } from "../shared/contracts";
import { DIGEST_SCRIPT_SYSTEM, dialogueChunks, KOREAN_POLITE, listeningSource, missingFigures, normalizeScript, oneSidedTone, plainSentences, PODCAST_SCRIPT_SYSTEM, PODCAST_STYLE, ProviderError, SCRIPT_SYSTEM, SPEECH_STYLE, scriptParts, splitChunks } from "../server/narration";
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
  provider: NarrationProvider; calls: { script: number; speak: string[]; prompts: string[]; systems: string[]; converse: SpeechTurn[][]; models: string[];
    /** The voice and style of each speak call, and the hosts and style of each converse call. */
    voices: string[]; styles: string[]; hosts: string[][] }; available: boolean;
  failSpeak: number | "always"; error: Error | null; scriptText: string; hold: Hold | null;
  /** Holds the script call after half its text has streamed in, until `release`. */
  scriptHold: Hold | null;
  /** Returned, one per call and in order, before `scriptText`. */
  scriptTexts: string[];
  /** Thrown, one per call and in order, by the next script and speak calls. */
  scriptErrors: ProviderError[]; speakErrors: ProviderError[];
};

/** A TTS provider that returns one second of silence per chunk and records what it was asked. */
function fake(): Fake {
  const state: Fake = { calls: { script: 0, speak: [], prompts: [], systems: [], converse: [], models: [], voices: [], styles: [], hosts: [] }, available: true, failSpeak: 0, error: null, scriptText: SCRIPT,
    hold: null, scriptHold: null, scriptErrors: [], speakErrors: [], scriptTexts: [], provider: null as never };
  state.provider = {
    ttsModel: "fake-tts", scriptModel: "fake-script", fallbackScriptModel: "fake-lite", voice: "Kore", hosts: ["Kore", "Puck"],
    available: async () => state.available,
    script: async (system, prompt, signal, model, onText) => {
      state.calls.models.push(model ?? "fake-script");
      const failure = state.scriptErrors.shift();
      if (failure) throw failure;
      state.calls.script += 1; state.calls.prompts.push(prompt); state.calls.systems.push(system);
      const text = state.scriptTexts.shift() ?? state.scriptText;
      const hold = state.scriptHold;
      if (hold) {
        onText?.(Math.floor(text.length / 2));
        hold.entered.resolve(signal);
        await hold.release.promise;
      }
      onText?.(text.length);
      return text;
    },
    converse: async (turns, style, signal, hosts) => {
      state.calls.converse.push([...turns]);
      state.calls.styles.push(style); state.calls.hosts.push([...(hosts ?? ["Kore", "Puck"])]);
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
    speak: async (text, style, signal, voice) => {
      state.calls.speak.push(text);
      state.calls.styles.push(style); state.calls.voices.push(voice ?? "Kore");
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
/** The instructions a Korean record is written with: the base ones plus the Korean polite-speech rule. */
const korean = (system: string) => `${system}\n${KOREAN_POLITE}`;
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

test("while the script streams in, the job reports the characters received against the expected length and when the step began", async () => {
  const { f, tts, idle } = setup();
  const owner = await f.login();
  const record = await research(f, owner);
  tts.scriptText = TWO_CHUNKS;
  const gate = (tts.scriptHold = { entered: deferred<AbortSignal>(), release: deferred<void>() });
  // Given: half of the script has streamed in.
  expect((await f.call(narration(record.id), "POST", {}, owner)).status).toBe(202);
  await gate.entered.promise;

  // When: the dashboard asks how far the job is.
  const during = (await read(await f.call(narration(record.id), "GET", undefined, owner))).narration;

  // Then: it reports the characters received over the expected length, and when writing the script began.
  expect(during).toMatchObject({ status: "scripting", progress: { done: Math.floor(TWO_CHUNKS.length / 2) } });
  expect(during?.progress?.total).toBeGreaterThan(0);
  expect(Date.parse(during?.stepAt ?? "")).toBeLessThanOrEqual(Date.now());
  gate.release.resolve();
  await idle();
  expect((await read(await f.call(narration(record.id), "GET", undefined, owner))).narration).toMatchObject({ status: "ready", progress: null, stepAt: null });
});

test("while speaking, the step began when the chunk being made started", async () => {
  const { f, tts, idle } = setup();
  const owner = await f.login();
  const record = await research(f, owner);
  tts.scriptText = TWO_CHUNKS;
  const gate = hold(tts);
  expect((await f.call(narration(record.id), "POST", {}, owner)).status).toBe(202);
  await gate.entered.promise;
  const speaking = (await read(await f.call(narration(record.id), "GET", undefined, owner))).narration;
  expect(speaking).toMatchObject({ status: "speaking", progress: { done: 0, total: 2 } });
  expect(speaking?.stepAt).toBeString();
  gate.release.resolve();
  await idle();
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
  // The lighter model gets the same instructions (polite speech, order, what not to read).
  expect(tts.calls.systems).toEqual([korean(SCRIPT_SYSTEM)]);
  expect(clock.slept).toHaveLength(NARRATION_LIMITS.retries);
  clock.slept.forEach((ms, index) => {
    expect(ms).toBeGreaterThanOrEqual(1000 * 2 ** index);
    expect(ms).toBeLessThanOrEqual(1000 * 2 ** index * 1.25);
  });
  expect((await read(await f.call(narration(record.id), "GET", undefined, owner))).narration?.status).toBe("ready");
});

for (const code of ["stalled", "timeout"]) test(`a script model that ${code === "stalled" ? "stalls" : "times out"} is not retried: the lighter model writes the script at once`, async () => {
  const clock = waits();
  const { f, tts, idle } = setup(undefined, { retryDelayMs: 1000, sleep: clock.sleep });
  const owner = await f.login();
  const record = await research(f, owner);
  // Given: the main script model hangs (2026-10-07: no answer for minutes, retried 4 times before the fallback).
  tts.scriptErrors = [new ProviderError(code, true)];
  await f.call(narration(record.id), "POST", {}, owner);
  await idle();
  // Then: no waits and no further tries of the stuck model; the lighter one wrote the script and the audio is ready.
  expect(clock.slept).toEqual([]);
  expect(tts.calls.models).toEqual(["fake-script", "fake-lite"]);
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

test("while a retry waits, the narration says until when, and the wait clears once the call goes through", async () => {
  const gate = deferred<void>();
  const entered = deferred<number>();
  const { f, tts, idle } = setup(undefined, { sleep: async (ms: number) => { entered.resolve(ms); await gate.promise; } });
  const owner = await f.login();
  const record = await research(f, owner);
  // Given: the first chunk is rate limited and the provider asks for 7 seconds.
  tts.speakErrors = [Object.assign(new ProviderError("http_429", true), { retryAfterMs: 7000 })];
  await f.call(narration(record.id), "POST", {}, owner);
  expect(await entered.promise).toBe(7000);
  // Then: during the wait the state names the moment the next try starts.
  const waiting = (await read(await f.call(narration(record.id), "GET", undefined, owner))).narration;
  expect(waiting?.status).toBe("speaking");
  const until = Date.parse(waiting?.waitUntil ?? "");
  expect(until - Date.now()).toBeGreaterThan(5000);
  expect(until - Date.now()).toBeLessThanOrEqual(7000);
  // When: the wait ends, the job finishes and no wait is reported.
  gate.resolve();
  await idle();
  expect((await read(await f.call(narration(record.id), "GET", undefined, owner))).narration).toMatchObject({ status: "ready", waitUntil: null });
});

test("a digest is written with the digest instructions (a one- or two-sentence opening, every item), a record with the record ones", async () => {
  const { f, tts, idle } = setup();
  const owner = await f.login();
  const created = await f.call("/api/v1/digests", "POST", { date: "2026-10-02", slot: "evening", notify: false, sections: [
    { key: "domestic", title: "Domestic", kind: "articles", items: [{ key: "a", title: "Local news", source: "Wire", summary: "Summary", url: "https://news.example.com/a" }] }] }, bearer("omo"));
  const id = (await created.json() as { digest: { id: string } }).digest.id;
  await f.call(`/api/v1/digests/${id}/narration`, "POST", {}, owner);
  await f.call(narration((await research(f, owner)).id), "POST", {}, owner);
  await idle();
  expect(tts.calls.systems).toEqual([DIGEST_SCRIPT_SYSTEM, korean(SCRIPT_SYSTEM)]);
  expect(DIGEST_SCRIPT_SYSTEM).toContain("one or two sentences");
  expect(tts.calls.prompts[0]).toContain("2026-10-02 evening");
  expect(tts.calls.prompts[0]).toContain("Domestic 1");
});

test("plain (반말) Korean sentence endings are found; 해요체, 습니다체 and lines without an ending are not", () => {
  expect(plainSentences("10월 2일 아침 다이제스트다. 국내 1건이에요.\n\n메일이 왔다! 확인했나요? 확인했습니다.\n\nB: 좋죠. A: 그런가?\n\n국내 소식"))
    .toEqual(["10월 2일 아침 다이제스트다.", "메일이 왔다!", "그런가?"]);
  expect(plainSentences("This is a plain English sentence. Is it?")).toEqual([]);
});

test("a Korean script mixing 해요체 and 습니다체 has no plain sentence and costs one script call", async () => {
  const mixed = "10월 2일 저녁 다이제스트예요. 국내 2건, 해외 1건입니다.\n\n서울시가 지하철을 하루 40회 늘린다고 밝혔습니다. 한국은행은 기준금리를 연 2.5퍼센트로 유지했습니다.\n\n"
    + "해외 소식이에요. 엔화 약세가 이어지고 있습니다. 메시지도 하나 있어요! 서류를 준비하시면 됩니다. 확인하셨나요? 그렇죠. 맞습니까?";
  expect(plainSentences(mixed)).toEqual([]);
  const { f, tts, idle } = setup();
  const owner = await f.login();
  tts.scriptText = mixed;
  const record = await research(f, owner);
  await f.call(narration(record.id), "POST", {}, owner);
  await idle();
  expect(tts.calls.script).toBe(1);
  expect(tts.calls.systems).toEqual([korean(SCRIPT_SYSTEM)]);
  expect((await read(await f.call(narration(record.id), "GET", undefined, owner))).narration).toMatchObject({ status: "ready", script: mixed });
});

const HAEYO_ONLY = "10월 3일 저녁 다이제스트이에요. 국내 2건이에요.\n\n서울시가 지하철을 늘린다고 밝혔어요. 한국은행은 금리를 유지했어요.\n\n해외 소식이에요. 엔화 약세가 이어지고 있어요.";
const HAMNIDA_ONLY = "10월 3일 저녁 다이제스트입니다. 국내 2건입니다.\n\n서울시가 지하철을 늘린다고 밝혔습니다. 한국은행은 금리를 유지했습니다.\n\n해외 소식입니다. 엔화 약세가 이어지고 있습니다.";

test("a script of six or more polite sentences with under a fifth in 습니다체 or in 해요체 is one-sided; a mixed or short one is not", () => {
  expect(oneSidedTone(HAEYO_ONLY)).toBe("haeyo");
  expect(oneSidedTone(HAMNIDA_ONLY)).toBe("hamnida");
  // Only the count sentence in 습니다체 among nine others in 해요체.
  expect(oneSidedTone(`${HAEYO_ONLY} 국내 3건입니다. 메일이 왔어요. 확인하셨나요? 그렇죠.`)).toBe("haeyo");
  expect(oneSidedTone("A: 오늘은 금리 이야기예요. 한국은행이 금리를 동결했습니다.\n\nB: 왜 동결했죠? A: 물가가 아직 높습니다. B: 그렇군요. A: 다음 회의는 11월입니다.")).toBeNull();
  expect(oneSidedTone("다이제스트이에요. 국내 1건이에요. 서울 소식이에요. 날씨가 맑아요. 끝이에요.")).toBeNull();
});

test("a one-sided script is written once more with a reminder for the missing tone; a mixed one costs one call", async () => {
  const { f, tts, idle } = setup();
  const owner = await f.login();
  const mixed = "10월 3일 저녁 다이제스트이에요. 국내 2건입니다.\n\n서울시가 지하철을 늘린다고 밝혔습니다. 출근길이 조금 나아질 것 같아요.\n\n해외 소식이에요. 엔화 약세가 이어지고 있습니다.";
  expect(oneSidedTone(mixed)).toBeNull();
  // Given: the model first answers in 해요체 only, then mixes both.
  tts.scriptTexts = [HAEYO_ONLY, mixed];
  const first = await research(f, owner);
  await f.call(narration(first.id), "POST", {}, owner);
  await idle();
  // Then: a second call carries the same instructions plus a reminder, and the mixed script is kept.
  expect(tts.calls.script).toBe(2);
  expect(tts.calls.systems[1]?.startsWith(korean(SCRIPT_SYSTEM))).toBe(true);
  const haeyoReminder = tts.calls.systems[1]?.slice(korean(SCRIPT_SYSTEM).length) ?? "";
  expect(haeyoReminder.trim().length).toBeGreaterThan(0);
  expect((await read(await f.call(narration(first.id), "GET", undefined, owner))).narration?.script).toBe(mixed);
  // And: a 습니다체-only script is written again with a different reminder; a second one-sided script is kept rather than paid for again.
  tts.scriptTexts = [HAMNIDA_ONLY, HAMNIDA_ONLY];
  const second = await research(f, owner);
  await f.call(narration(second.id), "POST", {}, owner);
  await idle();
  expect(tts.calls.script).toBe(4);
  const hamnidaReminder = tts.calls.systems[3]?.slice(korean(SCRIPT_SYSTEM).length) ?? "";
  expect(hamnidaReminder.trim().length).toBeGreaterThan(0);
  expect(hamnidaReminder).not.toBe(haeyoReminder);
  expect((await read(await f.call(narration(second.id), "GET", undefined, owner))).narration).toMatchObject({ status: "ready", script: HAMNIDA_ONLY });
  // And: a mixed script costs one call.
  tts.scriptTexts = [mixed];
  await f.call(narration((await research(f, owner)).id), "POST", {}, owner);
  await idle();
  expect(tts.calls.script).toBe(5);
});

test("a Korean script with 반말 endings is written once more with a polite-speech reminder; the second script is used even if it slips again", async () => {
  const { f, tts, idle } = setup();
  const owner = await f.login();
  // Given: the model first answers with plain endings, then politely.
  tts.scriptTexts = ["시험 기록이다.\n\n결론은 A가 싸다.", "시험 기록이에요.\n\n결론은 A가 쌉니다."];
  const record = await research(f, owner);
  await f.call(narration(record.id), "POST", {}, owner);
  await idle();
  // Then: a second script call carries the same instructions plus the reminder, and its script is kept.
  expect(tts.calls.script).toBe(2);
  expect(tts.calls.systems[0]).toBe(korean(SCRIPT_SYSTEM));
  expect(tts.calls.systems[1]?.startsWith(korean(SCRIPT_SYSTEM))).toBe(true);
  expect(tts.calls.systems[1]?.length).toBeGreaterThan(korean(SCRIPT_SYSTEM).length);
  expect((await read(await f.call(narration(record.id), "GET", undefined, owner))).narration?.script).toBe("시험 기록이에요.\n\n결론은 A가 쌉니다.");
  // And: a second slip is used rather than failing or paying again.
  tts.scriptTexts = ["반말이다.", "또 반말이다."];
  const twice = await research(f, owner);
  await f.call(narration(twice.id), "POST", {}, owner);
  await idle();
  expect(tts.calls.script).toBe(4);
  expect((await read(await f.call(narration(twice.id), "GET", undefined, owner))).narration).toMatchObject({ status: "ready", script: "또 반말이다." });
});

test("an English record gets no Korean rule and is never asked twice", async () => {
  const { f, tts, idle } = setup();
  const owner = await f.login();
  const created = await f.call("/api/v1/records", "POST", { requestId: crypto.randomUUID(), record: {
    kind: "research", title: "Price comparison", body: "App A is the cheapest at five dollars a month.", fields: { summary: "Summary", conclusion: "Pick app A" },
  } }, owner);
  const record = recordResult.parse(await created.json()).record;
  tts.scriptText = "This is the comparison. App A is cheapest.";
  await f.call(narration(record.id), "POST", {}, owner);
  await idle();
  expect(tts.calls.systems).toEqual([SCRIPT_SYSTEM]);
  expect(tts.calls.script).toBe(1);
});

/** The middle sentence carries the time, and the first script reads only the first and last. */
const KYIV = { key: "k", title: "러 드론, 키이우 남부교 타격", source: "예시뉴스", url: "https://news.example.com/k",
  summary: "러시아군이 키이우 남부교를 이틀 사이 4번 공격했다. 키이우 시장은 오후 5시 40분께 네 번째 타격이 있었다고 밝혔다. 시내 교통 혼잡이 커졌다." };
const KYIV_SHORT = "10월 4일 아침 다이제스트예요. 국내 1건입니다.\n\n러시아군이 키이우 남부교를 이틀 사이 4번 공격했습니다. 시내 교통 혼잡이 커졌어요.";
const KYIV_FULL = "10월 4일 아침 다이제스트예요. 국내 1건입니다.\n\n러시아군이 키이우 남부교를 이틀 사이 4번 공격했습니다. 네 번째 타격은 오후 5시 40분께였습니다. 시내 교통 혼잡이 커졌어요.";

test("the article numbers a digest script never says are found, as digits or as read; messages and model names are not checked", () => {
  const body = `## 국내\n- ${KYIV.title} (${KYIV.source}): ${KYIV.summary}\n- G7 합의 (예시뉴스): G7이 5곳에 1억 배럴을 풀기로 했다.\n\n## 메일\n- [info] 예시은행: 거래내역. 생년월일 6자리로 엽니다.`;
  expect(missingFigures(body, `${KYIV_SHORT} G7이 다섯 곳에 일억 배럴을 풀기로 했습니다.`)).toEqual([{ title: KYIV.title, figures: ["5시", "40분"] }]);
  expect(missingFigures(body, `${KYIV_FULL} G7이 5곳에 1억 배럴을 풀기로 했습니다.`)).toEqual([]);
});

test("a Korean digest script that drops a summary's middle sentence is written once more naming what it lost; a full one costs one call", async () => {
  const { f, tts, idle } = setup();
  const owner = await f.login();
  const digest = async (date: string) => {
    const created = await f.call("/api/v1/digests", "POST", { date, slot: "morning", notify: false,
      sections: [{ key: "domestic", title: "국내", kind: "articles", items: [KYIV] }] }, bearer("omo"));
    return (await created.json() as { digest: { id: string } }).digest.id;
  };
  // Given: the model first reads the first and last sentences only, then the whole summary.
  tts.scriptTexts = [KYIV_SHORT, KYIV_FULL];
  const first = await digest("2026-10-04");
  await f.call(`/api/v1/digests/${first}/narration`, "POST", {}, owner);
  await idle();
  // Then: the second call carries the digest instructions plus the item and the time it lost, and its script is kept.
  expect(tts.calls.script).toBe(2);
  expect(tts.calls.systems[1]?.startsWith(korean(DIGEST_SCRIPT_SYSTEM))).toBe(true);
  expect(tts.calls.systems[1]?.slice(korean(DIGEST_SCRIPT_SYSTEM).length)).toContain(`'${KYIV.title}'의 5시, 40분`);
  expect((await read(await f.call(`/api/v1/digests/${first}/narration`, "GET", undefined, owner))).narration?.script).toBe(KYIV_FULL);
  // And: a script with every fact costs one call.
  tts.scriptTexts = [KYIV_FULL];
  await f.call(`/api/v1/digests/${await digest("2026-10-05")}/narration`, "POST", {}, owner);
  await idle();
  expect(tts.calls.script).toBe(3);
});

test("what is spoken reads each number by its unit, while the saved script keeps the digits", async () => {
  const { f, tts, idle } = setup();
  const owner = await f.login();
  tts.scriptText = "올해 5곳의 전셋값이 10% 넘게 올랐습니다. 다음 발표는 6월 3일 오후 12시예요.";
  const record = await research(f, owner);
  await f.call(narration(record.id), "POST", {}, owner);
  await idle();
  expect(tts.calls.speak).toEqual(["올해 다섯 곳의 전셋값이 십 퍼센트 넘게 올랐습니다. 다음 발표는 유월 삼 일 오후 열두 시예요."]);
  expect((await read(await f.call(narration(record.id), "GET", undefined, owner))).narration?.script).toBe(tts.scriptText);
  // And: a podcast turn is read the same way.
  tts.scriptText = "A: 후보는 3곳입니다.\n\nB: 2명이 골랐죠?";
  const podcast = await research(f, owner);
  await f.call(narration(podcast.id), "POST", { style: "podcast" }, owner);
  await idle();
  expect(tts.calls.converse.at(-1)).toEqual([{ speaker: "A", text: "후보는 세 곳입니다." }, { speaker: "B", text: "두 명이 골랐죠?" }]);
});

test("a digest script may run past a record's cap up to the digest cap", () => {
  const long = Array.from({ length: 80 }, (_, index) => `${index}번 항목의 사실을 빠짐없이 전합니다. ${"가".repeat(90)}.`).join("\n\n");
  expect(normalizeScript(long).length).toBeLessThanOrEqual(NARRATION_LIMITS.scriptChars);
  const digest = normalizeScript(long, NARRATION_LIMITS.digestScriptChars);
  expect(digest.length).toBeGreaterThan(NARRATION_LIMITS.scriptChars);
  expect(digest.length).toBeLessThanOrEqual(NARRATION_LIMITS.digestScriptChars);
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

test("deleting one narration removes only that record's audio file and row", async () => {
  const { f, audioFiles, idle } = setup();
  const owner = await f.login();
  const kept = await research(f, owner);
  const deleted = await research(f, owner);
  await f.call(narration(kept.id), "POST", {}, owner);
  await idle();
  await f.call(narration(deleted.id), "POST", {}, owner);
  await idle();
  const keptFile = (await read(await f.call(narration(kept.id), "GET", undefined, owner))).narration?.audio?.url ?? "";
  expect(audioFiles()).toHaveLength(2);

  expect((await f.call(narration(deleted.id), "DELETE", undefined, owner)).status).toBe(204);

  // The other record keeps its ready narration and its one file, which still plays; the deleted one is gone and can be made again.
  expect(audioFiles()).toHaveLength(1);
  expect(audioFiles()[0]?.startsWith(kept.id)).toBe(true);
  const after = await read(await f.call(narration(kept.id), "GET", undefined, owner));
  expect(after.narration?.status).toBe("ready");
  expect((await f.call(keptFile, "GET", undefined, owner)).status).toBe(200);
  expect((await read(await f.call(narration(deleted.id), "GET", undefined, owner))).narration).toBeNull();
  expect((await f.call(narration(deleted.id), "POST", {}, owner)).status).toBe(202);
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
  expect(tts.calls.systems).toEqual([korean(PODCAST_SCRIPT_SYSTEM)]);
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
  expect(tts.calls.systems).toEqual([korean(PODCAST_SCRIPT_SYSTEM), korean(SCRIPT_SYSTEM)]);
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

const SOURCES_BODY = [
  "## 배경", "본문 첫 문단입니다.", "", "```ts", "const secret = 1;", "```", "",
  "| 항목 | 값 |", "|---|---|", "| A | 1 |", "", "## 관찰", "관찰 문단입니다.", "- [링크만 있는 줄](https://example.com/a)", "",
  "## 출처", "- 예시뉴스 기사 https://news.example.com/a", "- 논문 원문", "", "## 다음", "마지막 문단입니다.",
].join("\n");

test("the listening source leaves out code, tables, link-only lines and the source list, and keeps every prose section", () => {
  const source = listeningSource(SOURCES_BODY);
  for (const kept of ["## 배경", "본문 첫 문단입니다.", "## 관찰", "관찰 문단입니다.", "## 다음", "마지막 문단입니다."]) expect(source).toContain(kept);
  for (const dropped of ["secret", "| A | 1 |", "링크만", "## 출처", "예시뉴스 기사", "논문 원문"]) expect(source).not.toContain(dropped);
  expect(listeningSource("## References\n- a\n## 참고 자료\n- b\n## 결론\n남는 문단")).toBe("## 결론\n남는 문단");
  expect(listeningSource("## 13. 질문\n질문과 답\n## 15. 출처\n- 논문 원문\n### 원문 링크\n- 참고 링크\n## 16. 결론\n마지막 내용"))
    .toBe("## 13. 질문\n질문과 답\n## 16. 결론\n마지막 내용");
});

for (const style of ["read", "podcast"] as const) test(`a ${style} script keeps the last answer beyond the former 6000-character cap`, async () => {
  const { f, tts, idle } = setup();
  const owner = await f.login();
  const body = `${"원문의 문단입니다. 설명이 이어져요.\n\n".repeat(200)}## 끝 질문\n답은 마지막 확인입니다.`;
  const response = await f.call("/api/v1/records", "POST", {
    requestId: crypto.randomUUID(), record: agentRecord({ body }),
  }, owner);
  expect(response.status).toBe(201);
  const record = recordResult.parse(await response.json()).record;
  const paragraphs = Array.from({ length: 180 }, () => style === "podcast"
    ? "A: 원문의 사실을 빠짐없이 전합니다.\n\nB: 이어지는 설명도 그대로 들어요."
    : "원문의 사실을 빠짐없이 전합니다. 이어지는 설명도 그대로 들어요.");
  const lastAnswer = "답은 마지막 확인입니다. 이 답까지 들어요.";
  tts.scriptText = [...paragraphs, `${style === "podcast" ? "A: " : ""}${lastAnswer}`].join("\n\n");
  expect(tts.scriptText.length).toBeGreaterThan(6000);
  expect((await f.call(narration(record.id), "POST", { style }, owner)).status).toBe(202);
  await idle();
  const state = await read(await f.call(narration(record.id), "GET", undefined, owner));
  expect(state.narration?.status).toBe("ready");
  expect(state.narration?.audio?.style).toBe(style);
  expect(state.narration?.script?.endsWith(lastAnswer)).toBe(true);
  const spoken = style === "podcast" ? tts.calls.converse.flat().map(turn => turn.text) : tts.calls.speak;
  expect(spoken.at(-1)).toContain(lastAnswer);
});

test("an oversized record script fails instead of speaking a silently truncated document", async () => {
  const { f, tts, idle } = setup();
  const owner = await f.login();
  const record = await research(f, owner);
  tts.scriptText = "원문의 설명입니다. 내용이 이어져요. ".repeat(1000);
  expect(tts.scriptText.length).toBeGreaterThan(NARRATION_LIMITS.partScriptChars);
  expect((await f.call(narration(record.id), "POST", {}, owner)).status).toBe(202);
  await idle();
  const state = await read(await f.call(narration(record.id), "GET", undefined, owner));
  expect(state.narration).toMatchObject({ status: "failed", error: "script_too_long", audio: null });
  expect(tts.calls.speak).toHaveLength(0);
});

test("a long body is split into parts at its headings, each within the part length, together covering the whole body", () => {
  const sections = Array.from({ length: 6 }, (_, index) => `## 절 ${index + 1}\n${`절 ${index + 1}의 문장입니다. `.repeat(400).trim()}`);
  const body = sections.join("\n\n");
  const parts = scriptParts(body);
  expect(parts.length).toBeGreaterThan(1);
  for (const part of parts) expect(part.length).toBeLessThanOrEqual(NARRATION_LIMITS.partChars);
  for (const section of sections) expect(parts.some(part => part.includes(section))).toBe(true);
  expect(parts.every(part => part.startsWith("## 절"))).toBe(true);
  expect(scriptParts("짧은 본문")).toEqual(["짧은 본문"]);
  const oneParagraph = "긴 문단입니다. ".repeat(4000);
  expect(scriptParts(oneParagraph).every(part => part.length <= NARRATION_LIMITS.partChars)).toBe(true);
  expect(scriptParts(oneParagraph).join("").replace(/\s/g, "")).toBe(oneParagraph.replace(/\s/g, ""));
});

test("a record past the part length is scripted part by part: every part reaches the script model, the audio covers all of them", async () => {
  const { f, tts, idle } = setup();
  const owner = await f.login();
  const sections = Array.from({ length: 4 }, (_, index) => `## 절 ${index + 1}\n${`절 ${index + 1}의 내용입니다. `.repeat(500)}`);
  const body = [...sections, "## 출처\n- 원문 https://example.com/source"].join("\n\n");
  const response = await f.call("/api/v1/records", "POST", { requestId: crypto.randomUUID(), record: {
    kind: "research", title: "긴 조사", body, fields: { summary: "요약", conclusion: "결론", nextActions: "- 다음 할 일" } } }, owner);
  const record = recordResult.parse(await response.json()).record;
  const partCount = scriptParts(listeningSource(body)).length;
  expect(partCount).toBeGreaterThan(1);
  tts.scriptTexts = Array.from({ length: partCount }, (_, index) => `${index + 1}번째 부분을 전합니다. 내용이 이어져요. ${"본문의 문장을 그대로 전합니다. 이어서 들어요. ".repeat(160)}`.trim());
  expect((await f.call(narration(record.id), "POST", {}, owner)).status).toBe(202);
  await idle();
  const state = await read(await f.call(narration(record.id), "GET", undefined, owner));
  expect(state.narration?.status).toBe("ready");
  expect(tts.calls.script).toBe(partCount);
  for (const [index, section] of sections.entries()) expect(tts.calls.prompts.some(prompt => prompt.includes(section.split("\n")[0] ?? "") && prompt.includes(`절 ${index + 1}의 내용입니다.`))).toBe(true);
  expect(tts.calls.prompts.every(prompt => !prompt.includes("example.com/source"))).toBe(true);
  expect(tts.calls.prompts[0]).toContain(`[Body 1/${partCount}]`);
  expect(tts.calls.systems[0]).not.toBe(tts.calls.systems[partCount - 1]);
  for (let index = 0; index < partCount; index += 1) expect(state.narration?.script).toContain(`${index + 1}번째 부분을 전합니다.`);
});

const COVER_BODY = `## 절\n${"원문의 문장입니다. ".repeat(300).trim()}`;
const COVER_FULL = "원문의 문장을 그대로 전합니다. 이어서 들어요. ".repeat(110).trim();

test("a part script far shorter than its source is written once more, and the fuller one is spoken", async () => {
  const { f, tts, idle } = setup();
  const owner = await f.login();
  const response = await f.call("/api/v1/records", "POST", { requestId: crypto.randomUUID(), record: agentRecord({ body: COVER_BODY }) }, owner);
  const record = recordResult.parse(await response.json()).record;
  tts.scriptTexts = ["원문의 일부만 전합니다. 나머지는 줄였어요.", COVER_FULL];
  expect((await f.call(narration(record.id), "POST", {}, owner)).status).toBe(202);
  await idle();
  const state = await read(await f.call(narration(record.id), "GET", undefined, owner));
  expect(state.narration?.status).toBe("ready");
  expect(tts.calls.script).toBe(2);
  expect(tts.calls.systems[1]).not.toBe(tts.calls.systems[0]);
  expect(state.narration?.script).toBe(COVER_FULL);
});

test("a script saved under earlier script rules is written again instead of reused", async () => {
  const { f, tts, idle } = setup();
  const owner = await f.login();
  const response = await f.call("/api/v1/records", "POST", { requestId: crypto.randomUUID(), record: agentRecord({ body: COVER_BODY }) }, owner);
  const record = recordResult.parse(await response.json()).record;
  tts.scriptText = COVER_FULL;
  expect((await f.call(narration(record.id), "POST", {}, owner)).status).toBe(202);
  await idle();
  const db = new Database(f.options.databasePath);
  db.query("UPDATE narrations SET script_hash=audio_hash WHERE record_id=?").run(record.id);
  db.close();
  expect((await f.call(narration(record.id), "POST", { force: true }, owner)).status).toBe(202);
  await idle();
  expect(tts.calls.script).toBe(2);
});

const VOICES = "/api/v1/narration/voices";
const voiceSettings = async (response: Response) => NarrationVoiceSettingsSchema.parse(await response.json());

test("the owner reads the voice settings: the provider's voices and the speaking styles by default, and the Korean voice list", async () => {
  const { f } = setup();
  const owner = await f.login();
  const response = await f.call(VOICES, "GET", undefined, owner);
  expect(response.status).toBe(200);
  const body = await voiceSettings(response);
  const defaults = { readVoice: "Kore", hostA: "Kore", hostB: "Puck", readStyle: SPEECH_STYLE, podcastStyle: PODCAST_STYLE };
  expect(body.settings).toEqual(defaults);
  expect(body.defaults).toEqual(defaults);
  expect(body.voices.find(voice => voice.id === "ko-kr-podcaster-8")).toEqual({ id: "ko-kr-podcaster-8", name: "Podcaster 8", gender: "male", pitch: "low" });
  expect(body.voices.filter(voice => voice.id.startsWith("ko-kr-")).length).toBe(117);
  // The provider's own voices stay choosable even when the list does not name them.
  expect(body.voices.map(voice => voice.id)).toEqual(expect.arrayContaining(["Kore", "Puck"]));
  expect((await f.call(VOICES, "GET", undefined, bearer("omo"))).status).toBe(403);
});

test("saved voices and styles are used from the next narration, and audio made before keeps its voice and is not outdated", async () => {
  const { f, tts, idle } = setup();
  const owner = await f.login();
  const record = await research(f, owner);
  expect((await f.call(narration(record.id), "POST", {}, owner)).status).toBe(202);
  await idle();
  const chosen = { readVoice: "ko-kr-tutor-1", hostA: "ko-kr-storyteller-2", hostB: "ko-kr-podcaster-3", readStyle: "차분하고 느리게", podcastStyle: "활기찬 대화" };
  const saved = await f.call(VOICES, "PUT", chosen, owner);
  expect(saved.status).toBe(200);
  expect((await voiceSettings(saved)).settings).toEqual(chosen);

  const before = await read(await f.call(narration(record.id), "GET", undefined, owner));
  expect(before.narration).toMatchObject({ status: "ready", stale: false, audio: { voice: "Kore" } });

  expect((await f.call(narration(record.id), "POST", { force: true }, owner)).status).toBe(202);
  await idle();
  expect(tts.calls.voices.at(-1)).toBe("ko-kr-tutor-1");
  expect(tts.calls.styles.at(-1)).toBe("차분하고 느리게");
  expect((await read(await f.call(narration(record.id), "GET", undefined, owner))).narration?.audio?.voice).toBe("ko-kr-tutor-1");

  tts.scriptText = DIALOGUE;
  const podcast = await research(f, owner);
  expect((await f.call(narration(podcast.id), "POST", { style: "podcast" }, owner)).status).toBe(202);
  await idle();
  expect(tts.calls.hosts.at(-1)).toEqual(["ko-kr-storyteller-2", "ko-kr-podcaster-3"]);
  expect(tts.calls.styles.at(-1)).toBe("활기찬 대화");
  expect((await read(await f.call(narration(podcast.id), "GET", undefined, owner))).narration?.audio?.voice).toBe("ko-kr-storyteller-2, ko-kr-podcaster-3");

  // The choice is kept across a restart.
  f.restart();
  expect((await voiceSettings(await f.call(VOICES, "GET", undefined, await f.login()))).settings).toEqual(chosen);
});

test("voice settings take only listed voices, two different podcast hosts and a short style, and only from the owner", async () => {
  const { f } = setup();
  const owner = await f.login();
  const valid = { readVoice: "ko-kr-tutor-1", hostA: "ko-kr-tutor-1", hostB: "ko-kr-tutor-2", readStyle: "또렷하게", podcastStyle: "편안하게" };
  for (const bad of [{ ...valid, readVoice: "ko-kr-nobody-9" }, { ...valid, hostB: "ko-kr-tutor-1" }, { ...valid, readStyle: " " },
    { ...valid, podcastStyle: "가".repeat(301) }, { ...valid, extra: true }]) {
    const response = await f.call(VOICES, "PUT", bad, owner);
    expect(response.status).toBe(400);
  }
  expect((await f.call(VOICES, "PUT", valid, bearer("omo"))).status).toBe(403);
  const { Cookie, Origin } = owner;
  expect((await f.call(VOICES, "PUT", valid, { Cookie, Origin })).status).toBe(403);
  expect((await voiceSettings(await f.call(VOICES, "GET", undefined, owner))).settings.readVoice).toBe("Kore");
});

test("a voice preview is spoken once with that voice and then served from the saved file", async () => {
  const { f, tts } = setup();
  const owner = await f.login();
  const first = await f.call(`${VOICES}/ko-kr-tutor-1/preview`, "GET", undefined, owner);
  expect(first.status).toBe(200);
  expect(first.headers.get("content-type")).toBe("audio/wav");
  expect((await first.arrayBuffer()).byteLength).toBeGreaterThan(44);
  expect(tts.calls.voices).toEqual(["ko-kr-tutor-1"]);
  expect((await f.call(`${VOICES}/ko-kr-tutor-1/preview`, "GET", undefined, owner)).status).toBe(200);
  expect(tts.calls.voices).toEqual(["ko-kr-tutor-1"]);
  expect((await f.call(`${VOICES}/ko-kr-nobody-9/preview`, "GET", undefined, owner)).status).toBe(404);
  expect((await f.call(`${VOICES}/ko-kr-tutor-1/preview`, "GET", undefined, bearer("omo"))).status).toBe(403);
});

const AUTO = "/api/v1/narration/auto";
const articles = (...titles: string[]) => ({ key: "domestic", title: "Domestic", kind: "articles",
  items: titles.map(title => ({ key: title, title, source: "Wire", summary: `${title} summary`, url: "https://news.example.com/a" })) });
const messages = (subject: string) => ({ key: "inbox", title: "Inbox", kind: "messages", items: [{ key: subject, importance: "todo", from: "Carrier", subject }] });
const uploadDigest = (f: Fixture, sections: unknown[]) =>
  f.call("/api/v1/digests", "POST", { date: "2026-10-01", slot: "morning", notify: false, sections }, bearer("omo"));
const digestId = async (response: Response) => (await response.json() as { digest: { id: string } }).digest.id;

test("with digest audio set to parts, an upload makes each changed part's audio in the background, and never an unchanged one", async () => {
  const { f, tts, idle } = setup(undefined, { autoDefaults: { digests: "parts" } });
  const owner = await f.login();
  // When: an agent uploads articles and messages while the speech provider is held, so no audio can finish yet.
  const held = hold(tts);
  const created = await uploadDigest(f, [articles("First article"), messages("First message")]);
  // Then: the upload answers at once.
  expect(created.status).toBe(201);
  const id = await digestId(created);
  await held.entered.promise;
  held.release.resolve();
  await idle();
  // And: the articles and the messages each have ready, current audio from one script, with nobody asking.
  for (const part of ["articles", "messages"] as const) {
    const state = await read(await f.call(`/api/v1/digests/${digestPartId(id, part)}/narration`, "GET", undefined, owner));
    expect(state.narration).toMatchObject({ status: "ready", stale: false, style: "read" });
  }
  expect(tts.calls.script).toBe(2);
  // When: the same digest comes again, then with new messages only.
  await uploadDigest(f, [articles("First article"), messages("First message")]);
  await idle();
  expect(tts.calls.script).toBe(2);
  await uploadDigest(f, [messages("Second message")]);
  await idle();
  // Then: only the messages are made again.
  expect(tts.calls.script).toBe(3);
  expect(tts.calls.prompts[2]).toContain("Second message");
  expect((await read(await f.call(`/api/v1/digests/${id}/narration`, "GET", undefined, owner))).narration).toMatchObject({ status: "ready", stale: false });
});

test("a digest part that changes while its audio is being made is made again once that job ends", async () => {
  const { f, tts, idle } = setup(undefined, { autoDefaults: { digests: "parts" } });
  const owner = await f.login();
  const held = hold(tts);
  const id = await digestId(await uploadDigest(f, [articles("Early article")]));
  await held.entered.promise;
  // When: more articles arrive while the first articles audio is being spoken.
  await uploadDigest(f, [articles("Early article", "Late article")]);
  held.release.resolve();
  await idle();
  // Then: the articles audio is remade from the later articles and is current.
  expect(tts.calls.script).toBe(2);
  expect(tts.calls.prompts[1]).toContain("Late article");
  expect((await read(await f.call(`/api/v1/digests/${id}/narration`, "GET", undefined, owner))).narration).toMatchObject({ status: "ready", stale: false });
});

test("digest audio set to all makes one audio for the whole digest; off (the default) makes none", async () => {
  const off = setup();
  const offOwner = await off.f.login();
  const plainId = await digestId(await uploadDigest(off.f, [articles("Article"), messages("Message")]));
  await off.idle();
  expect(off.tts.calls.script).toBe(0);
  expect((await read(await off.f.call(`/api/v1/digests/${plainId}/narration`, "GET", undefined, offOwner))).narration).toBeNull();
  const all = setup(undefined, { autoDefaults: { digests: "all" } });
  const owner = await all.f.login();
  const id = await digestId(await uploadDigest(all.f, [articles("Article"), messages("Message")]));
  await all.idle();
  expect(all.tts.calls.script).toBe(1);
  expect((await read(await all.f.call(`/api/v1/digests/${digestPartId(id, "all")}/narration`, "GET", undefined, owner))).narration?.status).toBe("ready");
  expect((await read(await all.f.call(`/api/v1/digests/${id}/narration`, "GET", undefined, owner))).narration).toBeNull();
});

test("the owner reads and saves the automatic audio settings, which survive a restart; agents and bad input are refused", async () => {
  const { f } = setup();
  const owner = await f.login();
  expect(await (await f.call(AUTO, "GET", undefined, owner)).json()).toEqual({ digests: "off", records: "off", scope: "full" });
  const saved = await f.call(AUTO, "PUT", { digests: "all", records: "podcast", scope: "summary" }, owner);
  expect(saved.status).toBe(200);
  expect(await saved.json()).toEqual({ digests: "all", records: "podcast", scope: "summary" });
  f.restart();
  const again = await f.login();
  expect(await (await f.call(AUTO, "GET", undefined, again)).json()).toEqual({ digests: "all", records: "podcast", scope: "summary" });
  expect((await f.call(AUTO, "GET", undefined, bearer("omo"))).status).toBe(403);
  expect((await f.call(AUTO, "PUT", { digests: "off", records: "off", scope: "full" }, bearer("omo"))).status).toBe(403);
  expect((await f.call(AUTO, "PUT", { digests: "sometimes", records: "off", scope: "full" }, again)).status).toBe(400);
  const { "X-CSRF-Token": _csrf, ...withoutCsrf } = again;
  expect((await f.call(AUTO, "PUT", { digests: "off", records: "off", scope: "full" }, withoutCsrf)).status).toBe(403);
});

test("with new-record audio on, each new research or work report gets audio in the chosen style, and the daily limit rises to 30", async () => {
  // Given: a daily limit of 1 and new-record audio turned on as podcast.
  const { f, tts, idle } = setup(1);
  const owner = await f.login();
  expect((await f.call(AUTO, "PUT", { digests: "off", records: "podcast", scope: "full" }, owner)).status).toBe(200);
  // When: an agent saves two research records and a note.
  const save = async (record: Record<string, unknown>) =>
    recordResult.parse(await (await f.call("/api/v1/records", "POST", payload(agentRecord(record)), bearer("omo"))).json()).record;
  const first = await save({ title: "First research", body: "First body" });
  const second = await save({ title: "Second research", body: "Second body" });
  const note = await save({ kind: "note", title: "Note", body: "Note body" });
  await idle();
  // Then: both research records have podcast audio (two runs under a limit of 1 needed the raised limit); the note has none.
  for (const record of [first, second]) {
    expect((await read(await f.call(narration(record.id), "GET", undefined, owner))).narration).toMatchObject({ status: "ready", style: "podcast" });
  }
  expect((await read(await f.call(narration(note.id), "GET", undefined, owner))).narration).toBeNull();
  expect(tts.calls.converse.length).toBeGreaterThan(0);
});

test("with records set to read only their summary, the script leaves the body out; back on the full document the body is read", async () => {
  const { f, tts, idle } = setup();
  const owner = await f.login();
  const record = recordResult.parse(await (await f.call("/api/v1/records", "POST", payload(agentRecord({
    title: "Scope research", body: "A sentence only in the body.", fields: { summary: "A sentence in the summary", conclusion: "The conclusion", nextActions: "- none" } })), bearer("omo"))).json()).record;
  expect((await f.call(AUTO, "PUT", { digests: "off", records: "off", scope: "summary" }, owner)).status).toBe(200);
  // When: the owner asks for the record's audio under Summary only.
  expect((await f.call(narration(record.id), "POST", { style: "read" }, owner)).status).toBe(202);
  await idle();
  // Then: the script was written from the summary fields only.
  expect(tts.calls.prompts[0]).toContain("A sentence in the summary");
  expect(tts.calls.prompts[0]).not.toContain("A sentence only in the body");
  expect((await read(await f.call(narration(record.id), "GET", undefined, owner))).narration?.status).toBe("ready");
  // When: the scope goes back to the full document and the owner asks again without forcing.
  expect((await f.call(AUTO, "PUT", { digests: "off", records: "off", scope: "full" }, owner)).status).toBe(200);
  expect((await f.call(narration(record.id), "POST", { style: "read" }, owner)).status).toBe(202);
  await idle();
  // Then: a new script covers the body.
  expect(tts.calls.prompts[1]).toContain("A sentence only in the body");
});
