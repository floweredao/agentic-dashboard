import { AsyncLocalStorage } from "node:async_hooks";
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NARRATION_LIMITS } from "../shared/contracts";
import type { DashboardRecord } from "../shared/contracts";
import { ApiError } from "./errors";
import { spokenNumbers } from "./spoken-numbers";
import { ProviderError, type NarrationOptions, type Job, Cancelled, type Row } from "./narration-types";
import { COVERAGE_MIN, COVERAGE_AGAIN, SUMMARY_ONLY, SCRIPT_RULES, partNote, SCRIPT_SYSTEM, KOREAN_POLITE, KOREAN_POLITE_AGAIN, KOREAN_TONE_AGAIN, DIGEST_SCRIPT_SYSTEM, PODCAST_SCRIPT_SYSTEM } from "./narration-prompts";
import { expectedScriptChars, sourceHash, scriptPrompt, listeningSource, scriptParts, isKorean, plainSentences, oneSidedTone, missingFigures, factsAgain, normalizeScript, splitChunks, dialogueChunks } from "./narration-text";
import { wav, afconvert } from "./narration-audio";
import type { createNarrationState } from "./narration-state";
import type { createNarrationSettings } from "./narration-settings";
import { createNarrationCalls } from "./narration-calls";
const BYTES_PER_MS = 48;
export function createNarrationWork(options: NarrationOptions, runtime: {
  readonly rows: ReturnType<typeof createNarrationState>;
  readonly settings: ReturnType<typeof createNarrationSettings>;
  readonly jobs: AsyncLocalStorage<Job>;
}) {
  const { store, provider, audioDir } = options;
  const { now, available, row, set } = runtime.rows;
  const { voiceSettings } = runtime.settings;
  const { pause, retrying, writeScript, stepStarted } = createNarrationCalls(options, runtime.jobs);
  const encode = options.encode ?? afconvert;
  const timeoutMs = options.timeoutMs ?? 180_000;
  const removeFile = (name: string | null) => { if (name) rmSync(join(audioDir, name), { force: true }); };

  /** Stores the script characters received, at most once per 2% of the expected length so a fast stream costs few writes. */
  function scriptProgress(id: string, expected: number, cancel: AbortSignal) {
    let mark = 0;
    let writes = Promise.resolve();
    const receive = (chars: number) => {
      const next = Math.floor(Math.min(chars, expected) * 50 / expected);
      if (next === mark || cancel.aborted) return;
      mark = next;
      writes = writes.then(() => set(id, { progress_done: chars }));
      void writes.catch(() => undefined); // flush delivers failures to the job.
    };
    return { receive, flush: () => writes };
  }


  async function work(id: string, job: Row, cancel: AbortSignal) {
    const check = () => { if (cancel.aborted) throw new Cancelled(); };
    let record: DashboardRecord;
    let label: string | undefined;
    try { record = (await store.get(id)); }
    catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) throw error;
      const source = (await options.lookup?.(id));
      if (!source) { (await set(id, { status: "failed", error: "record_missing" })); return; }
      record = source.record;
      label = source.label;
    }
    if (!provider || !await available()) { if (!cancel.aborted) (await set(id, { status: "failed", error: "no_key" })); return; }
    if (cancel.aborted) return;
    const hash = sourceHash(record);
    const style = job.style;
    const podcast = style === "podcast";
    const voices = (await voiceSettings());
    const hosts = [voices.hostA, voices.hostB] as const;
    const part = join(audioDir, `${id}.part.wav`);
    try {
      const digest = label !== undefined;
      const summaryOnly = !digest && job.scope === "summary";
      const scriptKey = summaryOnly ? `${hash}:${SCRIPT_RULES}:summary` : `${hash}:${SCRIPT_RULES}`;
      let script = job.script_hash === scriptKey && job.script_style === style ? job.script : null;
      if (!script) {
        const korean = isKorean(record);
        const base = podcast ? PODCAST_SCRIPT_SYSTEM : digest ? DIGEST_SCRIPT_SYSTEM : SCRIPT_SYSTEM;
        const scoped = summaryOnly ? `${base}\n${SUMMARY_ONLY}` : base;
        const system = korean ? `${scoped}\n${KOREAN_POLITE}` : scoped;
        const max = digest ? NARRATION_LIMITS.digestScriptChars : NARRATION_LIMITS.partScriptChars;
        const normalize = (raw: string) => {
          const result = normalizeScript(raw, digest ? max : Number.MAX_SAFE_INTEGER);
          if (!digest && result.length > max) throw new ProviderError("script_too_long", false);
          return result;
        };
        // A record is heard whole: its listenable body goes to the script model in parts, one script per part, in order.
        const texts = digest || summaryOnly ? [null] : scriptParts(listeningSource(record.body).slice(0, NARRATION_LIMITS.sourceChars));
        const parts = texts.map((text, index) => ({
          prompt: scriptPrompt(record, label, summaryOnly ? null : text === null ? undefined : { text, index, total: texts.length }),
          system: texts.length > 1 ? `${system}\n${partNote(index, texts.length, podcast, max)}` : system,
          source: text,
        }));
        const expected = parts.reduce((sum, part) => sum + expectedScriptChars(part.prompt, max), 0);
        (await set(id, { status: "scripting", job_hash: hash, progress_done: 0, progress_total: expected }));
        stepStarted();
        const received = scriptProgress(id, expected, cancel);
        const scripts: string[] = [];
        let written = 0;
        for (const { prompt, system: partSystem, source } of parts) {
          check();
          const onText = (chars: number) => received.receive(written + chars);
          let part = normalize(await writeScript(provider, partSystem, prompt, cancel, onText));
          // One more script when a Korean script slipped into 반말 or into one tone, a Korean digest lost a summary's facts, or a
          // record part was summarized instead of told; a second slip is kept rather than paid for again.
          const tone = korean ? oneSidedTone(part) : null;
          const missing = korean && digest && !podcast ? missingFigures(record.body, part) : [];
          const thin = source !== null && part.length < source.length * COVERAGE_MIN;
          const again = [korean && plainSentences(part).length > 0 ? KOREAN_POLITE_AGAIN : "", tone ? KOREAN_TONE_AGAIN[tone] : "",
            missing.length > 0 ? factsAgain(missing) : "", thin ? COVERAGE_AGAIN : ""].filter(Boolean);
          if (again.length > 0) {
            check();
            part = normalize(await writeScript(provider, `${partSystem}\n${again.join("\n")}`, prompt, cancel, onText)) || part;
          }
          if (!part) throw new ProviderError("empty_script", false);
          scripts.push(part);
          written += part.length;
        }
        await received.flush();
        script = scripts.join("\n\n");
        // Kept even when cancelled meanwhile: it is paid for, and a later request reuses it.
        (await set(id, { script, script_hash: scriptKey, script_style: style }));
        check();
      }
      const text = script;
      // A Korean script is spoken with each number before a known unit written out as it is read; the saved script keeps the digits.
      const read = isKorean(record) ? spokenNumbers : (value: string) => value;
      const speeches: ((signal: AbortSignal) => Promise<Uint8Array>)[] = podcast
        ? dialogueChunks(text).map(turns => signal => provider.converse(turns.map(turn => ({ ...turn, text: read(turn.text) })), voices.podcastStyle, signal, hosts))
        : splitChunks(text).map(chunk => signal => provider.speak(read(chunk), voices.readStyle, signal, voices.readVoice));
      if (speeches.length === 0) throw new ProviderError("empty_script", false);
      const pcm: Uint8Array[] = [];
      (await set(id, { status: "speaking", job_hash: hash, progress_done: 0, progress_total: speeches.length }));
      stepStarted();
      let pace = 0;
      for (const [index, speech] of speeches.entries()) {
        if (index > 0 && pace > 0) await pause(pace, cancel);
        const audio = await retrying(speech, cancel, ms => { pace = Math.max(pace, ms); });
        check();
        if (audio.byteLength === 0) throw new ProviderError("no_audio", false);
        pcm.push(audio);
        (await set(id, { progress_done: index + 1 }));
        stepStarted();
      }
      const body = Buffer.concat(pcm);
      mkdirSync(audioDir, { recursive: true, mode: 0o700 });
      writeFileSync(part, wav(body), { mode: 0o600 });
      const encoded = await encode(part, AbortSignal.any([AbortSignal.timeout(timeoutMs), cancel]));
      check();
      const name = `${id}-${crypto.randomUUID().slice(0, 8)}.${encoded.mime === "audio/wav" ? "wav" : "m4a"}`;
      renameSync(encoded.path, join(audioDir, name));
      chmodSync(join(audioDir, name), 0o600);
      const previous = (await row(id))?.audio_file ?? null;
      if (!(await row(id))) { removeFile(name); return; }
      (await set(id, { status: "ready", attempts: 0, error: null, progress_done: null, progress_total: null, audio_file: name, audio_hash: hash,
        audio_mime: encoded.mime, audio_bytes: Bun.file(join(audioDir, name)).size, audio_ms: Math.round(body.byteLength / BYTES_PER_MS),
        audio_model: provider.ttsModel, audio_voice: podcast ? hosts.join(", ") : voices.readVoice, audio_style: style, audio_scope: job.scope, audio_at: now() }));
      if (previous !== name) removeFile(previous);
    } catch (error) {
      rmSync(part, { force: true });
      rmSync(part.replace(/\.wav$/, ".m4a"), { force: true });
      if (cancel.aborted) return;
      const code = error instanceof ProviderError ? error.code : "internal";
      const latest = (await row(id));
      if (latest) (await set(id, { status: "failed", error: code, attempts: latest.attempts + 1, progress_done: null, progress_total: null }));
      if (!(error instanceof ProviderError)) throw error;
    }
  }
  return work;
}
