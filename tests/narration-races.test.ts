import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { z } from "zod";
import type { Encoder, NarrationOptions, NarrationProvider } from "../server/narration";
import { fixture, recordResult } from "./backend-helper";

/** A provider stub (no network): one second of silence per chunk; `available` waits at the gate while one is set. */
function stub() {
  const state = { scripts: 0, speaks: [] as string[], gate: null as null | { waiting: number; open: Promise<void> } };
  const provider: NarrationProvider = {
    ttsModel: "stub-tts", scriptModel: "stub-script", voice: "Kore", hosts: ["Kore", "Puck"],
    available: async () => {
      const gate = state.gate;
      if (gate) { gate.waiting += 1; await gate.open; }
      return true;
    },
    script: async (_system, _prompt, _signal, _route, onText) => { state.scripts += 1; onText?.(20); return "첫 문단입니다. 둘째 문장이에요."; },
    speak: async (_text, _style, _signal, voice) => { state.speaks.push(voice ?? "Kore"); return new Uint8Array(48000); },
    converse: async () => new Uint8Array(48000),
  };
  /** Holds every key check until `release`, which waits for `count` requests to be held and then lets them all through. */
  const meet = (count: number) => {
    let open = () => undefined as void;
    const gate = { waiting: 0, open: new Promise<void>(resolve => { open = resolve; }) };
    state.gate = gate;
    return {
      async release() {
        while (gate.waiting < count) await Bun.sleep(1);
        state.gate = null;
        open();
      },
    };
  };
  return { provider, state, meet };
}
const wavOnly: Encoder = async path => ({ path, mime: "audio/wav" });
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

function setup(extra: Partial<Omit<NarrationOptions, "store" | "provider" | "audioDir">> = {}) {
  const tts = stub();
  const f = fixture(10000, Date.now, { narration: { provider: tts.provider, encode: wavOnly, retryDelayMs: 0, ...extra } });
  cleanups.push(() => f.close());
  return { f, tts };
}
const narration = (id: string) => `/api/v1/records/${id}/narration`;
const runs = (path: string, id: string) => {
  const db = new Database(path);
  try { return z.object({ count: z.number() }).parse(db.query("SELECT count(*) AS count FROM narration_runs WHERE record_id=?").get(id)).count; }
  finally { db.close(); }
};
async function note(f: ReturnType<typeof setup>["f"], owner: HeadersInit) {
  const response = await f.call("/api/v1/records", "POST", { requestId: crypto.randomUUID(), record: {
    kind: "note", title: "메모", body: "본문 문단입니다.", fields: { summary: "요약입니다." },
  } }, owner);
  expect(response.status).toBe(201);
  return recordResult.parse(await response.json()).record;
}

test("two Listen requests for a record made at the same moment start one job and count one run", async () => {
  // Given: a record with no audio yet, and a key check slow enough for both requests to be waiting on it.
  const { f, tts } = setup();
  const owner = await f.login();
  const record = await note(f, owner);
  const gate = tts.meet(2);
  // When: the owner asks twice at once.
  const both = Promise.all([f.call(narration(record.id), "POST", {}, owner), f.call(narration(record.id), "POST", {}, owner)]);
  await gate.release();
  const statuses = (await both).map(response => response.status).sort();
  await f.app.narration.idle();
  // Then: one request started the job, the other answered its state; neither failed, and the day counts one run.
  expect(statuses).toEqual([200, 202]);
  expect(runs(f.options.databasePath, record.id)).toBe(1);
  expect(tts.state.scripts).toBe(1);
});

test("parallel forced requests for a record with audio start one job and count one run against the daily limit", async () => {
  // Given: a daily limit of three runs, one used by audio that is ready.
  const { f, tts } = setup({ dailyLimit: 3 });
  const owner = await f.login();
  const record = await note(f, owner);
  expect((await f.call(narration(record.id), "POST", {}, owner)).status).toBe(202);
  await f.app.narration.idle();
  const gate = tts.meet(2);
  // When: two forced requests for the same record arrive together.
  const both = Promise.all([0, 1].map(() => f.call(narration(record.id), "POST", { force: true }, owner)));
  await gate.release();
  const statuses = (await both).map(response => response.status).sort();
  await f.app.narration.idle();
  // Then: one job starts, and the day has used two runs, not three.
  expect(statuses).toEqual([200, 202]);
  expect(runs(f.options.databasePath, record.id)).toBe(2);
});

test("a voice preview asked for while its sample is still encoding gets the finished file, never the half-written one", async () => {
  // Given: an encoder that has written half its output and waits.
  let finish = () => undefined as void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  let started = () => undefined as void;
  const encoding = new Promise<void>(resolve => { started = resolve; });
  let encodes = 0;
  const encode: Encoder = async wavPath => {
    encodes += 1;
    const out = wavPath.replace(/\.wav$/, ".m4a");
    writeFileSync(out, "partial");
    started();
    await finished;
    writeFileSync(out, "complete");
    rmSync(wavPath, { force: true });
    return { path: out, mime: "audio/mp4" };
  };
  const { f, tts } = setup({ encode });
  // When: a second preview of the same voice is asked for during the encode.
  const first = f.app.narration.preview("ko-kr-tutor-1");
  await encoding;
  const second = f.app.narration.preview("ko-kr-tutor-1").then(result => readFileSync(result.path, "utf8"));
  finish();
  // Then: both get the complete sample, spoken and encoded once.
  expect(readFileSync((await first).path, "utf8")).toBe("complete");
  expect(await second).toBe("complete");
  expect(tts.state.speaks).toEqual(["ko-kr-tutor-1"]);
  expect(encodes).toBe(1);
});

test("a voice preview whose encode fails leaves no sample behind, so the next preview speaks again", async () => {
  // Given: an encoder that dies once after writing part of its output.
  let failures = 1;
  const encode: Encoder = async wavPath => {
    const out = wavPath.replace(/\.wav$/, ".m4a");
    writeFileSync(out, "partial");
    if (failures-- > 0) throw new Error("encoder crashed");
    writeFileSync(out, "complete");
    rmSync(wavPath, { force: true });
    return { path: out, mime: "audio/mp4" };
  };
  const { f, tts } = setup({ encode });
  // When: the first preview fails.
  await expect(f.app.narration.preview("ko-kr-tutor-1")).rejects.toThrow("encoder crashed");
  // Then: the half-written file was not kept as the voice's sample; the next preview speaks again and serves a whole file.
  const again = await f.app.narration.preview("ko-kr-tutor-1");
  expect(readFileSync(again.path, "utf8")).toBe("complete");
  expect(tts.state.speaks).toEqual(["ko-kr-tutor-1", "ko-kr-tutor-1"]);
});
