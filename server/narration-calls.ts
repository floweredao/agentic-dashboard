import { AsyncLocalStorage } from "node:async_hooks";
import { NARRATION_LIMITS } from "../shared/contracts";
import { type NarrationProvider, ProviderError, type NarrationOptions, type Job, Cancelled } from "./narration-types";
import { assertWorkActive } from "./work-guard";

/** A provider asking for a longer wait is not sat out: the job fails and the owner retries later. */
const MAX_WAIT_MS = 60_000;

/** After a rate limit, the rest of a job keeps the asked wait between chunks, up to this. */
const PACE_CAP_MS = 20_000;

const abortableSleep = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
});
export function createNarrationCalls(options: NarrationOptions, jobContext: AsyncLocalStorage<Job>) {
  const { store } = options;
  const timeoutMs = options.timeoutMs ?? 180_000;
  const retryDelayMs = options.retryDelayMs ?? 2000;
  const sleep = options.sleep ?? abortableSleep;


  /** A wait of the running job (a retry or the pace after a rate limit), shown to the owner while it lasts. */
  async function pause(ms: number, cancel: AbortSignal) {
    const job = jobContext.getStore();
    if (job) job.waitUntil = store.now() + ms;
    try { await sleep(ms, cancel); }
    finally { if (job) job.waitUntil = null; }
  }

  async function call<T>(work: (signal: AbortSignal) => Promise<T>, cancel: AbortSignal): Promise<T> {
    if (cancel.aborted) throw new Cancelled();
    await assertWorkActive(store, jobContext.getStore());
    const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), cancel]);
    try {
      return await work(signal);
    } catch (error) {
      if (cancel.aborted) throw new Cancelled();
      if (error instanceof ProviderError) throw error;
      if (signal.aborted) throw new ProviderError("timeout", true);
      // Provider messages may echo request content or credentials; only a code is kept.
      if (error instanceof Error) throw new ProviderError("provider", false);
      throw error;
    }
  }

  /**
   * One provider call, retried up to NARRATION_LIMITS.retries times on a transient failure: after the wait the provider asked
   * for (also reported to `pace`), else after exponential backoff with jitter (https://ai.google.dev/gemini-api/docs/troubleshooting).
   */
  async function retrying<T>(work: (signal: AbortSignal) => Promise<T>, cancel: AbortSignal, pace?: (ms: number) => void): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await call(work, cancel);
      } catch (error) {
        if (!(error instanceof ProviderError) || !error.transient || attempt >= NARRATION_LIMITS.retries) throw error;
        const asked = error.retryAfterMs;
        if (asked !== undefined && asked > MAX_WAIT_MS) throw error;
        if (asked !== undefined) pace?.(Math.min(asked, PACE_CAP_MS));
        const backoff = retryDelayMs * 2 ** attempt;
        const wait = asked ?? Math.round(backoff * (1 + Math.random() * 0.25));
        if (wait > 0) await pause(wait, cancel);
      }
    }
  }

  /**
   * The script, always from the script model, in up to 1 + NARRATION_LIMITS.retries tries that take the provider's routes to it
   * in turn (Vertex AI, then the key). A try that stalls or times out is followed at once, since waiting does not help a stuck
   * connection (2026-10-07: the key sent nothing for minutes while Vertex answered in seconds); another transient failure waits as
   * `retrying` does; a route that fails for good, or asks for a wait over a minute, is not asked again. There is no other model:
   * when every try fails the job fails, rather than speak a lighter model's worse script (the owner, 2026-10-07).
   */
  async function writeScript(source: NarrationProvider, system: string, prompt: string, cancel: AbortSignal, onText: (chars: number) => void) {
    const routes: readonly (string | undefined)[] = source.scriptRoutes?.length ? source.scriptRoutes : [undefined];
    const closed = new Set<string | undefined>();
    let waits = 0;
    let failure: ProviderError | null = null;
    for (let attempt = 0; attempt <= NARRATION_LIMITS.retries; attempt += 1) {
      const open = routes.filter(route => !closed.has(route));
      if (open.length === 0) break;
      const route = open[attempt % open.length];
      const job = jobContext.getStore();
      if (job) job.scriptTry = attempt + 1;
      if (attempt > 0) stepStarted();
      try {
        return await call(signal => source.script(system, prompt, signal, route, onText), cancel);
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;
        failure = error;
        const asked = error.retryAfterMs;
        if (!error.transient || (asked !== undefined && asked > MAX_WAIT_MS)) { closed.add(route); continue; }
        if (error.code === "stalled" || error.code === "timeout" || attempt === NARRATION_LIMITS.retries) continue;
        const wait = asked ?? Math.round(retryDelayMs * 2 ** waits * (1 + Math.random() * 0.25));
        waits += 1;
        if (wait > 0) await pause(wait, cancel);
      }
    }
    throw failure ?? new ProviderError("empty_script", false);
  }

  /** The running job's next step (the script, a chunk, saving) starts now; the owner sees how long it has run. */
  function stepStarted() {
    const job = jobContext.getStore();
    if (job) job.stepAt = store.now();
  }
  return { pause, retrying, writeScript, stepStarted };
}
