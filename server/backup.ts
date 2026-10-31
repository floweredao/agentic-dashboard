import { z } from "zod";
import type { Sql } from "./db";
import { DataRowSchema, tenantData } from "./tenant-data";

/** Administrative snapshot; includes credentials, so only the private backup bucket may receive it. */
export async function createBackup(sql: Sql): Promise<Uint8Array<ArrayBuffer>> {
  return sql.tx(async tx => {
    const rows: { table: string; row: z.infer<typeof DataRowSchema> }[] = [];
    const users = (await tx.all("SELECT * FROM users")).map(row => DataRowSchema.parse(row));
    for (const user of users) {
      rows.push({ table: "users", row: user });
      const id = z.string().parse(user["id"]);
      for (const [table, values] of Object.entries(await tenantData(tx, id))) {
        for (const row of values) rows.push({ table, row });
      }
    }
    for (const [table, query] of [
      ["schema_migrations", "SELECT * FROM schema_migrations"],
      ["oauth_transactions", "SELECT * FROM oauth_transactions"],
      ["operator_alerts", "SELECT * FROM operator_alerts"],
      ["maintenance_runs", "SELECT * FROM maintenance_runs"],
    ]) {
      if (!table || !query) continue;
      for (const value of await tx.all(query)) rows.push({ table, row: DataRowSchema.parse(value) });
    }
    rows.sort((a, b) => `${a.table}:${JSON.stringify(a.row)}`.localeCompare(`${b.table}:${JSON.stringify(b.row)}`));
    return Bun.gzipSync(new TextEncoder().encode(rows.map(row => JSON.stringify(row)).join("\n") + "\n"));
  });
}
