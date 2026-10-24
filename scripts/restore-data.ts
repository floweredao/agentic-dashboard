import { z } from "zod";
import { TABLES } from "../server/schema";
import { migrate } from "../server/migrations";
import type { Sql } from "../server/db";
import { DataRowSchema, tenantData } from "../server/tenant-data";
import { ApiError } from "../server/errors";

const allowed = new Set(["users", "schema_migrations", "oauth_transactions", "operator_alerts", "maintenance_runs", ...Object.keys(TABLES)]);
const backupRow = z.object({ table: z.string().refine(value => allowed.has(value)), row: DataRowSchema }).strict();
const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** Offline administrative import only; refuses live targets and never resurrects a target tombstone. */
export async function restoreBackup(sql: Sql, bytes: Uint8Array) {
  const text = new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(bytes)));
  const rows = text.trim().split("\n").filter(Boolean).map(line => backupRow.parse(JSON.parse(line)));
  await migrate(sql);
  await sql.tx(async tx => {
    const targetUsers = z.array(z.object({ id: z.string(), deleted_at: z.string().nullable() })).parse(await tx.all("SELECT id,deleted_at FROM users"));
    const deleted = new Set(targetUsers.filter(user => user.deleted_at !== null).map(user => user.id));
    if (targetUsers.some(user => user.id !== "local" && user.deleted_at === null)) throw new ApiError(409, "restore_not_empty", "Restore requires an empty database");
    for (const user of targetUsers) {
      if (Object.values(await tenantData(tx, user.id)).some(values => values.length)) throw new ApiError(409, "restore_not_empty", "Restore requires an empty database");
    }
    await tx.run("PRAGMA defer_foreign_keys=ON");
    const columns = new Map<string, ReadonlySet<string>>();
    for (const table of allowed) {
      // PRAGMA table_info excludes generated columns; table and column identifiers come from the installed schema.
      const info = z.array(z.object({ name: z.string() })).parse(await tx.all(`PRAGMA table_info(${identifier(table)})`));
      columns.set(table, new Set(info.map(column => column.name)));
    }
    for (const { table, row } of rows) {
      const userId = table === "users" ? row["id"] : row["user_id"];
      if (typeof userId === "string" && deleted.has(userId)) continue;
      const entries = Object.entries(row).filter(([key]) => columns.get(table)?.has(key));
      if (!entries.length) throw new ApiError(400, "backup_invalid", "Backup has no recognized columns");
      await tx.run(`INSERT OR REPLACE INTO ${identifier(table)}(${entries.map(([key]) => identifier(key)).join(",")})
        VALUES(${entries.map(() => "?").join(",")})`, entries.map(([, value]) => value));
    }
  });
}
