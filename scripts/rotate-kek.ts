import { parseConfig } from "../server/config";
import { openSql } from "../server/db";
import { createGeminiKeys } from "../server/gemini-settings";
import { join } from "node:path";

const config = parseConfig(process.env);
const sql = await openSql(config.DATABASE_URL ?? config.DATABASE_PATH ?? join(config.DATA_DIR, "dashboard.sqlite"), config.databaseToken);
try {
  const count = await createGeminiKeys(sql, { kek: config.APP_SECRETS.kek }).rotateKek();
  console.log(`Re-encrypted ${count} account keys with the newest configured KEK version.`);
} finally { await sql.close(); }
