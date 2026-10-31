
import { expect } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { NARRATION_LIMITS, NarrationStateSchema, NarrationVoiceSettingsSchema } from "../shared/contracts";
import { KOREAN_POLITE, ProviderError } from "../server/narration";
import type { NarrationOptions, NarrationProvider, SpeechTurn } from "../server/narration";
import { bearer, fixture, recordResult } from "./backend-helper";

export const SCRIPT = "# 조사 제목\n첫 문단입니다. 자세한 내용은 https://example.com/a?b=1 에 있어요.\n\n**둘째** 문단입니다.";

/** Holds every speak call until `release` (or the call's abort, like a real fetch); `entered` hands over the first call's signal. */
export type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

export type Hold = { entered: Deferred<AbortSignal>; release: Deferred<void> };

export function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

export type Fake = {
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
export function fake(): Fake {
  const state: Fake = { calls: { script: 0, speak: [], prompts: [], systems: [], converse: [], models: [], voices: [], styles: [], hosts: [] }, available: true, failSpeak: 0, error: null, scriptText: SCRIPT,
    hold: null, scriptHold: null, scriptErrors: [], speakErrors: [], scriptTexts: [], provider: null as never };
  state.provider = {
    ttsModel: "fake-tts", scriptModel: "fake-script", voice: "Kore", hosts: ["Kore", "Puck"],
    available: async () => state.available,
    script: async (system, prompt, signal, route, onText) => {
      state.calls.models.push(route ?? "fake-script");
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

export const wavOnly = async (path: string) => ({ path, mime: "audio/wav" });

export const cleanups: (() => void | Promise<void>)[] = [];

export async function setup(dailyLimit?: number, extra: Partial<Omit<NarrationOptions, "store" | "provider" | "audioDir">> = {}) {
  const tts = fake();
  const f = (await fixture(10000, Date.now, { narration: { provider: tts.provider, encode: wavOnly, retryDelayMs: 0, ...(dailyLimit ? { dailyLimit } : {}), ...extra } }));
  cleanups.push(async () => (await f.close()));
  const audioFiles = () => existsSync(join(f.dir, "audio")) ? readdirSync(join(f.dir, "audio")) : [];
  return { f, tts, audioFiles, idle: async () => (await f.app.narration.idle()) };
}

export type Fixture = Awaited<ReturnType<typeof setup>>["f"];

export const read = async (response: Response) => NarrationStateSchema.parse(await response.json());

export async function research(f: Fixture, headers: HeadersInit) {
  const response = await f.call("/api/v1/records", "POST", { requestId: crypto.randomUUID(), record: {
    kind: "research", title: "조사", body: "| 항목 | 값 |\n|---|---|\n| A | 1 |", fields: { summary: "요약", conclusion: "결론" },
  } }, headers);
  expect(response.status).toBe(201);
  return recordResult.parse(await response.json()).record;
}

export const narration = (id: string) => `/api/v1/records/${id}/narration`;

/** The instructions a Korean record is written with: the base ones plus the Korean polite-speech rule. */
export const korean = (system: string) => `${system}\n${KOREAN_POLITE}`;

export const hold = (tts: Fake): Hold => (tts.hold = { entered: deferred<AbortSignal>(), release: deferred<void>() });

/** Two paragraphs that cannot share one chunk, so a job has a second paid call left to skip. */
export const TWO_CHUNKS = `${"첫 문단입니다. ".repeat(100)}\n\n${"둘째 문단입니다. ".repeat(100)}`;

/** A recorder for the waits between retries, which returns at once. */
export function waits() {
  const slept: number[] = [];
  return { slept, sleep: async (ms: number) => { slept.push(ms); } };
}

export const busy = () => new ProviderError("http_503", true);

export const TRIES = NARRATION_LIMITS.retries + 1;

export const HAEYO_ONLY = "10월 3일 저녁 다이제스트이에요. 국내 2건이에요.\n\n서울시가 지하철을 늘린다고 밝혔어요. 한국은행은 금리를 유지했어요.\n\n해외 소식이에요. 엔화 약세가 이어지고 있어요.";

export const HAMNIDA_ONLY = "10월 3일 저녁 다이제스트입니다. 국내 2건입니다.\n\n서울시가 지하철을 늘린다고 밝혔습니다. 한국은행은 금리를 유지했습니다.\n\n해외 소식입니다. 엔화 약세가 이어지고 있습니다.";

/** The middle sentence carries the time, and the first script reads only the first and last. */
export const KYIV = { key: "k", title: "러 드론, 키이우 남부교 타격", source: "예시뉴스", url: "https://news.example.com/k",
  summary: "러시아군이 키이우 남부교를 이틀 사이 4번 공격했다. 키이우 시장은 오후 5시 40분께 네 번째 타격이 있었다고 밝혔다. 시내 교통 혼잡이 커졌다." };

export const KYIV_SHORT = "10월 4일 아침 다이제스트예요. 국내 1건입니다.\n\n러시아군이 키이우 남부교를 이틀 사이 4번 공격했습니다. 시내 교통 혼잡이 커졌어요.";

export const KYIV_FULL = "10월 4일 아침 다이제스트예요. 국내 1건입니다.\n\n러시아군이 키이우 남부교를 이틀 사이 4번 공격했습니다. 네 번째 타격은 오후 5시 40분께였습니다. 시내 교통 혼잡이 커졌어요.";

export const DIALOGUE = "A: Today we look at the app price comparison.\n\nB: Shall we start with the conclusion?\n\nA: The cheapest is app A.\nIt costs five dollars a month.";

export const SOURCES_BODY = [
  "## 배경", "본문 첫 문단입니다.", "", "```ts", "const secret = 1;", "```", "",
  "| 항목 | 값 |", "|---|---|", "| A | 1 |", "", "## 관찰", "관찰 문단입니다.", "- [링크만 있는 줄](https://example.com/a)", "",
  "## 출처", "- 예시뉴스 기사 https://news.example.com/a", "- 논문 원문", "", "## 다음", "마지막 문단입니다.",
].join("\n");

export const COVER_BODY = `## 절\n${"원문의 문장입니다. ".repeat(300).trim()}`;

export const COVER_FULL = "원문의 문장을 그대로 전합니다. 이어서 들어요. ".repeat(110).trim();

export const VOICES = "/api/v1/narration/voices";

export const voiceSettings = async (response: Response) => NarrationVoiceSettingsSchema.parse(await response.json());

export const AUTO = "/api/v1/narration/auto";

export const articles = (...titles: string[]) => ({ key: "domestic", title: "Domestic", kind: "articles",
  items: titles.map(title => ({ key: title, title, source: "Wire", summary: `${title} summary`, url: "https://news.example.com/a" })) });

export const messages = (subject: string) => ({ key: "inbox", title: "Inbox", kind: "messages", items: [{ key: subject, importance: "todo", from: "Carrier", subject }] });

export const uploadDigest = (f: Fixture, sections: unknown[]) =>
  f.call("/api/v1/digests", "POST", { date: "2026-10-01", slot: "morning", notify: false, sections }, bearer("omo"));

export const digestId = async (response: Response) => (await response.json() as { digest: { id: string } }).digest.id;
export async function cleanupNarration() { while (cleanups.length) await cleanups.pop()?.(); }
