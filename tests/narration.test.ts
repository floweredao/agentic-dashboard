import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { briefingPartId, NARRATION_LIMITS, NarrationStateSchema } from "../shared/contracts";
import { normalizeScript, ProviderError, splitChunks } from "../server/narration";
import type { NarrationProvider } from "../server/narration";
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
  provider: NarrationProvider; calls: { script: number; speak: string[]; prompts: string[] }; available: boolean;
  failSpeak: number | "always"; error: Error | null; scriptText: string; hold: Hold | null;
};

/** A TTS provider that returns one second of silence per chunk and records what it was asked. */
function fake(): Fake {
  const state: Fake = { calls: { script: 0, speak: [], prompts: [] }, available: true, failSpeak: 0, error: null, scriptText: SCRIPT, hold: null, provider: null as never };
  state.provider = {
    ttsModel: "fake-tts", scriptModel: "fake-script", voice: "Kore",
    available: async () => state.available,
    script: async (_system, prompt) => { state.calls.script += 1; state.calls.prompts.push(prompt); return state.scriptText; },
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

function setup(dailyLimit?: number) {
  const tts = fake();
  const f = fixture(10000, Date.now, { narration: { provider: tts.provider, encode: wavOnly, retryDelayMs: 0, ...(dailyLimit ? { dailyLimit } : {}) } });
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

test("cancel is owner-only with CSRF, answers 404 for unknown ids and works for briefings", async () => {
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

  // A briefing's narration is cancelled through its own route.
  const created = await f.call("/api/v1/briefings", "POST", { date: "2026-10-01", slot: "morning", notify: false, sections: {
    domestic: { items: [{ key: "a", title: "국내 소식", source: "연합뉴스", summary: "요약", url: "https://news.example.com/a" }] } } }, bearer("omo"));
  const id = (await created.json() as { briefing: { id: string } }).briefing.id;
  const path = `/api/v1/briefings/${id}/narration`;
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
  expect((await f.call(`/api/v1/briefings/${crypto.randomUUID()}/narration/cancel`, "POST", {}, owner)).status).toBe(404);
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

test("a failed TTS reuses the saved script, retries once per chunk, and stops after the attempt limit", async () => {
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

test("the owner narrates a briefing's news; its audio lives under the briefing, survives pruning and goes stale when news is added", async () => {
  const { f, tts, idle } = setup();
  const owner = await f.login();
  const upload = (sections: Record<string, unknown>) => f.call("/api/v1/briefings", "POST", { date: "2026-10-01", slot: "morning", notify: false, sections }, bearer("omo"));
  const created = await upload({ domestic: { items: [{ key: "a", title: "국내 소식", source: "연합뉴스", summary: "요약", url: "https://news.example.com/a" }] } });
  const id = (await created.json() as { briefing: { id: string } }).briefing.id;
  const path = `/api/v1/briefings/${id}/narration`;
  // When: the owner asks for the briefing's narration.
  expect((await f.call(path, "POST", {}, owner)).status).toBe(202);
  await idle();
  f.app.purgeTrash();
  // Then: it is ready, made from the briefing's news, with audio under the briefing's path.
  const state = await read(await f.call(path, "GET", undefined, owner));
  expect(state.narration).toMatchObject({ status: "ready", stale: false });
  expect(state.narration?.audio?.url).toStartWith(`${path}/audio?v=`);
  expect((await f.call(state.narration?.audio?.url ?? "", "GET", undefined, owner)).status).toBe(200);
  expect(tts.calls.script).toBe(1);
  expect(tts.calls.prompts[0]).toContain("국내 소식");
  // When: mail arrives later the news audio stays current; more news makes it stale. Agents and unknown briefings get no narration.
  await upload({ mail: { items: [{ key: "m", importance: "check", from: "KT", subject: "접속 알림" }] } });
  expect((await read(await f.call(path, "GET", undefined, owner))).narration?.stale).toBe(false);
  await upload({ aiDevelopment: { items: [{ key: "z", title: "AI 소식", source: "Blog", summary: "요약", url: "https://news.example.com/z" }] } });
  expect((await read(await f.call(path, "GET", undefined, owner))).narration?.stale).toBe(true);
  expect((await f.call(path, "GET", undefined, bearer("omo"))).status).toBe(403);
  expect((await f.call(`/api/v1/briefings/${crypto.randomUUID()}/narration`, "GET", undefined, owner)).status).toBe(404);
});

test("the owner narrates a briefing's mail on its own: the mail part has its own id, script and audio", async () => {
  const { f, tts, idle } = setup();
  const owner = await f.login();
  const created = await f.call("/api/v1/briefings", "POST", { date: "2026-10-01", slot: "morning", notify: false, sections: {
    domestic: { items: [{ key: "a", title: "국내 소식", source: "연합뉴스", summary: "요약", url: "https://news.example.com/a" }] },
    mail: { items: [{ key: "m", importance: "urgent", from: "KT", subject: "접속 알림" }] } } }, bearer("omo"));
  const id = (await created.json() as { briefing: { id: string } }).briefing.id;
  const mailId = briefingPartId(id, "mail");
  expect(mailId).not.toBe(id);
  expect(briefingPartId(id, "news")).toBe(id);
  const path = `/api/v1/briefings/${mailId}/narration`;
  // When: the owner asks for the mail's narration.
  expect((await f.call(path, "POST", {}, owner)).status).toBe(202);
  await idle();
  f.app.purgeTrash();
  // Then: it is made from the mail alone, as a mail briefing, and its audio lives under the mail part's path.
  expect(tts.calls.prompts[0]).toContain("접속 알림");
  expect(tts.calls.prompts[0]).toContain("메일 브리핑");
  expect(tts.calls.prompts[0]).not.toContain("국내 소식");
  const state = await read(await f.call(path, "GET", undefined, owner));
  expect(state.narration).toMatchObject({ recordId: mailId, status: "ready", stale: false });
  expect(state.narration?.audio?.url).toStartWith(`${path}/audio?v=`);
  expect((await f.call(state.narration?.audio?.url ?? "", "GET", undefined, owner)).status).toBe(200);
  // And: the news has no narration yet, and a briefing without mail has no mail part.
  expect((await read(await f.call(`/api/v1/briefings/${id}/narration`, "GET", undefined, owner))).narration).toBeNull();
  const evening = await f.call("/api/v1/briefings", "POST", { date: "2026-10-01", slot: "evening", notify: false, sections: {
    domestic: { items: [{ key: "e", title: "저녁 소식", source: "", summary: "", url: "https://news.example.com/e" }] } } }, bearer("omo"));
  const eveningId = (await evening.json() as { briefing: { id: string } }).briefing.id;
  expect((await f.call(`/api/v1/briefings/${briefingPartId(eveningId, "mail")}/narration`, "GET", undefined, owner)).status).toBe(404);
});
