import { z } from "zod";
import { DashboardRecordSchema } from "../shared/contracts";
import type { RecordSync } from "../shared/record-sync";
import type { TenantDb } from "./tenant-db";

/** Called inside the record mutation's transaction, including moves to trash. */
export async function recordChanged(db: TenantDb, id: string) {
  const { version } = z.object({ version: z.number() }).parse(await db.get(
    "INSERT INTO record_sync(version,user_id) VALUES(1,?) ON CONFLICT(user_id) DO UPDATE SET version=record_sync.version+1 RETURNING version", []));
  await db.run("INSERT INTO record_changes(version,record_id,user_id) VALUES(?,?,?)", [version, id]);
}

export async function recordChanges(db: TenantDb, after?: number): Promise<RecordSync> {
  return db.tx(async () => {
    const head = z.object({ version: z.number() }).nullable().parse(await db.get("SELECT version FROM record_sync WHERE user_id=?", []))?.version ?? 0;
    if (after === undefined) return { cursor: head, items: [], deletedIds: [], hasMore: false, reset: false };
    const first = z.object({ first: z.number().nullable() }).parse(await db.get("SELECT min(version) AS first FROM record_changes WHERE user_id=?", [])).first;
    if (after > head || (after < head && (first === null || after < first - 1))) {
      return { cursor: head, items: [], deletedIds: [], hasMore: false, reset: true };
    }
    const rows = z.array(z.object({ version: z.number(), record_id: z.string(), data: z.string().nullable() })).parse(await db.all(
      `SELECT c.version,c.record_id,r.data FROM record_changes c LEFT JOIN records r ON r.id=c.record_id AND r.user_id=c.user_id
       WHERE c.version>? AND c.version<=? AND c.user_id=? ORDER BY c.version LIMIT 50`, [after, head]));
    const current = new Map(rows.map(row => [row.record_id, row.data ? DashboardRecordSchema.parse(JSON.parse(row.data)) : null]));
    const cursor = rows.at(-1)?.version ?? head;
    return { cursor, items: [...current.values()].filter(value => value !== null),
      deletedIds: [...current].filter(([, value]) => value === null).map(([id]) => id), hasMore: cursor < head, reset: false };
  });
}
