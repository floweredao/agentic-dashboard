import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import ky from "ky";
import { z } from "zod";
import type { Sql } from "./db";
import type { TenantDb } from "./tenant-db";
import type { AudioStore } from "./audio-store";
import type { CloudClient } from "./cloud-client";
import type { createAlerts } from "./alerts";
import { createBackup } from "./backup";
import { ApiError } from "./errors";

export interface OperationsOptions {
  readonly alerts?: { readonly owner: string; readonly apiKey: string; readonly endpoint?: string };
  readonly turso?: { readonly org: string; readonly token: string; readonly origin?: string };
}
type Scope = { readonly store: { readonly db: TenantDb }; purgeTrash(): Promise<number>; retryDeferred?(): Promise<void> };
const ids = z.array(z.object({ id: z.string() }));
export function createMaintenance(options: {
  readonly sql: Sql; readonly tenant: (id: string) => Promise<Scope>; readonly audio: AudioStore;
  readonly bucket?: string; readonly directory: string; readonly cloud: CloudClient; readonly now: () => number;
  readonly alerts?: ReturnType<typeof createAlerts>; readonly turso?: OperationsOptions["turso"];
  readonly includeLocal?: boolean;
}) {
  const { sql, now, cloud } = options;
  async function usage() {
    if (!options.turso) return;
    const api = ky.create({ prefixUrl: `${options.turso.origin ?? "https://api.turso.tech"}/v1/organizations/${encodeURIComponent(options.turso.org)}/`,
      headers: { Authorization: `Bearer ${options.turso.token}` }, timeout: 10000, retry: 0 });
    const [used, subscription, plans] = await Promise.all([
      api.get("usage").json(), api.get("subscription").json(), api.get("plans").json(),
    ]);
    const values = z.object({ organization: z.object({ usage: z.record(z.string(), z.number().nonnegative()) }) }).parse(used).organization.usage;
    const plan = z.object({ subscription: z.object({ plan: z.string() }) }).parse(subscription).subscription.plan;
    const quotas = z.object({ plans: z.array(z.object({ name: z.string(), quotas: z.record(z.string(), z.number().nullable()) })) })
      .parse(plans).plans.find(item => item.name === plan)?.quotas;
    if (!quotas) throw new ApiError(502, "usage_plan", "Current database plan was not found");
    const names: Readonly<Record<string, string>> = { rows_read: "rowsRead", rows_written: "rowsWritten",
      storage_bytes: "storage", bytes_synced: "bytesSynced", databases: "databases", locations: "locations", groups: "groups" };
    if (Object.entries(names).some(([key, name]) => {
      const limit = quotas[name]; const value = values[key];
      return limit !== undefined && limit !== null && limit > 0 && value !== undefined && value / limit > 0.7;
    })) await options.alerts?.send("usage");
  }
  return async () => {
    const day = new Date(now()).toISOString().slice(0, 10);
    const lease = crypto.randomUUID();
    await sql.run("INSERT OR IGNORE INTO maintenance_runs(day) VALUES(?)", [day]);
    const claim = await sql.run(`UPDATE maintenance_runs SET leased_until=?,leased_by=?
      WHERE day=? AND completed_at IS NULL AND leased_until<=?`, [now() + 900000, lease, day, now()]);
    if (!claim.changes) return;
    try {
      for (const { id } of ids.parse(await sql.all("SELECT id FROM users WHERE deleted_at IS NULL AND (? OR id<>'local')", [Number(options.includeLocal ?? true)]))) {
        const scope = await options.tenant(id);
        await scope.purgeTrash();
        await scope.retryDeferred?.();
        await scope.store.db.run("DELETE FROM narration_runs WHERE started_at<? AND user_id=?", [new Date(now() - 31 * 86400000).toISOString()]);
        await scope.store.db.run("DELETE FROM background_jobs WHERE completed_at<? AND user_id=?", [new Date(now() - 14 * 86400000).toISOString()]);
      }
      for (const { id } of ids.parse(await sql.all("SELECT id FROM users WHERE deleted_at IS NOT NULL"))) await options.audio.removeAll(id);
      const name = `${day}.ndjson.gz`;
      const bytes = await createBackup(sql);
      const cutoff = new Date(now() - 14 * 86400000).toISOString().slice(0, 10);
      if (options.bucket) {
        const bucket = encodeURIComponent(options.bucket);
        await cloud.request(`${cloud.storageOrigin}/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(`backups/${name}`)}`,
          { method: "POST", body: bytes, headers: { "Content-Type": "application/gzip" } });
        let page: string | undefined;
        do {
          const query = new URLSearchParams({ prefix: "backups/", ...(page ? { pageToken: page } : {}) });
          const listed = z.object({ items: z.array(z.object({ name: z.string() })).default([]), nextPageToken: z.string().optional() })
            .parse(await (await cloud.request(`${cloud.storageOrigin}/storage/v1/b/${bucket}/o?${query}`)).json());
          for (const item of listed.items) if (/^backups\/\d{4}-\d{2}-\d{2}\.ndjson\.gz$/.test(item.name) && item.name.slice(8, 18) <= cutoff) {
            await cloud.request(`${cloud.storageOrigin}/storage/v1/b/${bucket}/o/${encodeURIComponent(item.name)}`, { method: "DELETE" });
          }
          page = listed.nextPageToken;
        } while (page);
      } else {
        mkdirSync(options.directory, { recursive: true, mode: 0o700 });
        await Bun.write(join(options.directory, name), bytes);
        chmodSync(join(options.directory, name), 0o600);
        for await (const file of new Bun.Glob("*.ndjson.gz").scan({ cwd: options.directory })) {
          if (/^\d{4}-\d{2}-\d{2}\.ndjson\.gz$/.test(file) && file.slice(0, 10) <= cutoff) rmSync(join(options.directory, file));
        }
      }
      await usage();
      await sql.run("UPDATE maintenance_runs SET completed_at=? WHERE day=? AND leased_by=?", [new Date(now()).toISOString(), day, lease]);
      await sql.run("DELETE FROM maintenance_runs WHERE completed_at<?", [new Date(now() - 14 * 86400000).toISOString()]);
    } catch (error) {
      await options.alerts?.send("maintenance");
      throw error;
    } finally {
      await sql.run("UPDATE maintenance_runs SET leased_until=0 WHERE day=? AND leased_by=?", [day, lease]);
    }
  };
}
