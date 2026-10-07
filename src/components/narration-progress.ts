import type { Narration } from "../../shared/contracts";
import { strings } from "../i18n";

const text = strings({
  en: {
    ready: "Ready",
    scripting: "Writing the script",
    saving: "Saving the file",
    speaking: "Creating audio",
    speakingChunk: (done: number, total: number) => `Creating audio ${done + 1}/${total}`,
    waiting: "Waiting for its turn",
    busy: "Too many requests, resuming soon",
  },
  ko: {
    ready: "다 만들었어요",
    scripting: "원고를 쓰고 있어요",
    saving: "파일로 저장하고 있어요",
    speaking: "음성을 만들고 있어요",
    speakingChunk: (done: number, total: number) => `음성을 만들고 있어요 ${done + 1}/${total}`,
    waiting: "차례를 기다리고 있어요",
    // A pause for the provider's request limit (a 429/503 retry or the pace between parts); the job goes on by itself after it.
    busy: "요청이 많아 잠시 쉬었다가 이어서 만들어요",
  },
});

/**
 * A narration job as a 0-100 bar. Each real stage the server reports owns a band: waiting its turn 0-4, the script 4-30,
 * the speech chunks 30-95 split evenly (chunk n of m), saving the file 95-99, done 100. Inside a band the value creeps from
 * the band's start toward its end the longer the stage runs, slowing down and never reaching it, so the bar keeps moving
 * without claiming a step that has not happened (progress backed by a real measure).
 */
export interface Stage { readonly label: string; readonly from: number; readonly to: number; readonly tauMs: number; readonly since: number }

const SPEECH_FROM = 30;
const SPEECH_TO = 95;
/** The share of a band a stage may fill however long it runs; the rest is left for the real step that ends it. */
const REACH = 0.9;

export function narrationStage(narration: Narration, now: number): Stage {
  const since = Date.parse(narration.updatedAt);
  const band = (label: string, from: number, to: number, tauMs: number): Stage => ({ label, from, to, tauMs, since });
  let stage: Stage;
  const t = text();
  if (narration.status === "ready") stage = band(t.ready, 100, 100, 1);
  else if (narration.status === "scripting") stage = band(t.scripting, 4, SPEECH_FROM, 20_000);
  else if (narration.status === "speaking" && narration.progress && narration.progress.total > 0) {
    const { done, total } = narration.progress;
    const step = (SPEECH_TO - SPEECH_FROM) / total;
    stage = done >= total ? band(t.saving, SPEECH_TO, 99, 3000)
      : band(total > 1 ? t.speakingChunk(done, total) : t.speaking, SPEECH_FROM + step * done, SPEECH_FROM + step * (done + 1), 25_000);
  } else stage = band(t.waiting, 0, 4, 10_000);
  const waiting = narration.waitUntil !== null && Date.parse(narration.waitUntil) > now;
  return waiting ? { ...stage, label: t.busy } : stage;
}

/** The stage's value at `now`: its start, then an exponential approach toward REACH of the band (fast first, then slower). */
export function stageValue(stage: Stage, now: number): number {
  const elapsed = Math.max(0, now - stage.since);
  return stage.from + (stage.to - stage.from) * REACH * (1 - Math.exp(-elapsed / stage.tauMs));
}
