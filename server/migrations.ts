import { z } from "zod";
import type { Sql } from "./db";
import { INDEXES, TABLES } from "./schema";

export type Migration = { readonly version: number; readonly up: (sql: Sql) => Promise<void> };
const column = z.object({ name: z.string() });
const names = async (sql: Sql, table: string) =>
  (await sql.all(`PRAGMA table_info(${table})`)).map(value => column.parse(value).name);

async function createSchema(sql: Sql) {
  for (const [table, definition] of Object.entries(TABLES)) {
    await sql.run(`CREATE TABLE IF NOT EXISTS ${table}(user_id TEXT NOT NULL, ${definition})`);
  }
  for (const [name, table, columns] of INDEXES) {
    await sql.run(`CREATE INDEX IF NOT EXISTS ${name} ON ${table}(user_id,${columns})`);
  }
}
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, async up(sql) {
    await sql.run(`CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, google_sub TEXT UNIQUE, email TEXT, name TEXT,
      locale TEXT, created_at TEXT NOT NULL, onboarded_at TEXT, last_seen_at TEXT, gemini_key_ct TEXT,
      gemini_key_kek INTEGER, deleted_at TEXT)`);
    await sql.run("INSERT OR IGNORE INTO users(id,created_at) VALUES('local',?)", [new Date().toISOString()]);
    const existing = await names(sql, "records");
    if (existing.length === 0 || existing.includes("user_id")) await createSchema(sql);
  } },
  { version: 2, async up(sql) {
    const existing = await names(sql, "records");
    if (existing.includes("user_id")) return;
    await sql.run("PRAGMA defer_foreign_keys=ON");
    const legacy: { table: string; columns: string[] }[] = [];
    for (const table of Object.keys(TABLES)) {
      const columns = await names(sql, table);
      if (!columns.length) continue;
      legacy.push({ table, columns });
      await sql.run(`ALTER TABLE ${table} RENAME TO legacy_${table}`);
    }
    for (const [name] of INDEXES) await sql.run(`DROP INDEX IF EXISTS ${name}`);
    await createSchema(sql);
    for (const { table, columns } of legacy) {
      const targets = new Set(await names(sql, table));
      const kept = columns.filter(name => targets.has(name) && name !== "user_id");
      await sql.run(`INSERT INTO ${table}(${kept.join(",")},user_id) SELECT ${kept.join(",")},'local' FROM legacy_${table}`);
    }
    for (const { table } of [...legacy].reverse()) await sql.run(`DROP TABLE legacy_${table}`);
  } },
];

/** Each version and its ledger entry commit together, including upgrades interrupted mid-copy. */
export async function migrate(sql: Sql, migrations: readonly Migration[] = MIGRATIONS) {
  await sql.run("CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  for (const migration of migrations) {
    await sql.tx(async tx => {
      if (await tx.get("SELECT version FROM schema_migrations WHERE version=?", [migration.version])) return;
      await migration.up(tx);
      await tx.run("INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)", [migration.version, new Date().toISOString()]);
    });
  }
}
