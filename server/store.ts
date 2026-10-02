import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { AGENT_RECORD_RULES, agentRecordIssues, DashboardRecordSchema, DateSchema, RecordInputSchema, RecordKindSchema, ReviewStateSchema, TITLE_MAX_WIDTH, titleWidth, TRASH_RETENTION_DAYS } from "../shared/contracts";
import type { DashboardRecord, RecordInput, RecordKind, RecordPatch, Source, TrashItem } from "../shared/contracts";
import { ApiError } from "./errors";

export interface Principal { readonly id: string; readonly source: Source }
const stored = z.object({ data: z.string() });
const querySchema = z.object({
  kind: RecordKindSchema.optional(), status: z.string().min(1).max(50).optional(),
  reviewState: ReviewStateSchema.optional(), archived: z.enum(["false", "true", "all"]).default("false"),
  projectId: z.string().uuid().optional(), q: z.string().max(200).optional(),
  dueFrom: DateSchema.optional(), dueTo: DateSchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(50), cursor: z.string().max(512).optional(),
}).strict();
const cursorSchema = z.object({ createdAt: z.iso.datetime(), id: z.string().uuid() }).strict();
const trashRow = z.object({ data: z.string(), deleted_at: z.string() });
const RETENTION_MS = TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const CONTINUABLE: ReadonlySet<RecordKind> = new Set(["research", "work-report", "note", "social"]);
/** Kinds every agent may read whoever saved them, while unarchived. Tasks, projects and archived records stay with their creator and the owner. */
export const AGENT_READABLE_KINDS = ["research", "work-report", "note", "social"] as const;
/** Every registered agent works with the owner on the Work tab: it also reads the owner's unarchived tasks and projects (never edits them). */
export const SHARED_WORK_KINDS = ["task", "project"] as const;
export function agentCanRead(principal: Principal, record: DashboardRecord) {
  if (record.createdBy === principal.id) return true;
  if (record.archivedAt !== null) return false;
  return AGENT_READABLE_KINDS.some(kind => kind === record.kind)
    || (record.createdBy === "owner" && SHARED_WORK_KINDS.some(kind => kind === record.kind));
}
/** What an agent sees of a record: everything, except the owner's personal notes on records it did not create. */
export function agentView(principal: Principal, record: DashboardRecord): DashboardRecord {
  if (record.createdBy === principal.id) return record;
  const { personalNotes: _private, ...fields } = record.fields;
  return { ...record, fields };
}
function checkTitle(title: string) {
  const width = titleWidth(title.trim());
  if (width > TITLE_MAX_WIDTH) throw new ApiError(400, "title_too_long", `Title is ${width} columns; keep it within ${TITLE_MAX_WIDTH} (Hangul and CJK count 2, about 18 Korean characters). Keep the subject and the key point, drop dates, parentheses and qualifiers, and move detail to fields.summary.`);
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
export class Store {
  readonly db: Database;
  constructor(path: string, readonly now: () => number) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS principals(id TEXT PRIMARY KEY, source TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT, revoked_at TEXT, last_used_at TEXT);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, principal_id TEXT NOT NULL REFERENCES principals(id), csrf TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)), created_by TEXT NOT NULL REFERENCES principals(id),
        project_id TEXT REFERENCES records(id), task_id TEXT REFERENCES records(id));
      CREATE TABLE IF NOT EXISTS evidence(task_id TEXT NOT NULL REFERENCES records(id), record_id TEXT NOT NULL REFERENCES records(id), PRIMARY KEY(task_id,record_id));
      CREATE TABLE IF NOT EXISTS requests(principal_id TEXT NOT NULL REFERENCES principals(id), request_id TEXT NOT NULL, payload TEXT NOT NULL, response TEXT NOT NULL,
        PRIMARY KEY(principal_id,request_id));
      CREATE TABLE IF NOT EXISTS trash(id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)), created_by TEXT NOT NULL REFERENCES principals(id),
        deleted_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS records_project ON records(project_id);
      CREATE INDEX IF NOT EXISTS records_task ON records(task_id);
      CREATE TABLE IF NOT EXISTS comments(id TEXT PRIMARY KEY, record_id TEXT NOT NULL, author TEXT NOT NULL REFERENCES principals(id),
        source TEXT NOT NULL, body TEXT NOT NULL, reply_to TEXT REFERENCES comments(id), status TEXT, created_at TEXT NOT NULL,
        seen_at TEXT, seen_by TEXT, done_at TEXT, done_by TEXT, request_id TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(author,request_id));
      CREATE INDEX IF NOT EXISTS comments_record ON comments(record_id, created_at);`);
  }
  get(id: string): DashboardRecord {
    const row = this.db.query("SELECT data FROM records WHERE id=?").get(id);
    if (!row) throw new ApiError(404, "not_found", "Record not found");
    return DashboardRecordSchema.parse(JSON.parse(stored.parse(row).data));
  }
  private relationships(record: RecordInput, id?: string) {
    for (const [target, kind] of [[record.projectId, "project"], [record.taskId, "task"]] as const) {
      if (!target) continue;
      const row = this.db.query("SELECT data FROM records WHERE id=?").get(target);
      if (!row || target === id || DashboardRecordSchema.parse(JSON.parse(stored.parse(row).data)).kind !== kind) {
        throw new ApiError(400, "invalid_relationship", `Relationship must reference an existing ${kind}`);
      }
    }
    const previousId = z.string().optional().parse(record.fields.previousId);
    if (previousId !== undefined) {
      const row = this.db.query("SELECT data FROM records WHERE id=?").get(previousId);
      if (!row || previousId === id || !CONTINUABLE.has(DashboardRecordSchema.parse(JSON.parse(stored.parse(row).data)).kind)) {
        throw new ApiError(400, "invalid_relationship", "previousId must reference an existing research, work-report, note or social record");
      }
    }
    if (record.kind === "task") {
      for (const target of z.array(z.string()).parse(record.fields.evidenceIds ?? [])) {
        const row = this.db.query("SELECT data FROM records WHERE id=?").get(target);
        if (!row || ["project", "task"].includes(DashboardRecordSchema.parse(JSON.parse(stored.parse(row).data)).kind)) {
          throw new ApiError(400, "invalid_relationship", "Evidence must reference an existing record");
        }
      }
    }
  }
  private save(record: DashboardRecord) {
    this.db.query(`INSERT INTO records(id,data,created_by,project_id,task_id) VALUES(?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET data=excluded.data,project_id=excluded.project_id,task_id=excluded.task_id`).run(
      record.id, JSON.stringify(record), record.createdBy, record.projectId, record.taskId);
    this.db.query("DELETE FROM evidence WHERE task_id=?").run(record.id);
    if (record.kind === "task") for (const target of z.array(z.string()).parse(record.fields.evidenceIds ?? [])) {
      this.db.query("INSERT OR IGNORE INTO evidence(task_id,record_id) VALUES(?,?)").run(record.id, target);
    }
  }
  replay(principal: Principal, requestId: string, requestPayload: unknown) {
    const previous = this.db.query("SELECT payload,response FROM requests WHERE principal_id=? AND request_id=?").get(principal.id, requestId);
    if (!previous) return null;
    const entry = z.object({ payload: z.string(), response: z.string() }).parse(previous);
    if (entry.payload !== canonical(requestPayload)) throw new ApiError(409, "idempotency_conflict", "Request ID was already used with different content");
    return { record: DashboardRecordSchema.parse(JSON.parse(entry.response)), replayed: true };
  }
  create(principal: Principal, requestId: string, input: RecordInput, requestPayload: unknown, initialReview?: DashboardRecord["reviewState"],
    sameContentWithinMs?: number) {
    return this.db.transaction(() => {
      const encoded = canonical(requestPayload);
      const previous = this.replay(principal, requestId, requestPayload);
      if (previous) return previous;
      if (sameContentWithinMs) {
        // A caller that re-sends the same content under a fresh requestId gets the earlier record back.
        const cutoff = new Date(this.now() - sameContentWithinMs).toISOString();
        const recent = this.db.query(`SELECT response FROM requests WHERE principal_id=? AND payload=?
          AND json_extract(response,'$.createdAt')>=? ORDER BY json_extract(response,'$.createdAt') DESC LIMIT 1`).get(principal.id, encoded, cutoff);
        if (recent) return { record: DashboardRecordSchema.parse(JSON.parse(z.object({ response: z.string() }).parse(recent).response)), replayed: true };
      }
      this.relationships(input);
      if (principal.source !== "manual") {
        checkTitle(input.title);
        const issues = agentRecordIssues(input);
        if (issues.length) throw new ApiError(400, "record_incomplete", `Record does not follow the agent record format; fix every item and save again with a new request ID: ${issues.join("; ")}`);
      }
      const timestamp = new Date(this.now()).toISOString();
      const record: DashboardRecord = { ...input, id: crypto.randomUUID(), source: principal.source, createdBy: principal.id,
        reviewState: initialReview ?? (principal.source === "manual" ? "approved" : "pending"), archivedAt: null, createdAt: timestamp, updatedAt: timestamp, version: 1 };
      this.save(record);
      this.db.query("INSERT INTO requests VALUES(?,?,?,?)").run(principal.id, requestId, encoded, JSON.stringify(record));
      return { record, replayed: false };
    }).immediate();
  }
  patch(id: string, patch: RecordPatch) {
    return this.db.transaction(() => {
      const current = this.get(id);
      if (current.version !== patch.expectedVersion) throw new ApiError(409, "version_conflict", "Record has changed; reload before editing");
      const { archived, reviewState, ...changes } = patch.changes;
      const { source, createdBy, createdAt, updatedAt, version, archivedAt, reviewState: oldReview, id: oldId, ...oldInput } = current;
      const input = RecordInputSchema.parse({ ...oldInput, ...changes });
      this.relationships(input, id);
      const timestamp = new Date(this.now()).toISOString();
      const record: DashboardRecord = { ...current, ...input, reviewState: reviewState ?? current.reviewState,
        archivedAt: archived === undefined ? current.archivedAt : archived ? timestamp : null, updatedAt: timestamp, version: current.version + 1 };
      this.save(record);
      return record;
    }).immediate();
  }
  /** An agent edits only its own record, cannot review or archive, and the owner re-confirms the result. */
  agentPatch(principal: Principal, id: string, patch: RecordPatch) {
    return this.db.transaction(() => {
      const current = this.get(id);
      if (current.createdBy !== principal.id) {
        if (!agentCanRead(principal, current)) throw new ApiError(404, "not_found", "Record not found");
        throw new ApiError(403, "forbidden", "Agents edit only records they created; save a new record that continues this one with fields.previousId instead");
      }
      const { archived, reviewState, ...changes } = patch.changes;
      if (archived !== undefined || reviewState !== undefined) throw new ApiError(403, "forbidden", "Only the owner can confirm, archive or restore a record");
      if (current.version !== patch.expectedVersion) throw new ApiError(409, "version_conflict", "Record has changed; reload before editing");
      const allowed: readonly string[] = AGENT_RECORD_RULES[current.kind].fields;
      // Owner marks, server keys and legacy keys already on the record keep their values, so a read record round-trips.
      const preserved = Object.fromEntries(Object.entries(current.fields).filter(([key]) => !allowed.includes(key)));
      const supplied = changes.fields ?? current.fields;
      const agentFields = Object.fromEntries(Object.entries(supplied).filter(([key]) => !(key in preserved)));
      const { source, createdBy, createdAt, updatedAt, version, archivedAt, reviewState: oldReview, id: oldId, ...oldInput } = current;
      const input = RecordInputSchema.parse({ ...oldInput, ...changes, fields: { ...agentFields, ...preserved } });
      checkTitle(input.title);
      const issues = agentRecordIssues({ ...input, fields: agentFields });
      if (issues.length) throw new ApiError(400, "record_incomplete", `Edit does not follow the agent record format; fix every item and send it again: ${issues.join("; ")}`);
      this.relationships(input, id);
      const record: DashboardRecord = { ...current, ...input, reviewState: "pending", updatedAt: new Date(this.now()).toISOString(), version: current.version + 1 };
      this.save(record);
      return record;
    }).immediate();
  }
  delete(id: string, expectedVersion: number) {
    this.db.transaction(() => {
      const current = this.get(id);
      if (current.version !== expectedVersion) throw new ApiError(409, "version_conflict", "Record has changed; reload before deleting");
      const timestamp = new Date(this.now()).toISOString();
      // Re-save every referencing record with a new version so no record points at a missing id and stale editors get 409.
      const rows = this.db.query(`SELECT id FROM records WHERE id<>? AND (project_id=? OR task_id=? OR (json_extract(data,'$.kind')='task'
        AND EXISTS (SELECT 1 FROM json_each(data,'$.fields.evidenceIds') WHERE value=?)) OR json_extract(data,'$.fields.previousId')=?)`).all(id, id, id, id, id);
      for (const row of rows) {
        const record = this.get(z.object({ id: z.string() }).parse(row).id);
        const evidenceIds = z.array(z.string()).optional().parse(record.fields.evidenceIds);
        const { previousId, ...rest } = record.fields;
        const fields = previousId === id ? rest : record.fields;
        this.save({ ...record, projectId: record.projectId === id ? null : record.projectId, taskId: record.taskId === id ? null : record.taskId,
          fields: record.kind === "task" && evidenceIds ? { ...fields, evidenceIds: evidenceIds.filter(target => target !== id) } : fields,
          updatedAt: timestamp, version: record.version + 1 });
      }
      this.db.query("DELETE FROM evidence WHERE task_id=? OR record_id=?").run(id, id);
      // Forget the creation snapshot so the same requestId or captured URL creates a new record.
      this.db.query("DELETE FROM requests WHERE json_extract(response,'$.id')=?").run(id);
      this.db.query("DELETE FROM records WHERE id=?").run(id);
      this.db.query("INSERT OR REPLACE INTO trash(id,data,created_by,deleted_at) VALUES(?,?,?,?)").run(id, JSON.stringify(current), current.createdBy, timestamp);
    }).immediate();
  }
  private kindOf(id: string): RecordKind | null {
    const row = this.db.query("SELECT data FROM records WHERE id=?").get(id);
    return row ? DashboardRecordSchema.parse(JSON.parse(stored.parse(row).data)).kind : null;
  }
  /** Permanently removes trashed records whose retention period has ended; returns how many. */
  purgeTrash(): number {
    const cutoff = new Date(this.now() - RETENTION_MS).toISOString();
    const purged = this.db.query("DELETE FROM trash WHERE deleted_at<=?").run(cutoff).changes;
    if (purged) this.dropOrphanComments();
    return purged;
  }
  /** A trashed record keeps its timeline for a restore; once it is gone for good, so are its comments. */
  private dropOrphanComments() {
    this.db.run(`DELETE FROM comments WHERE record_id NOT IN (SELECT id FROM records) AND record_id NOT IN (SELECT id FROM trash)`);
  }
  /** Sets a task or project status from a timeline entry, as a new version. */
  setStatus(id: string, status: string): DashboardRecord {
    const current = this.get(id);
    const record: DashboardRecord = { ...current, status, updatedAt: new Date(this.now()).toISOString(), version: current.version + 1 };
    this.save(record);
    return record;
  }
  trashList(): TrashItem[] {
    this.purgeTrash();
    return this.db.query("SELECT data,deleted_at FROM trash ORDER BY deleted_at DESC,id DESC").all().map(value => {
      const row = trashRow.parse(value);
      return { record: DashboardRecordSchema.parse(JSON.parse(row.data)), deletedAt: row.deleted_at,
        purgeAt: new Date(Date.parse(row.deleted_at) + RETENTION_MS).toISOString() };
    });
  }
  /** Puts a trashed record back, dropping relations whose targets no longer exist. */
  restore(id: string): DashboardRecord {
    return this.db.transaction(() => {
      const value = this.db.query("SELECT data,deleted_at FROM trash WHERE id=?").get(id);
      if (!value) throw new ApiError(404, "not_found", "Trashed record not found");
      const trashed = DashboardRecordSchema.parse(JSON.parse(trashRow.parse(value).data));
      const { previousId, ...rest } = trashed.fields;
      const keepPrevious = typeof previousId === "string" && previousId !== id && CONTINUABLE.has(this.kindOf(previousId) ?? "project");
      const fields: DashboardRecord["fields"] = keepPrevious ? { ...rest, previousId } : rest;
      const evidenceIds = z.array(z.string()).optional().parse(trashed.fields.evidenceIds);
      if (trashed.kind === "task" && evidenceIds) fields.evidenceIds = evidenceIds.filter(target => {
        const kind = this.kindOf(target);
        return kind !== null && kind !== "project" && kind !== "task";
      });
      const record: DashboardRecord = { ...trashed, fields,
        projectId: trashed.projectId && this.kindOf(trashed.projectId) === "project" ? trashed.projectId : null,
        taskId: trashed.taskId && this.kindOf(trashed.taskId) === "task" ? trashed.taskId : null,
        updatedAt: new Date(this.now()).toISOString(), version: trashed.version + 1 };
      this.save(record);
      this.db.query("DELETE FROM trash WHERE id=?").run(id);
      return record;
    }).immediate();
  }
  destroy(id: string) {
    if (this.db.query("DELETE FROM trash WHERE id=?").run(id).changes === 0) throw new ApiError(404, "not_found", "Trashed record not found");
    this.dropOrphanComments();
  }
  emptyTrash() { this.db.query("DELETE FROM trash").run(); this.dropOrphanComments(); }
  /** Owner list, or with `reader` the records that agent may read (agentCanRead), shown through agentView. */
  list(raw: Record<string, string>, reader?: Principal) {
    const query = querySchema.parse(raw);
    if (query.dueFrom && query.dueTo && query.dueFrom > query.dueTo) throw new ApiError(400, "invalid_query", "dueFrom must not follow dueTo");
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    if (reader) {
      conditions.push(`(created_by=? OR (json_extract(data,'$.archivedAt') IS NULL AND (json_extract(data,'$.kind') IN (${AGENT_READABLE_KINDS.map(() => "?").join(",")})
        OR (created_by='owner' AND json_extract(data,'$.kind') IN (${SHARED_WORK_KINDS.map(() => "?").join(",")})))))`);
      params.push(reader.id, ...AGENT_READABLE_KINDS, ...SHARED_WORK_KINDS);
    }
    for (const key of ["kind", "status", "reviewState", "projectId"] as const) if (query[key]) {
      conditions.push(`json_extract(data,'$.${key}')=?`); params.push(query[key]);
    }
    if (query.archived !== "all") conditions.push(`json_extract(data,'$.archivedAt') IS ${query.archived === "true" ? "NOT " : ""}NULL`);
    if (query.q) { conditions.push("(instr(lower(json_extract(data,'$.title')),lower(?))>0 OR instr(lower(json_extract(data,'$.body')),lower(?))>0)"); params.push(query.q, query.q); }
    if (query.dueFrom) { conditions.push("json_extract(data,'$.dueDate')>=?"); params.push(query.dueFrom); }
    if (query.dueTo) { conditions.push("json_extract(data,'$.dueDate')<=?"); params.push(query.dueTo); }
    if (query.cursor) {
      let decoded: unknown;
      try { decoded = JSON.parse(Buffer.from(query.cursor, "base64url").toString()); }
      catch (error) { if (error instanceof SyntaxError) throw new ApiError(400, "invalid_cursor", "Invalid cursor"); throw error; }
      const cursor = cursorSchema.parse(decoded);
      conditions.push("(json_extract(data,'$.createdAt') < ? OR (json_extract(data,'$.createdAt')=? AND id<?))");
      params.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    params.push(query.limit + 1);
    const rows = this.db.query(`SELECT data FROM records ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
      ORDER BY json_extract(data,'$.createdAt') DESC,id DESC LIMIT ?`).all(...params);
    const records = rows.map(row => DashboardRecordSchema.parse(JSON.parse(stored.parse(row).data))).map(record => reader ? agentView(reader, record) : record);
    const items = records.slice(0, query.limit);
    const last = items.at(-1);
    return { items, nextCursor: records.length > query.limit && last ? Buffer.from(JSON.stringify({ createdAt: last.createdAt, id: last.id })).toString("base64url") : null };
  }
  close() { this.db.close(); }
}
