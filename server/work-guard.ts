import { z } from "zod";
import type { Store } from "./store";
import { Cancelled, type Job } from "./narration-types";

/** Rechecked at each paid call and write; a cached service graph never revives a tombstone. */
export async function accountActive(store: Store) {
  return Boolean(await store.db.sql.get("SELECT id FROM users WHERE id=? AND deleted_at IS NULL", [store.db.userId]));
}
export async function assertWorkActive(store: Store, job?: Job) {
  if (!await accountActive(store)) throw new Cancelled();
  if (job?.lease) {
    const row = await store.db.get("SELECT leased_by,leased_until FROM narrations WHERE record_id=? AND user_id=?", [job.id]);
    const lease = z.object({ leased_by: z.string().nullable(), leased_until: z.number().nullable() }).nullable().parse(row);
    if (!lease || lease.leased_by !== job.lease || (lease.leased_until ?? 0) <= store.now()) throw new Cancelled();
  }
}
