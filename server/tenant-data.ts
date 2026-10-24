import { z } from "zod";
import type { Sql } from "./db";
import { TABLES } from "./schema";

/** Explicit inventory keeps backup/export coverage exhaustive without computed tenant SQL. */
const queries = {
  record_sync: "SELECT * FROM record_sync WHERE user_id=?",
  record_changes: "SELECT * FROM record_changes WHERE user_id=?",
  principals: "SELECT * FROM principals WHERE user_id=?",
  sessions: "SELECT * FROM sessions WHERE user_id=?",
  records: "SELECT * FROM records WHERE user_id=?",
  evidence: "SELECT * FROM evidence WHERE user_id=?",
  requests: "SELECT * FROM requests WHERE user_id=?",
  trash: "SELECT * FROM trash WHERE user_id=?",
  comments: "SELECT * FROM comments WHERE user_id=?",
  documents: "SELECT * FROM documents WHERE user_id=?",
  agent_invites: "SELECT * FROM agent_invites WHERE user_id=?",
  digests: "SELECT * FROM digests WHERE user_id=?",
  digest_reactions: "SELECT * FROM digest_reactions WHERE user_id=?",
  narrations: "SELECT * FROM narrations WHERE user_id=?",
  narration_runs: "SELECT * FROM narration_runs WHERE user_id=?",
  narration_auto: "SELECT * FROM narration_auto WHERE user_id=?",
  narration_settings: "SELECT * FROM narration_settings WHERE user_id=?",
  push_subscriptions: "SELECT * FROM push_subscriptions WHERE user_id=?",
  shares: "SELECT * FROM shares WHERE user_id=?",
  background_jobs: "SELECT * FROM background_jobs WHERE user_id=?",
} satisfies Record<keyof typeof TABLES, string>;
export const DataRowSchema = z.record(z.string(), z.union([z.string(), z.number(), z.null()]));
export type DataRow = z.infer<typeof DataRowSchema>;
export async function tenantData(sql: Sql, userId: string) {
  const result: Record<string, DataRow[]> = {};
  for (const [table, query] of Object.entries(queries)) result[table] = (await sql.all(query, [userId])).map(row => DataRowSchema.parse(row));
  return result;
}

/** Defer relationship checks until all account rows are gone; every statement remains tenant-bound. */
export async function eraseTenant(sql: Sql, userId: string) {
  await sql.run("PRAGMA defer_foreign_keys=ON");
  const statements = [
    "DELETE FROM evidence WHERE user_id=?", "DELETE FROM shares WHERE user_id=?",
    "DELETE FROM requests WHERE user_id=?", "DELETE FROM sessions WHERE user_id=?",
    "DELETE FROM comments WHERE user_id=?", "DELETE FROM documents WHERE user_id=?",
    "DELETE FROM records WHERE user_id=?", "DELETE FROM trash WHERE user_id=?",
    "DELETE FROM agent_invites WHERE user_id=?", "DELETE FROM digest_reactions WHERE user_id=?",
    "DELETE FROM digests WHERE user_id=?", "DELETE FROM narrations WHERE user_id=?",
    "DELETE FROM narration_runs WHERE user_id=?", "DELETE FROM narration_auto WHERE user_id=?",
    "DELETE FROM narration_settings WHERE user_id=?", "DELETE FROM push_subscriptions WHERE user_id=?",
    "DELETE FROM background_jobs WHERE user_id=?", "DELETE FROM principals WHERE user_id=?",
    "DELETE FROM record_changes WHERE user_id=?", "DELETE FROM record_sync WHERE user_id=?",
  ];
  for (const statement of statements) await sql.run(statement, [userId]);
}
