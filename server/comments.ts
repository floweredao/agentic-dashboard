import { z } from "zod";
import { CommentSchema, CommentStateSchema, WORK_STATUSES } from "../shared/contracts";
import type { Comment, CommentInput, DashboardRecord, QueuedComment } from "../shared/contracts";
import { ApiError } from "./errors";
import { agentCanRead, canonical, SHARED_WORK_KINDS, type Principal, type Store } from "./store";

const rowSchema = z.object({
  id: z.string(), record_id: z.string(), author: z.string(), source: z.string(), body: z.string(), reply_to: z.string().nullable(),
  status: z.string().nullable(), created_at: z.string(), seen_at: z.string().nullable(), seen_by: z.string().nullable(),
  done_at: z.string().nullable(), done_by: z.string().nullable(), payload: z.string(),
});
const queuedRow = rowSchema.extend({ title: z.string() });
const querySchema = z.object({ recordId: z.string().uuid().optional(), state: CommentStateSchema.optional() }).strict();
const COLUMNS = "c.id,c.record_id,c.author,c.source,c.body,c.reply_to,c.status,c.created_at,c.seen_at,c.seen_by,c.done_at,c.done_by,c.payload";

function toComment(value: unknown): Comment {
  const row = rowSchema.parse(value);
  return CommentSchema.parse({ id: row.id, recordId: row.record_id, author: row.author, source: row.source, body: row.body,
    replyTo: row.reply_to, status: row.status, createdAt: row.created_at, seenAt: row.seen_at, seenBy: row.seen_by,
    doneAt: row.done_at, doneBy: row.done_by });
}
const isWork = (record: DashboardRecord) => SHARED_WORK_KINDS.some(kind => kind === record.kind);
const stateCondition = (state: "new" | "open" | "all") =>
  state === "new" ? " AND c.seen_at IS NULL AND c.done_at IS NULL" : state === "open" ? " AND c.done_at IS NULL" : "";

/**
 * Timelines on tasks and projects. The owner comments on any of them; an agent reports on the items it may read and changes
 * status only on its own. An agent's queue is the owner's comments on its own items and on the owner's items: it marks
 * them seen and done, and replies.
 */
export class Comments {
  constructor(readonly store: Store) {}

  private find(id: string): Comment {
    const row = this.store.db.query(`SELECT ${COLUMNS} FROM comments c WHERE c.id=?`).get(id);
    if (!row) throw new ApiError(404, "not_found", "Comment not found");
    return toComment(row);
  }
  /** The item a comment is on, as the principal may see it (404 otherwise). */
  private item(principal: Principal, id: string): DashboardRecord {
    const record = this.store.get(id);
    if (principal.source !== "manual" && !agentCanRead(principal, record)) throw new ApiError(404, "not_found", "Record not found");
    if (!isWork(record)) throw new ApiError(400, "invalid_target", "Comments and reports go on a task or project");
    return record;
  }
  /** An owner comment the agent answers for: on its own item or the owner's, while the item is not archived. */
  private queued(principal: Principal, comment: Comment, record: DashboardRecord) {
    return comment.source === "manual" && record.archivedAt === null && (record.createdBy === principal.id || record.createdBy === "owner");
  }

  list(principal: Principal, raw: Record<string, string>): { items: (Comment | QueuedComment)[] } {
    const query = querySchema.parse(raw);
    const db = this.store.db;
    if (query.recordId !== undefined) {
      this.item(principal, query.recordId);
      const rows = db.query(`SELECT ${COLUMNS} FROM comments c WHERE c.record_id=?${stateCondition(query.state ?? "all")} ORDER BY c.created_at,c.rowid`).all(query.recordId);
      return { items: rows.map(toComment) };
    }
    if (principal.source === "manual") {
      const rows = db.query(`SELECT ${COLUMNS} FROM comments c JOIN records r ON r.id=c.record_id WHERE 1=1${stateCondition(query.state ?? "all")}
        ORDER BY c.created_at,c.rowid LIMIT 2000`).all();
      return { items: rows.map(toComment) };
    }
    const rows = db.query(`SELECT ${COLUMNS},json_extract(r.data,'$.title') AS title FROM comments c JOIN records r ON r.id=c.record_id
      WHERE c.source='manual' AND json_extract(r.data,'$.kind') IN ('task','project') AND json_extract(r.data,'$.archivedAt') IS NULL
      AND (r.created_by=? OR r.created_by='owner')${stateCondition(query.state ?? "open")} ORDER BY c.created_at,c.rowid LIMIT 200`).all(principal.id);
    return { items: rows.map(value => ({ ...toComment(value), recordTitle: queuedRow.parse(value).title })) };
  }

  create(principal: Principal, input: CommentInput): { comment: Comment; record: DashboardRecord | null; replayed: boolean } {
    return this.store.db.transaction(() => {
      const db = this.store.db;
      const encoded = canonical(input);
      const previous = db.query(`SELECT ${COLUMNS} FROM comments c WHERE c.author=? AND c.request_id=?`).get(principal.id, input.requestId);
      if (previous) {
        if (rowSchema.parse(previous).payload !== encoded) throw new ApiError(409, "idempotency_conflict", "Request ID was already used with different content");
        return { comment: toComment(previous), record: null, replayed: true };
      }
      const parent = input.replyTo === undefined ? null : this.find(input.replyTo);
      const recordId = input.recordId ?? parent?.recordId;
      if (recordId === undefined) throw new ApiError(400, "invalid_input", "recordId or replyTo is required");
      if (parent && parent.recordId !== recordId) throw new ApiError(400, "invalid_relationship", "replyTo must be a comment on the same item");
      const record = this.item(principal, recordId);
      const agent = principal.source !== "manual";
      if (input.status !== undefined) {
        const statuses: readonly string[] = record.kind === "project" ? WORK_STATUSES.project : WORK_STATUSES.task;
        if (!statuses.includes(input.status)) throw new ApiError(400, "invalid_status", `Status must be one of ${statuses.join(", ")}`);
        if (agent && record.createdBy !== principal.id) throw new ApiError(403, "forbidden", "Agents change the status only of items they created; report without a status on the owner's items");
      }
      const answers = agent && parent !== null && this.queued(principal, parent, record);
      if (input.done && !answers) throw new ApiError(403, "forbidden", "done marks an owner comment the agent answers for; reply to it with replyTo");
      const timestamp = new Date(this.store.now()).toISOString();
      const id = crypto.randomUUID();
      db.query(`INSERT INTO comments(id,record_id,author,source,body,reply_to,status,created_at,request_id,payload) VALUES(?,?,?,?,?,?,?,?,?,?)`)
        .run(id, recordId, principal.id, principal.source, input.body, parent?.id ?? null, input.status ?? null, timestamp, input.requestId, encoded);
      if (parent && answers) {
        db.query("UPDATE comments SET seen_at=COALESCE(seen_at,?),seen_by=COALESCE(seen_by,?) WHERE id=?").run(timestamp, principal.id, parent.id);
        if (input.done) db.query("UPDATE comments SET done_at=COALESCE(done_at,?),done_by=COALESCE(done_by,?) WHERE id=?").run(timestamp, principal.id, parent.id);
      }
      const updated = input.status !== undefined && input.status !== record.status ? this.store.setStatus(record.id, input.status) : null;
      return { comment: this.find(id), record: updated, replayed: false };
    }).immediate();
  }

  /** An agent marks an owner comment in its queue as seen or done (done implies seen). Repeating it keeps the first mark. */
  mark(principal: Principal, id: string, mark: "seen" | "done"): { comment: Comment } {
    if (principal.source === "manual") throw new ApiError(403, "forbidden", "Agents mark the owner's comments");
    return this.store.db.transaction(() => {
      const comment = this.find(id);
      const record = this.item(principal, comment.recordId);
      if (comment.source !== "manual") throw new ApiError(403, "forbidden", "Only the owner's comments are marked seen or done");
      if (!this.queued(principal, comment, record)) throw new ApiError(403, "forbidden", "This comment is not in this agent's queue");
      const timestamp = new Date(this.store.now()).toISOString();
      this.store.db.query("UPDATE comments SET seen_at=COALESCE(seen_at,?),seen_by=COALESCE(seen_by,?) WHERE id=?").run(timestamp, principal.id, id);
      if (mark === "done") this.store.db.query("UPDATE comments SET done_at=COALESCE(done_at,?),done_by=COALESCE(done_by,?) WHERE id=?").run(timestamp, principal.id, id);
      return { comment: this.find(id) };
    }).immediate();
  }
}
