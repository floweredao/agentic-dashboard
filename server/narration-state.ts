import type { DashboardRecord, Narration, NarrationState, NarrationStatus } from "../shared/contracts";
import { type NarrationOptions, type Job, rowSchema, type Row, type Changes } from "./narration-types";
import { sourceHash } from "./narration-text";
import { accountActive } from "./work-guard";
const ACTIVE: ReadonlySet<NarrationStatus> = new Set(["queued", "scripting", "speaking"]);
export function createNarrationState(options: NarrationOptions, running: ReadonlyMap<string, Job>) {
  const { store, provider } = options;

  const now = () => new Date(store.now()).toISOString();

  const available = async () => provider !== null && await provider.available();


  async function row(id: string): Promise<Row | null> {
    const value = (await store.db.get("SELECT * FROM narrations WHERE (record_id=?) AND user_id=?", [id]));
    return value ? rowSchema.parse(value) : null;
  }

  async function set(id: string, changes: Changes) {
    if (!await accountActive(store)) return;
    const entries = Object.entries({ ...changes, updated_at: now() });
    const lease = running.get(id)?.lease;
    (await store.db.run(`UPDATE narrations SET ${entries.map(([key]) => `${key}=?`).join(",")} WHERE (record_id=?)
      ${lease ? "AND leased_by=?" : ""} AND user_id=?`, [...entries.map(([, value]) => value ?? null), id, ...(lease ? [lease] : [])]));
  }


  async function view(current: Row, record: DashboardRecord): Promise<Narration> {
    const audio = current.audio_file && current.audio_mime && current.audio_at ? {
      url: `${(await options.lookup?.(current.record_id))?.audioBase ?? `/api/v1/records/${current.record_id}`}/narration/audio?v=${current.audio_file.slice(37, 45)}`, mime: current.audio_mime,
      bytes: current.audio_bytes ?? 0, durationMs: current.audio_ms ?? 0, model: current.audio_model ?? "", voice: current.audio_voice ?? "",
      style: current.audio_style, createdAt: current.audio_at,
    } : null;
    const live = ACTIVE.has(current.status) ? running.get(current.record_id) ?? null : null;
    const stepAt = live?.stepAt != null ? new Date(live.stepAt).toISOString() : current.status === "queued" ? current.requested_at : null;
    return {
      recordId: current.record_id, status: current.status, style: current.style, stale: audio !== null && current.audio_hash !== sourceHash(record), stepAt,
      progress: current.progress_total === null ? null : { done: current.progress_done ?? 0, total: current.progress_total },
      waitUntil: live && live.waitUntil !== null ? new Date(live.waitUntil).toISOString() : null,
      ...(live && current.status === "scripting" && live.scriptTry !== null && live.scriptTry > 1 ? { scriptTry: live.scriptTry } : {}),
      attempts: current.attempts, error: current.error, requestedBy: current.requested_by, requestedAt: current.requested_at,
      updatedAt: current.updated_at, audio, script: current.script,
    };
  }

  async function state(record: DashboardRecord): Promise<NarrationState> {
    const current = (await row(record.id));
    return { narration: current ? (await view(current, record)) : null, available: await available() };
  }
  return { now, available, row, set, state };
}
