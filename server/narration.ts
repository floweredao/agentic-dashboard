import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import { NARRATABLE_KINDS, NARRATION_LIMITS } from "../shared/contracts";
import type { DashboardRecord, NarrationState, NarrationStatus, NarrationStyle } from "../shared/contracts";
import { ApiError } from "./errors";
import type { Principal } from "./store";
import { type NarrationOptions, type Job } from "./narration-types";
import { sourceHash } from "./narration-text";
import { createNarrationState } from "./narration-state";
import { createNarrationSettings } from "./narration-settings";
import { createNarrationWork } from "./narration-work";
import { narrationFiles } from "./narration-files";
import { accountActive } from "./work-guard";
import type { JobPayload } from "./jobs";
import { narrationAllowance } from "./narration-allowance";


const ACTIVE: ReadonlySet<NarrationStatus> = new Set(["queued", "scripting", "speaking"]);

/** Automatic requests refused for a reason that passes (the day's limit, a full queue, no key), tried again by `retryDeferred`. */
const RETRY_LATER = new Set(["narration_daily_limit", "narration_queue_full", "narration_unavailable"]);
export type Narrator = ReturnType<typeof createNarration>;
export function createNarration(options: NarrationOptions) {

  const { store } = options;

  const concurrency = Math.max(1, options.concurrency ?? 1);

  /** Record ids waiting for a slot, in request order. */
  const pending: string[] = [];

  /** The jobs being run by record id, each with its own controller: a cancel aborts only that run, never a later request for the same id. */
  const running = new Map<string, Job>();

  const starting = new Set<string>();

  /** The job whose step is running now, so its waits, steps and script tries show on its own record. */
  const jobContext = new AsyncLocalStorage<Job>();

  const tasks = new Set<Promise<void>>();
  const rows = createNarrationState(options, running);
  const { now, available, row, set, state } = rows;
  const settings = createNarrationSettings(options);
  const { autoSettings } = settings;
  const { allowance, assertAllowance } = narrationAllowance(options, settings);
  const work = createNarrationWork(options, { rows, settings, jobs: jobContext });

  const { removeFile, prune, audioFile } = narrationFiles(options, rows);


  /** `chosen` defaults to the style last chosen for this record, else read. */
  async function request(principal: Principal, record: DashboardRecord, force: boolean, chosen?: NarrationStyle) {
    if (!NARRATABLE_KINDS.some(kind => kind === record.kind)) {
      throw new ApiError(400, "narration_unsupported", "Only research, work-report, note and social records can be narrated");
    }
    const startedJob = await store.db.tx(async () => {
    const hash = sourceHash(record);
    const current = (await row(record.id));
    const style = chosen ?? current?.style ?? "read";
    const settings = (await autoSettings());
    // A digest has no summary of its own to choose: it is always read whole.
    const scope = (await options.lookup?.(record.id)) ? "full" : settings.scope;
    if (current && ACTIVE.has(current.status)) return false;
    if (current && current.audio_hash === hash && current.audio_style === style && current.audio_scope === scope && !force) {
      if (current.style !== style) (await set(record.id, { style }));
      return false;
    }
    await options.requireKey?.();
    if (!await available()) throw new ApiError(503, "narration_unavailable", "No TTS key is configured on the dashboard server");
    const owner = principal.source === "manual";
    const attempts = current?.job_hash === hash ? current.attempts : 0;
    if (attempts >= NARRATION_LIMITS.attempts && !(owner && force)) {
      throw new ApiError(409, "narration_attempts_exhausted", `Narration failed ${attempts} times for this content; change the record, or the owner can force another attempt`);
    }
    await assertAllowance();
    const waiting = z.object({ count: z.number() }).parse((await store.db.get("SELECT count(*) AS count FROM narrations WHERE (status='queued') AND user_id=?", []))).count;
    if (waiting >= NARRATION_LIMITS.queue) throw new ApiError(429, "narration_queue_full", "Too many narrations are waiting; try again later");
    const timestamp = new Date(Math.max(store.now(), current ? Date.parse(current.requested_at) + 1 : 0)).toISOString();
      if (!current) {
        (await store.db.run(`INSERT INTO narrations(record_id,status,job_hash,requested_by,requested_at,updated_at,attempts,style,scope,user_id)
          VALUES(?,'queued',?,?,?,?,0,?,?,?)`, [record.id, hash, principal.id, timestamp, timestamp, style, scope]));
      } else {
        (await set(record.id, { status: "queued", style, scope, job_hash: hash, requested_by: principal.id, requested_at: timestamp,
          attempts: owner && force ? 0 : attempts, error: null, progress_done: null, progress_total: null }));
      }
      (await store.db.run("INSERT INTO narration_runs(record_id,started_at,user_id) VALUES(?,?,?)", [record.id, timestamp]));
      return true;
    });
    if (startedJob) await enqueue(record.id);
    return { state: await state(record), started: startedJob };
  }


  async function run(id: string, lease?: string) {
    const job = (await row(id));
    if (!job || job.status !== "queued") return;
    const controller = new AbortController();
    const live: Job = { id, controller, ...(lease ? { lease } : {}), waitUntil: null, stepAt: null, scriptTry: null };
    running.set(id, live);
    starting.delete(id);
    try { await jobContext.run(live, () => work(id, job, controller.signal)); }
    finally { if (running.get(id) === live) running.delete(id); }
  }


  async function enqueue(id: string) {
    if (options.jobs) {
      const current = await row(id);
      if (current) await options.jobs.enqueue("narration", { userId: store.db.userId, id, revision: current.requested_at });
      return;
    }
    if (!pending.includes(id)) pending.push(id);
    pump();
  }

  async function deliver(payload: JobPayload) {
    if (payload.userId !== store.db.userId || !await accountActive(store)) return;
    const lease = crypto.randomUUID();
    const claimed = await store.db.run(`UPDATE narrations SET leased_by=?,leased_until=?,status='queued'
      WHERE record_id=? AND requested_at=? AND status IN ('queued','scripting','speaking')
      AND (leased_until IS NULL OR leased_until<=?) AND user_id=?`,
    [lease, store.now() + 15 * 60 * 1000, payload.id, payload.revision, store.now()]);
    if (!claimed.changes) return;
    try { await run(payload.id, lease); }
    finally {
      await store.db.run("UPDATE narrations SET leased_by=NULL,leased_until=NULL WHERE record_id=? AND leased_by=? AND user_id=?", [payload.id, lease]);
    }
  }

  /** Starts waiting jobs while slots are free, oldest first, passing over a record whose earlier job is still running. */
  function pump() {
    while (running.size + starting.size < concurrency) {
      const index = pending.findIndex(id => !running.has(id) && !starting.has(id));
      if (index < 0) return;
      const [id] = pending.splice(index, 1);
      if (id === undefined) return;
      // Reserve the slot before the first database await.
      starting.add(id);
      const task: Promise<void> = settle(id).finally(() => { tasks.delete(task); starting.delete(id); pump(); });
      tasks.add(task);
    }
  }

  function settle(id: string) {
    return run(id).catch((error: unknown) => {
      // Neither record content nor provider output reaches the log; only the failure class does.
      console.error(`narration ${id} failed: ${error instanceof Error ? error.name : "unknown"}`);
    }).then(async () => {
      // An automatic record job that failed with attempts left is tried again later, like a refused request.
      const asked = autoJobs.get(id);
      if (asked) {
        autoJobs.delete(id);
        const done = (await row(id));
        if (done?.status === "failed" && done.error !== "cancelled" && done.attempts < NARRATION_LIMITS.attempts) deferred.set(id, asked);
      }
      // Content that changed while this job ran is made next, after it.
      const next = followUps.get(id);
      if (next) { followUps.delete(id); auto(next.principal, id, next.style); }
    });
  }

  /** Requests that changed content while its job ran, made again once that job ends. */
  const followUps = new Map<string, { principal: Principal; style: NarrationStyle }>();

  /** Automatic record jobs in the queue, and automatic record requests to try again (`retryDeferred`); digests are not retried. */
  const autoJobs = new Map<string, { principal: Principal; style: NarrationStyle }>();

  const deferred = new Map<string, { principal: Principal; style: NarrationStyle }>();

  const autoRuns = new Set<Promise<void>>();

  /**
   * Asks for `id`'s audio on its own (a digest part on arrival, a new record), in the background and through the same queue,
   * limits and failure rules as a Listen request. Unchanged audio is kept; content that changes while its job runs is made again
   * after it. A refusal (daily limit, full queue, attempts used up, no key) is logged by its code and nothing else happens.
   */
  function auto(principal: Principal, id: string, style: NarrationStyle) {
    const work = (async () => {
      const source = (await options.lookup?.(id));
      let record: DashboardRecord;
      try { record = source?.record ?? (await store.get(id)); }
      catch (error) { if (error instanceof ApiError && error.status === 404) return; throw error; }
      if (source && !record.body.trim()) return;
      try {
        const result = await request(principal, record, false, style);
        if (result.started && !source) autoJobs.set(id, { principal, style });
        const current = (await row(id));
        if (!result.started && current && ACTIVE.has(current.status) && current.job_hash !== sourceHash(record)) followUps.set(id, { principal, style });
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        if (!source && RETRY_LATER.has(error.code)) deferred.set(id, { principal, style });
        console.log(`narration auto ${id} skipped: ${error.code}`);
      }
    })().catch((error: unknown) => { console.error(`narration auto ${id} failed: ${error instanceof Error ? error.name : "unknown"}`); });
    autoRuns.add(work);
    void work.finally(() => autoRuns.delete(work));
    return work;
  }

  /**
   * Asks again for the records whose automatic audio was refused for a passing reason or failed with attempts left, unless the
   * owner has since turned new-record audio off. Held in memory: a restart forgets them.
   */
  async function retryDeferred() {
    const entries = [...deferred];
    deferred.clear();
    if ((await autoSettings()).records === "off") return;
    for (const [id, { principal, style }] of entries) auto(principal, id, style);
  }

  /** The style this record's audio was last asked for, if any. */
  const styleOf = async (id: string): Promise<NarrationStyle | null> => (await row(id))?.style ?? null;

  /** Jobs cut off by a restart start again; they were already counted against the daily limit. */
  async function resume() {
    for (const value of (await store.db.all("SELECT record_id FROM narrations WHERE (status IN ('queued','scripting','speaking')) AND user_id=? ORDER BY requested_at", []))) {
      const { record_id } = z.object({ record_id: z.string() }).parse(value);
      if (!options.jobs) await set(record_id, { status: "queued" });
      await enqueue(record_id);
    }
  }

  /** Stops a queued or running job without counting an attempt: earlier audio stays ready, otherwise the job fails as `cancelled`; the script is kept. */
  async function cancel(record: DashboardRecord): Promise<NarrationState> {
    const current = (await row(record.id));
    if (current && ACTIVE.has(current.status)) {
      (await set(record.id, current.audio_file
        ? { status: "ready", style: current.audio_style, error: null, progress_done: null, progress_total: null }
        : { status: "failed", error: "cancelled", progress_done: null, progress_total: null }));
      running.get(record.id)?.controller.abort();
    }
    return await state(record);
  }

  async function remove(id: string) {
    const current = (await row(id));
    if (!current) return;
    if (ACTIVE.has(current.status)) throw new ApiError(409, "narration_busy", "A narration is being made for this record; delete it after it finishes");
    await removeFile(current.audio_file);
    (await store.db.run("DELETE FROM narrations WHERE (record_id=?) AND user_id=?", [id]));
  }

  async function idle() {
    do { await Promise.all([...autoRuns, ...tasks]); } while (tasks.size > 0 || autoRuns.size > 0 || pending.length > 0);
  }

  return { state, available, request, cancel, remove, prune, resume, audioFile, idle, deliver, allowance, ...settings, auto, retryDeferred, styleOf };
}
export * from "./narration-types";
export * from "./narration-prompts";
export * from "./narration-text";
export * from "./narration-audio";
