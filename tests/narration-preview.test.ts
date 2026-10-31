import { afterEach, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Encoder, NarrationOptions, NarrationProvider } from "../server/narration";
import { fixture } from "./backend-helper";

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
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.(); });

async function setup(extra: Partial<Omit<NarrationOptions, "store" | "provider" | "audioDir">> = {}) {
  const tts = stub();
  const f = (await fixture(10000, Date.now, { narration: { provider: tts.provider, encode: wavOnly, retryDelayMs: 0, ...extra } }));
  cleanups.push(() => f.close());
  return { f, tts };
}

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
  const { f, tts } = (await setup({ encode }));
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
  const { f, tts } = (await setup({ encode }));
  // When: the first preview fails.
  await expect(f.app.narration.preview("ko-kr-tutor-1")).rejects.toThrow("encoder crashed");
  // Then: the half-written file was not kept as the voice's sample; the next preview speaks again and serves a whole file.
  const again = await f.app.narration.preview("ko-kr-tutor-1");
  expect(readFileSync(again.path, "utf8")).toBe("complete");
  expect(tts.state.speaks).toEqual(["ko-kr-tutor-1", "ko-kr-tutor-1"]);
});
