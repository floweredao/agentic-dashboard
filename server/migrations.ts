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
  { version: 3, async up(sql) {
    await sql.run("CREATE TABLE oauth_transactions(tx_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)");
    await sql.run("ALTER TABLE principals ADD COLUMN capture INTEGER NOT NULL DEFAULT 0");
  } },
  { version: 4, async up(sql) {
    await sql.run("ALTER TABLE narrations ADD COLUMN leased_until INTEGER");
    await sql.run("ALTER TABLE narrations ADD COLUMN leased_by TEXT");
    await sql.run(`CREATE TABLE IF NOT EXISTS background_jobs(user_id TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
      revision TEXT NOT NULL, leased_until INTEGER, leased_by TEXT, completed_at TEXT, PRIMARY KEY(user_id,kind,id,revision))`);
    await sql.run("CREATE TABLE operator_alerts(kind TEXT NOT NULL, day TEXT NOT NULL, PRIMARY KEY(kind,day))");
    await sql.run("CREATE TABLE maintenance_runs(day TEXT PRIMARY KEY, leased_until INTEGER NOT NULL DEFAULT 0, leased_by TEXT, completed_at TEXT)");
  } },
  { version: 5, async up(sql) {
    await sql.run("ALTER TABLE users ADD COLUMN time_zone TEXT");
    await sql.run("ALTER TABLE users ADD COLUMN agent_saved_at TEXT");
    await sql.run("ALTER TABLE users ADD COLUMN agent_saved_record TEXT");
    await sql.run(`ALTER TABLE users ADD COLUMN features TEXT NOT NULL DEFAULT '{"digest":true,"push":true}'`);
    await sql.run("ALTER TABLE sessions ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0");
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
