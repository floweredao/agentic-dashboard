import { parseArgs } from "node:util";
import { openSql } from "../server/db";
import { restoreBackup } from "./restore-data";

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { from: { type: "string" }, "database-url": { type: "string" } }, strict: true });
if (!values.from || !values["database-url"]) {
  console.error("Usage: bun scripts/restore.ts --from backup.ndjson.gz --database-url <empty database>");
  process.exit(2);
}
const sql = await openSql(values["database-url"], process.env.DATABASE_AUTH_TOKEN);
try {
  await restoreBackup(sql, new Uint8Array(await Bun.file(values.from).arrayBuffer()));
  console.log("Backup restored. Target tombstones were preserved.");
} finally { await sql.close(); }
