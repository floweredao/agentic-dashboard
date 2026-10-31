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
/**
 * The single-user predecessor kept news and mail briefings in `briefings` and `briefing_reactions`, with the sections as an
 * object under a fixed set of names. Each briefing becomes a digest whose sections are the ordered array the app reads, in
 * the order a briefing folder uploads them and under the names the predecessor showed.
 */
const BRIEFING_SECTIONS = [
  { name: "mail", key: "mail", kind: "messages", title: "메일" },
  { name: "social", key: "social", kind: "articles", title: "X" },
  { name: "domestic", key: "domestic", kind: "articles", title: "국내" },
  { name: "international", key: "international", kind: "articles", title: "해외" },
  { name: "aiDevelopment", key: "ai-development", kind: "articles", title: "AI/개발" },
] as const;
const briefingRow = z.object({
  id: z.string(), date: z.string(), slot: z.string(), scheduled_at: z.string(), sections: z.string(), created_by: z.string(),
  created_at: z.string(), updated_at: z.string(), version: z.number().int(),
  news_read_at: z.string().nullable(), mail_read_at: z.string().nullable(),
});
/** Item payloads move as they are stored: a digest article and message carry the same fields as the briefing's. */
const briefingSections = z.record(z.string(), z.object({ items: z.array(z.unknown()), shortfall: z.string().nullable(), updatedAt: z.string() }));
const reactionRow = z.object({
  briefing_id: z.string(), section: z.string(), article_key: z.string(), reaction: z.string(), title: z.string(),
  source: z.string(), url: z.string(), updated_at: z.string(),
});
const sectionKeys = new Map<string, string>(BRIEFING_SECTIONS.map(section => [section.name, section.key]));
/** The AI editions were stored under their names and are read back as the times they were scheduled for. */
const digestSlot = (slot: string) => slot === "ai-morning" ? "08:10" : slot === "ai-evening" ? "19:10" : slot;

/**
 * Carry each briefing over as a digest and remove the briefing tables: their foreign keys now point at the dropped legacy
 * copies, so leaving them behind fails the deferred foreign-key check at commit and the server never starts.
 */
async function carryBriefings(sql: Sql) {
  if (!(await names(sql, "briefings")).length) return;
  const ids = z.array(z.object({ id: z.string() })).parse(await sql.all("SELECT id FROM briefings ORDER BY scheduled_at"));
  for (const { id } of ids) {
    const row = briefingRow.parse(await sql.get("SELECT * FROM briefings WHERE id=?", [id]));
    const stored = briefingSections.parse(JSON.parse(row.sections));
    const sections = BRIEFING_SECTIONS.flatMap(section => {
      const value = stored[section.name];
      return value === undefined ? [] : [{ key: section.key, title: section.title, kind: section.kind,
        shortfall: value.shortfall, updatedAt: value.updatedAt, items: value.items }];
    });
    await sql.run(`INSERT INTO digests(id,date,slot,scheduled_at,sections,created_by,created_at,updated_at,version,articles_read_at,messages_read_at,user_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      [row.id, row.date, digestSlot(row.slot), row.scheduled_at, JSON.stringify(sections), row.created_by, row.created_at,
        row.updated_at, row.version, row.news_read_at, row.mail_read_at, "local"]);
  }
  if ((await names(sql, "briefing_reactions")).length) {
    for (const value of await sql.all("SELECT * FROM briefing_reactions")) {
      const row = reactionRow.parse(value);
      await sql.run(`INSERT INTO digest_reactions(digest_id,section,article_key,reaction,title,source,url,updated_at,user_id)
        VALUES(?,?,?,?,?,?,?,?,?)`,
        [row.briefing_id, sectionKeys.get(row.section) ?? row.section, row.article_key, row.reaction, row.title, row.source,
          row.url, row.updated_at, "local"]);
    }
    await sql.run("DROP TABLE briefing_reactions");
  }
  await sql.run("DROP TABLE briefings");
}

/**
 * The predecessor's briefing push switch and briefing automatic-audio setting keep their value under the digest name.
 * `json_type` names the stored type, so a boolean stays a boolean instead of becoming 0 or 1.
 */
async function renameBriefingSettings(sql: Sql) {
  await sql.run(`UPDATE push_subscriptions SET kinds=json_remove(json_set(kinds,'$.digest',json(json_type(kinds,'$.briefing'))),'$.briefing')
    WHERE json_type(kinds,'$.briefing') IN ('true','false') AND user_id=?`, ["local"]);
  await sql.run(`UPDATE narration_auto SET data=json_remove(json_set(data,'$.digests',json_extract(data,'$.briefings')),'$.briefings')
    WHERE json_type(data,'$.briefings')='text' AND user_id=?`, ["local"]);
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
    await carryBriefings(sql);
    await renameBriefingSettings(sql);
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
  { version: 6, async up(sql) {
    await sql.run("ALTER TABLE push_subscriptions ADD COLUMN hide_content INTEGER NOT NULL DEFAULT 0");
  } },
  { version: 7, async up(sql) {
    await sql.run("ALTER TABLE narrations ADD COLUMN retry_at TEXT");
  } },
  { version: 8, async up(sql) {
    await createSchema(sql);
  } },
  { version: 9, async up(sql) {
    await sql.run("ALTER TABLE users ADD COLUMN export_lease TEXT");
    await sql.run("ALTER TABLE users ADD COLUMN export_until INTEGER");
  } },
  { version: 10, async up(sql) {
    await sql.run("ALTER TABLE sessions ADD COLUMN authenticated_at INTEGER NOT NULL DEFAULT 0");
  } },
  { version: 11, async up(sql) {
    await sql.run("ALTER TABLE users ADD COLUMN audio_purged_at TEXT");
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
