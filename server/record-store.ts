import { z } from "zod";
import { AGENT_RECORD_RULES, agentRecordIssues, DashboardRecordSchema, RecordInputSchema } from "../shared/contracts";
import type { DashboardRecord, RecordInput, RecordPatch } from "../shared/contracts";
import { ApiError, RecordFormatError } from "./errors";
import { agentCanRead, canonical, checkTitle, CONTINUABLE, type Principal } from "./record-policy";
import type { TenantDb } from "./tenant-db";
const stored = z.object({ data: z.string() });
export class RecordStore {
  constructor(readonly db: TenantDb, readonly now: () => number) {}
  async get(id: string): Promise<DashboardRecord> {
    const row = (await this.db.get("SELECT data FROM records WHERE (id=?) AND user_id=?", [id]));
    if (!row) throw new ApiError(404, "not_found", "Record not found");
    return DashboardRecordSchema.parse(JSON.parse(stored.parse(row).data));
  }
  private async relationships(record: RecordInput, id?: string) {
    for (const [target, kind] of [[record.projectId, "project"], [record.taskId, "task"]] as const) {
      if (!target) continue;
      const row = (await this.db.get("SELECT data FROM records WHERE (id=?) AND user_id=?", [target]));
      if (!row || target === id || DashboardRecordSchema.parse(JSON.parse(stored.parse(row).data)).kind !== kind) {
        throw new ApiError(400, "invalid_relationship", `Relationship must reference an existing ${kind}`);
      }
    }
    const previousId = z.string().optional().parse(record.fields.previousId);
    if (previousId !== undefined) {
      const row = (await this.db.get("SELECT data FROM records WHERE (id=?) AND user_id=?", [previousId]));
      if (!row || previousId === id || !CONTINUABLE.has(DashboardRecordSchema.parse(JSON.parse(stored.parse(row).data)).kind)) {
        throw new ApiError(400, "invalid_relationship", "previousId must reference an existing research, work-report, note or social record");
      }
    }
    if (record.kind === "task") {
      for (const target of z.array(z.string()).parse(record.fields.evidenceIds ?? [])) {
        const row = (await this.db.get("SELECT data FROM records WHERE (id=?) AND user_id=?", [target]));
        if (!row || ["project", "task"].includes(DashboardRecordSchema.parse(JSON.parse(stored.parse(row).data)).kind)) {
          throw new ApiError(400, "invalid_relationship", "Evidence must reference an existing record");
        }
      }
    }
  }
  protected async save(record: DashboardRecord) {
    (await this.db.run(`INSERT INTO records(id,data,created_by,project_id,task_id,user_id) VALUES(?,?,?,?,?,?)
      ON CONFLICT(user_id,id) DO UPDATE SET data=excluded.data,project_id=excluded.project_id,task_id=excluded.task_id`, [record.id, JSON.stringify(record), record.createdBy, record.projectId, record.taskId]));
    (await this.db.run("DELETE FROM evidence WHERE (task_id=?) AND user_id=?", [record.id]));
    if (record.kind === "task") for (const target of z.array(z.string()).parse(record.fields.evidenceIds ?? [])) {
      (await this.db.run("INSERT OR IGNORE INTO evidence(task_id,record_id,user_id) VALUES(?,?,?)", [record.id, target]));
    }
  }
  async replay(principal: Principal, requestId: string, requestPayload: unknown) {
    const previous = (await this.db.get("SELECT payload,response FROM requests WHERE (principal_id=? AND request_id=?) AND user_id=?", [principal.id, requestId]));
    if (!previous) return null;
    const entry = z.object({ payload: z.string(), response: z.string() }).parse(previous);
    if (entry.payload !== canonical(requestPayload)) throw new ApiError(409, "idempotency_conflict", "Request ID was already used with different content");
    return { record: DashboardRecordSchema.parse(JSON.parse(entry.response)), replayed: true };
  }
  async create(principal: Principal, requestId: string, input: RecordInput, requestPayload: unknown, initialReview?: DashboardRecord["reviewState"],
    sameContentWithinMs?: number) {
    return this.db.tx(async () => {
      const encoded = canonical(requestPayload);
      const previous = (await this.replay(principal, requestId, requestPayload));
      if (previous) return previous;
      if (sameContentWithinMs) {
        // A caller that re-sends the same content under a fresh requestId gets the earlier record back.
        const cutoff = new Date(this.now() - sameContentWithinMs).toISOString();
        const recent = (await this.db.get(`SELECT response FROM requests WHERE (principal_id=? AND payload=?
          AND json_extract(response,'$.createdAt')>=?) AND user_id=? ORDER BY json_extract(response,'$.createdAt') DESC LIMIT 1`, [principal.id, encoded, cutoff]));
        if (recent) return { record: DashboardRecordSchema.parse(JSON.parse(z.object({ response: z.string() }).parse(recent).response)), replayed: true };
      }
      (await this.relationships(input));
      if (principal.source !== "manual") {
        checkTitle(input.title);
        const issues = agentRecordIssues(input);
        if (issues.length) throw new RecordFormatError(issues, "Record does not follow the agent record format; fix every item and save again with a new request ID");
      }
      const timestamp = new Date(this.now()).toISOString();
      const record: DashboardRecord = { ...input, id: crypto.randomUUID(), source: principal.source, createdBy: principal.id,
        reviewState: initialReview ?? (principal.source === "manual" ? "approved" : "pending"), archivedAt: null, createdAt: timestamp, updatedAt: timestamp, version: 1 };
      (await this.save(record));
      (await this.db.run("INSERT INTO requests(principal_id,request_id,payload,response,user_id) VALUES(?,?,?,?,?)", [principal.id, requestId, encoded, JSON.stringify(record)]));
      return { record, replayed: false };
    });
  }
  async patch(id: string, patch: RecordPatch) {
    return this.db.tx(async () => {
      const current = (await this.get(id));
      if (current.version !== patch.expectedVersion) throw new ApiError(409, "version_conflict", "Record has changed; reload before editing");
      const { archived, reviewState, ...changes } = patch.changes;
      const { source, createdBy, createdAt, updatedAt, version, archivedAt, reviewState: oldReview, id: oldId, ...oldInput } = current;
      const input = RecordInputSchema.parse({ ...oldInput, ...changes });
      (await this.relationships(input, id));
      const timestamp = new Date(this.now()).toISOString();
      const record: DashboardRecord = { ...current, ...input, reviewState: reviewState ?? current.reviewState,
        archivedAt: archived === undefined ? current.archivedAt : archived ? timestamp : null, updatedAt: timestamp, version: current.version + 1 };
      (await this.save(record));
      return record;
    });
  }
  /** An agent edits only its own record, cannot review or archive, and the owner re-confirms the result. */
  async agentPatch(principal: Principal, id: string, patch: RecordPatch) {
    return this.db.tx(async () => {
      const current = (await this.get(id));
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
      if (issues.length) throw new RecordFormatError(issues, "Edit does not follow the agent record format; fix every item and send it again");
      (await this.relationships(input, id));
      const record: DashboardRecord = { ...current, ...input, reviewState: "pending", updatedAt: new Date(this.now()).toISOString(), version: current.version + 1 };
      (await this.save(record));
      return record;
    });
  }
}
