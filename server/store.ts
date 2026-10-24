import { z } from "zod";
import { DashboardRecordSchema, DateSchema, RecordKindSchema, ReviewStateSchema, TRASH_RETENTION_DAYS } from "../shared/contracts";
import type { DashboardRecord, RecordDocument, RecordKind, TrashItem } from "../shared/contracts";
import { ApiError } from "./errors";
import { RecordStore } from "./record-store";
import { recordChanged } from "./record-sync";
import { AGENT_READABLE_KINDS, SHARED_WORK_KINDS, agentView, CONTINUABLE, type Principal } from "./record-policy";
import { openSql } from "./db";
import { TenantDb } from "./tenant-db";
import { migrate } from "./migrations";
import { ControlDb } from "./control-db";
export { agentCanRead, agentView, canonical, AGENT_READABLE_KINDS, SHARED_WORK_KINDS, type Principal } from "./record-policy";
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
const documentRow = z.object({ html: z.string(), bytes: z.number(), updated_by: z.string(), updated_at: z.string() });
const RETENTION_MS = TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;
export class Store extends RecordStore {
  constructor(db: TenantDb, now: () => number, readonly control = new ControlDb(db.sql)) { super(db, now); }
  static async open(path: string, now: () => number = Date.now) {
    const sql = await openSql(path);
    await migrate(sql);
    return new Store(new TenantDb(sql, "local"), now);
  }
  async delete(id: string, expectedVersion: number) {
    await this.db.tx(async () => {
      const current = (await this.get(id));
      if (current.version !== expectedVersion) throw new ApiError(409, "version_conflict", "Record has changed; reload before deleting");
      const timestamp = new Date(this.now()).toISOString();
      // Re-save every referencing record with a new version so no record points at a missing id and stale editors get 409.
      const rows = (await this.db.all(`SELECT id FROM records WHERE (id<>? AND (project_id=? OR task_id=? OR (kind='task'
        AND EXISTS (SELECT 1 FROM json_each(data,'$.fields.evidenceIds') WHERE value=?)) OR json_extract(data,'$.fields.previousId')=?)) AND user_id=?`, [id, id, id, id, id]));
      for (const row of rows) {
        const record = (await this.get(z.object({ id: z.string() }).parse(row).id));
        const evidenceIds = z.array(z.string()).optional().parse(record.fields.evidenceIds);
        const { previousId, ...rest } = record.fields;
        const fields = previousId === id ? rest : record.fields;
        (await this.save({ ...record, projectId: record.projectId === id ? null : record.projectId, taskId: record.taskId === id ? null : record.taskId,
          fields: record.kind === "task" && evidenceIds ? { ...fields, evidenceIds: evidenceIds.filter(target => target !== id) } : fields,
          updatedAt: timestamp, version: record.version + 1 }));
      }
      (await this.db.run("DELETE FROM evidence WHERE (task_id=? OR record_id=?) AND user_id=?", [id, id]));
      // Forget the creation snapshot so the same requestId or captured URL creates a new record.
      (await this.db.run("DELETE FROM requests WHERE (json_extract(response,'$.id')=?) AND user_id=?", [id]));
      await this.db.run("DELETE FROM shares WHERE record_id=? AND user_id=?", [id]);
      (await this.db.run("DELETE FROM records WHERE (id=?) AND user_id=?", [id]));
      await recordChanged(this.db, id);
      (await this.db.run("INSERT OR REPLACE INTO trash(id,data,created_by,deleted_at,user_id) VALUES(?,?,?,?,?)", [id, JSON.stringify(current), current.createdBy, timestamp]));
    });
  }
  private async kindOf(id: string): Promise<RecordKind | null> {
    const row = (await this.db.get("SELECT data FROM records WHERE (id=?) AND user_id=?", [id]));
    return row ? DashboardRecordSchema.parse(JSON.parse(stored.parse(row).data)).kind : null;
  }
  /** Permanently removes trashed records whose retention period has ended; returns how many. */
  async purgeTrash(): Promise<number> {
    const cutoff = new Date(this.now() - RETENTION_MS).toISOString();
    const purged = (await this.db.run("DELETE FROM trash WHERE (deleted_at<=?) AND user_id=?", [cutoff])).changes;
    if (purged) (await this.dropOrphanComments());
    return purged;
  }
  /** A trashed record keeps its timeline and document for a restore; once it is gone for good, so are they. */
  private async dropOrphanComments() {
    await this.db.run(`DELETE FROM comments WHERE record_id NOT IN (SELECT id FROM records WHERE records.user_id=comments.user_id)
      AND record_id NOT IN (SELECT id FROM trash WHERE trash.user_id=comments.user_id) AND user_id=?`);
    await this.db.run(`DELETE FROM documents WHERE record_id NOT IN (SELECT id FROM records WHERE records.user_id=documents.user_id)
      AND record_id NOT IN (SELECT id FROM trash WHERE trash.user_id=documents.user_id) AND user_id=?`);
  }
  async document(id: string): Promise<RecordDocument | null> {
    const row = (await this.db.get("SELECT html,bytes,updated_by,updated_at FROM documents WHERE (record_id=?) AND user_id=?", [id]));
    if (!row) return null;
    const value = documentRow.parse(row);
    return { html: value.html, bytes: value.bytes, updatedBy: value.updated_by, updatedAt: value.updated_at };
  }
  async putDocument(id: string, html: string, by: Principal): Promise<RecordDocument> {
    const timestamp = new Date(this.now()).toISOString();
    const bytes = new TextEncoder().encode(html).byteLength;
    (await this.db.run(`INSERT INTO documents(record_id,html,bytes,updated_by,updated_at,user_id) VALUES(?,?,?,?,?,?)
      ON CONFLICT(user_id,record_id) DO UPDATE SET html=excluded.html, bytes=excluded.bytes, updated_by=excluded.updated_by, updated_at=excluded.updated_at`, [id, html, bytes, by.source, timestamp]));
    return { html, bytes, updatedBy: by.source, updatedAt: timestamp };
  }
  async deleteDocument(id: string) { (await this.db.run("DELETE FROM documents WHERE (record_id=?) AND user_id=?", [id])); }
  /** Sets a task or project status from a timeline entry, as a new version. */
  async setStatus(id: string, status: string): Promise<DashboardRecord> {
    const current = (await this.get(id));
    const record: DashboardRecord = { ...current, status, updatedAt: new Date(this.now()).toISOString(), version: current.version + 1 };
    (await this.save(record));
    return record;
  }
  async trashList(): Promise<TrashItem[]> {
    (await this.purgeTrash());
    return (await this.db.all("SELECT data,deleted_at FROM trash WHERE user_id=? ORDER BY deleted_at DESC,id DESC", [])).map(value => {
      const row = trashRow.parse(value);
      return { record: DashboardRecordSchema.parse(JSON.parse(row.data)), deletedAt: row.deleted_at,
        purgeAt: new Date(Date.parse(row.deleted_at) + RETENTION_MS).toISOString() };
    });
  }
  /** Puts a trashed record back, dropping relations whose targets no longer exist. */
  async restore(id: string): Promise<DashboardRecord> {
    return this.db.tx(async () => {
      const value = (await this.db.get("SELECT data,deleted_at FROM trash WHERE (id=?) AND user_id=?", [id]));
      if (!value) throw new ApiError(404, "not_found", "Trashed record not found");
      const trashed = DashboardRecordSchema.parse(JSON.parse(trashRow.parse(value).data));
      const { previousId, ...rest } = trashed.fields;
      const keepPrevious = typeof previousId === "string" && previousId !== id && CONTINUABLE.has((await this.kindOf(previousId)) ?? "project");
      const fields: DashboardRecord["fields"] = keepPrevious ? { ...rest, previousId } : rest;
      const evidenceIds = z.array(z.string()).optional().parse(trashed.fields.evidenceIds);
      if (trashed.kind === "task" && evidenceIds) {
        const kept: string[] = [];
        for (const target of evidenceIds) {
          const kind = await this.kindOf(target);
          if (kind !== null && kind !== "project" && kind !== "task") kept.push(target);
        }
        fields.evidenceIds = kept;
      }
      const record: DashboardRecord = { ...trashed, fields,
        projectId: trashed.projectId && (await this.kindOf(trashed.projectId)) === "project" ? trashed.projectId : null,
        taskId: trashed.taskId && (await this.kindOf(trashed.taskId)) === "task" ? trashed.taskId : null,
        updatedAt: new Date(this.now()).toISOString(), version: trashed.version + 1 };
      (await this.save(record));
      (await this.db.run("DELETE FROM trash WHERE (id=?) AND user_id=?", [id]));
      return record;
    });
  }
  async destroy(id: string) {
    if ((await this.db.run("DELETE FROM trash WHERE (id=?) AND user_id=?", [id])).changes === 0) throw new ApiError(404, "not_found", "Trashed record not found");
    (await this.dropOrphanComments());
  }
  async emptyTrash() { (await this.db.run("DELETE FROM trash WHERE user_id=?", [])); (await this.dropOrphanComments()); }
  /** Owner list, or with `reader` the records that agent may read (agentCanRead), shown through agentView. */
  async list(raw: Record<string, string>, reader?: Principal) {
    const query = querySchema.parse(raw);
    if (query.dueFrom && query.dueTo && query.dueFrom > query.dueTo) throw new ApiError(400, "invalid_query", "dueFrom must not follow dueTo");
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    if (reader) {
      conditions.push(`(created_by=? OR (archived_at IS NULL AND (kind IN (${AGENT_READABLE_KINDS.map(() => "?").join(",")})
        OR (created_by='owner' AND kind IN (${SHARED_WORK_KINDS.map(() => "?").join(",")})))))`);
      params.push(reader.id, ...AGENT_READABLE_KINDS, ...SHARED_WORK_KINDS);
    }
    for (const key of ["kind", "status", "reviewState", "projectId"] as const) if (query[key]) {
      conditions.push(`${key === "kind" ? "kind" : `json_extract(data,'$.${key}')`}=?`); params.push(query[key]);
    }
    if (query.archived !== "all") conditions.push(`archived_at IS ${query.archived === "true" ? "NOT " : ""}NULL`);
    if (query.q) { conditions.push("(instr(lower(json_extract(data,'$.title')),lower(?))>0 OR instr(lower(json_extract(data,'$.body')),lower(?))>0)"); params.push(query.q, query.q); }
    if (query.dueFrom) { conditions.push("json_extract(data,'$.dueDate')>=?"); params.push(query.dueFrom); }
    if (query.dueTo) { conditions.push("json_extract(data,'$.dueDate')<=?"); params.push(query.dueTo); }
    if (query.cursor) {
      let decoded: unknown;
      try { decoded = JSON.parse(Buffer.from(query.cursor, "base64url").toString()); }
      catch (error) { if (error instanceof SyntaxError) throw new ApiError(400, "invalid_cursor", "Invalid cursor"); throw error; }
      const cursor = cursorSchema.parse(decoded);
      conditions.push("(created_at < ? OR (created_at=? AND id<?))");
      params.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }

    const rows = (await this.db.all(`SELECT data FROM records WHERE (${conditions.length ? conditions.join(" AND ") : "1=1"}) AND user_id=?
      ORDER BY created_at DESC,id DESC LIMIT ${query.limit + 1}`, [...params]));
    const records = rows.map(row => DashboardRecordSchema.parse(JSON.parse(stored.parse(row).data))).map(record => reader ? agentView(reader, record) : record);
    const items = records.slice(0, query.limit);
    const last = items.at(-1);
    return { items, nextCursor: records.length > query.limit && last ? Buffer.from(JSON.stringify({ createdAt: last.createdAt, id: last.id })).toString("base64url") : null };
  }
  close() { return this.db.sql.close(); }
}
