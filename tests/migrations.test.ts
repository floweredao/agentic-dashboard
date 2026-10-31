import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { openSql } from "../server/db";
import { migrate, MIGRATIONS } from "../server/migrations";
import { TABLES } from "../server/schema";
import { Store } from "../server/store";
import { TenantDb } from "../server/tenant-db";
import { DashboardRecordSchema } from "../shared/contracts";
import { LEGACY_CORE, LEGACY_EXTRA } from "./fixtures/legacy-schema";

const timestamp = "2026-10-24T00:00:00.000Z";
const record = DashboardRecordSchema.parse({
  id: "11111111-1111-4111-8111-111111111111", kind: "note", title: "Legacy note", body: "Preserve every byte",
  source: "manual", createdBy: "owner", createdAt: timestamp, updatedAt: timestamp, version: 1, reviewState: "approved", archivedAt: null,
});

for (const version of ["v0.1.0", "v0.4.0"] as const) {
  test(`preserves every existing row when upgrading ${version}`, async () => {
    // Given: a legacy file, populated independently of the current schema.
    const dir = mkdtempSync(join(tmpdir(), "tenant-upgrade-"));
    const path = join(dir, `${version}.sqlite`);
    const legacy = new Database(path);
    legacy.exec(LEGACY_CORE + (version === "v0.4.0" ? LEGACY_EXTRA : ""));
    legacy.run("INSERT INTO principals(id,source,token_hash) VALUES('owner','manual','legacy-hash')");
    legacy.run("INSERT INTO records VALUES(?,?,?,NULL,NULL)", [record.id, JSON.stringify(record), "owner"]);
    legacy.run("INSERT INTO evidence VALUES(?,?)", [record.id, record.id]);
    legacy.run("INSERT INTO sessions VALUES('session','owner','csrf',9999999999999)");
    legacy.run("INSERT INTO requests VALUES('owner','request','{}',?)", [JSON.stringify(record)]);
    legacy.run("INSERT INTO trash VALUES('trash',?,'owner',?)", [JSON.stringify(record), timestamp]);
    legacy.run("INSERT INTO comments(id,record_id,author,source,body,created_at,request_id,payload) VALUES('comment',?,'owner','manual','text',?,'comment-request','{}')", [record.id, timestamp]);
    if (version === "v0.4.0") {
      legacy.run("INSERT INTO documents VALUES(?,'<p>Full text</p>',16,'manual',?)", [record.id, timestamp]);
      legacy.run("INSERT INTO agent_invites VALUES('invite-hash','new-agent',?,9999999999999)", [timestamp]);
      legacy.run("INSERT INTO digests VALUES('digest','2026-10-24','morning',?,'[]','owner',?,?,1,NULL,NULL)", [timestamp, timestamp, timestamp]);
      legacy.run("INSERT INTO digest_reactions VALUES('digest','tech','article','like','Title','Publisher','https://example.test',?)", [timestamp]);
      legacy.run("INSERT INTO narrations(record_id,status,job_hash,requested_by,requested_at,updated_at,script) VALUES(?,'ready','hash','owner',?,?,'Saved script')", [record.id, timestamp, timestamp]);
      legacy.run("INSERT INTO narration_runs VALUES(?,?)", [record.id, timestamp]);
      legacy.run("INSERT INTO narration_auto VALUES(1,'{}',?)", [timestamp]);
      legacy.run("INSERT INTO narration_settings VALUES(1,'{}',?)", [timestamp]);
      legacy.run("INSERT INTO push_subscriptions VALUES('https://example.test/push','p256dh','auth','{}',?,?,'en')", [timestamp, timestamp]);
      legacy.run("INSERT INTO shares VALUES('AAAA-BBBB-CCCC',?,?)", [record.id, timestamp]);
    }
    const tables = z.array(z.object({ name: z.string() })).parse(legacy.query("SELECT name FROM sqlite_master WHERE type='table'").all());
    const before = new Map(tables.map(({ name }) => [name, legacy.query(`SELECT * FROM ${name}`).all()]));
    legacy.close();
    const sql = await openSql(path);
    try {
      // When: versions apply, and applying them again does nothing.
      await migrate(sql);
      await migrate(sql);
      // Then: counts and all old values survive under the implicit owner.
      for (const [table, rows] of before) {
        const after = await sql.all(`SELECT * FROM ${table} WHERE user_id=?`, ["local"]);
        expect(after.length).toBe(rows.length);
        for (const [index, row] of rows.entries()) {
          expect(after[index]).toMatchObject({ ...z.record(z.string(), z.unknown()).parse(row), user_id: "local" });
        }
      }
      expect(await new Store(new TenantDb(sql, "local"), Date.now).get(record.id)).toEqual(record);
      expect(await sql.all("PRAGMA foreign_key_check")).toEqual([]);
      for (const table of Object.keys(TABLES)) {
        const columns = z.array(z.object({ name: z.string(), notnull: z.number() })).parse(await sql.all(`PRAGMA table_info(${table})`));
        expect(columns.find(column => column.name === "user_id")?.notnull).toBe(1);
      }
    } finally { await sql.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}

test("rolls back both data and version when a migration is interrupted", async () => {
  const sql = await openSql(":memory:");
  try {
    await migrate(sql);
    const version = Math.max(...MIGRATIONS.map(migration => migration.version)) + 1;
    const interrupted = { version, async up(tx: typeof sql) {
      await tx.run("INSERT INTO users(id,created_at) VALUES('discard',?)", [timestamp]);
      throw new Error("interrupted");
    } };
    await expect(migrate(sql, [...MIGRATIONS, interrupted])).rejects.toThrow("interrupted");
    expect(await sql.get("SELECT id FROM users WHERE id='discard'")).toBeNull();
    expect(await sql.get("SELECT version FROM schema_migrations WHERE version=?", [version])).toBeNull();
  } finally { await sql.close(); }
});
