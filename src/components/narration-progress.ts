import type { Narration } from "../../shared/contracts";
import { strings } from "../i18n";

const text = strings({
  en: {
    ready: "Ready",
    scripting: "Writing the script",
    scriptTry: (n: number) => ` · attempt ${n}`,
    saving: "Saving the audio",
    speaking: "Generating audio",
    speakingChunk: (done: number, total: number) => `Generating audio ${done + 1}/${total}`,
    waiting: "Waiting in line",
    busy: "Rate-limited · resuming shortly",
    elapsed: (minutes: number, seconds: number) => ` · ${minutes > 0 ? `${minutes}m${seconds > 0 ? ` ${seconds}s` : ""}` : `${seconds}s`}`,
  },
  ko: {
    ready: "다 만들었어요",
    scripting: "원고를 쓰고 있어요",
    // The script model is being asked again after a try stalled or failed; the same model, never a lighter one.
    scriptTry: (n: number) => ` · ${n}번째 시도`,
    saving: "파일로 저장하고 있어요",
    speaking: "음성을 만들고 있어요",
    speakingChunk: (done: number, total: number) => `음성을 만들고 있어요 ${done + 1}/${total}`,
    waiting: "차례를 기다리고 있어요",
    // A pause for the provider's request limit (a 429/503 retry or the pace between parts); the job goes on by itself after it.
    busy: "요청이 많아 잠시 쉬었다가 이어서 만들어요",
    elapsed: (minutes: number, seconds: number) => ` · ${minutes > 0 ? `${minutes}분${seconds > 0 ? ` ${seconds}초` : ""}` : `${seconds}초`}째`,
  },
});

/**
 * A narration job as a 0-100 value and a label, from what the server reported and nothing else (a percent only for
 * a real completed/total measure). Waiting its turn is 0, the
 * script fills 4-30 by the characters received over the expected length, the speech chunks fill 30-95 evenly as each one
 * finishes, saving the file is 95 and done is 100. Time passing alone never changes the value; once a step has run for
 * ELAPSED_FROM_MS the label says how long instead (`원고를 쓰고 있어요 · 40초째`), so a slow step does not look stuck.
 */
export interface Stage { readonly label: string; readonly value: number }

const SCRIPT_FROM = 4;
const SPEECH_FROM = 30;
const SPEECH_TO = 95;
const ELAPSED_FROM_MS = 10_000;

export function narrationStage(narration: Narration, now: number): Stage {
  const t = text();
  const { status, progress } = narration;
  let stage: Stage;
  if (status === "ready") stage = { label: t.ready, value: 100 };
  else if (status === "scripting") {
    const share = progress && progress.total > 0 ? Math.min(progress.done / progress.total, 1) : 0;
    const again = narration.scriptTry !== undefined && narration.scriptTry > 1 ? t.scriptTry(narration.scriptTry) : "";
    stage = { label: t.scripting + again, value: SCRIPT_FROM + (SPEECH_FROM - SCRIPT_FROM) * share };
  } else if (status === "speaking" && progress && progress.total > 0) {
    const { done, total } = progress;
    stage = done >= total ? { label: t.saving, value: SPEECH_TO }
      : { label: total > 1 ? t.speakingChunk(done, total) : t.speaking, value: SPEECH_FROM + (SPEECH_TO - SPEECH_FROM) * done / total };
  } else stage = { label: t.waiting, value: 0 };
  if (narration.waitUntil !== null && Date.parse(narration.waitUntil) > now) return { ...stage, label: t.busy };
  const elapsed = narration.stepAt === null || status === "ready" ? 0 : now - Date.parse(narration.stepAt);
  if (elapsed < ELAPSED_FROM_MS) return stage;
  const seconds = Math.floor(elapsed / 1000);
  return { ...stage, label: stage.label + t.elapsed(Math.floor(seconds / 60), seconds % 60) };
}
