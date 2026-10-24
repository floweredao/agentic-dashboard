import { expect, test } from "bun:test";
import { createBackup } from "../server/backup";
import { restoreBackup } from "../scripts/restore-data";
import { createAlerts } from "../server/alerts";
import { openSql } from "../server/db";
import { migrate } from "../server/migrations";
import { hostedFixture } from "./helpers/hosted";
import { createMaintenance } from "../server/maintenance";
import { cloudClient } from "../server/cloud-client";
import { gcsAudioStore } from "../server/audio-store";

test("backup restore reproduces every table row in an empty database", async () => {
  // Given: real isolated SQL with two accounts, credentials and account content.
  const f = await hostedFixture();
  const target = await openSql(":memory:");
  try {
    await f.call("/api/v1/records", { method: "POST", body: { requestId: "backup",
      record: { kind: "note", title: "Restorable note", body: "Complete content." } } });
    const archive = await createBackup(f.app.sql);
    // When: restoring the backup into an empty database.
    await restoreBackup(target, archive);
    // Then: normalized complete table snapshots match, not merely row counts.
    expect(Buffer.from(Bun.gunzipSync(await createBackup(target))).toString())
      .toBe(Buffer.from(Bun.gunzipSync(archive)).toString());
  } finally { await target.close(); await f.close(); }
});

test("restore retains target tombstones and excludes deleted accounts from old backups", async () => {
  // Given: a backup predating a deletion and a target containing its tombstone.
  const f = await hostedFixture();
  const target = await openSql(":memory:");
  try {
    const archive = await createBackup(f.app.sql);
    await migrate(target);
    await target.run("INSERT INTO users(id,created_at,deleted_at) VALUES('a','2026-01-01','2026-01-02')");
    // When: restoring a historical backup.
    await restoreBackup(target, archive);
    // Then: no active data or usable identity for A returns.
    expect(await target.get("SELECT id FROM users WHERE id='a' AND deleted_at IS NULL")).toBeNull();
    expect(await target.all("SELECT * FROM principals WHERE user_id=?", ["a"])).toEqual([]);
    expect(await target.get("SELECT id FROM users WHERE id='b'")).not.toBeNull();
  } finally { await target.close(); await f.close(); }
});

test("operator alerts deduplicate per day and never accept a caller-supplied recipient", async () => {
  // Given: a fake Resend endpoint and durable SQL.
  const sql = await openSql(":memory:");
  await migrate(sql);
  const received: unknown[] = [];
  const server = Bun.serve({ port: 0, fetch: async request => { received.push(await request.json()); return Response.json({ id: "sent" }); } });
  try {
    const options = { owner: "operator@example.test", apiKey: "fixture", endpoint: `${server.url.origin}/emails`, now: () => Date.parse("2026-01-01T12:00Z") };
    // When: independent instances race on the same alert kind.
    await Promise.all([createAlerts(sql, options).send("signup"), createAlerts(sql, options).send("signup")]);
    await createAlerts(sql, options).send("capacity");
    // Then: one message per kind goes only to the configured operator.
    expect(received).toHaveLength(2);
    for (const value of received) expect(value).toMatchObject({ from: "onboarding@resend.dev", to: ["operator@example.test"] });
  } finally { server.stop(true); await sql.close(); }
});

test("maintenance uploads a restorable backup, expires old objects and alerts on current-plan usage", async () => {
  // Given: fake cloud services and real isolated SQL.
  const f = await hostedFixture();
  const requests: string[] = [];
  let uploaded = new Uint8Array();
  const server = Bun.serve({ port: 0, fetch: async request => {
    const url = new URL(request.url);
    requests.push(`${request.method} ${url.pathname}`);
    if (url.pathname.endsWith("/usage")) return Response.json({ organization: { usage: { rows_read: 71 } } });
    if (url.pathname.endsWith("/subscription")) return Response.json({ subscription: { plan: "fixture" } });
    if (url.pathname.endsWith("/plans")) return Response.json({ plans: [{ name: "fixture", quotas: { rowsRead: 100, databases: null } }] });
    if (url.pathname.startsWith("/upload/")) { uploaded = new Uint8Array(await request.arrayBuffer()); return Response.json({}); }
    if (request.method === "GET") return Response.json({ items: [{ name: "backups/2026-01-01.ndjson.gz" }, { name: "backups/2026-01-30.ndjson.gz" }] });
    return Response.json({});
  } });
  try {
    const client = cloudClient({ storageOrigin: server.url.origin, accessToken: async () => "fixture" });
    const now = () => Date.parse("2026-02-01T12:00Z");
    const alerts = createAlerts(f.app.sql, { owner: "operator@example.test", apiKey: "fixture", endpoint: `${server.url.origin}/emails`, now });
    const maintenance = createMaintenance({ sql: f.app.sql, tenant: f.app.tenant, audio: gcsAudioStore({ bucket: "test", client }),
      bucket: "test", directory: "", cloud: client, now, alerts, includeLocal: false, turso: { org: "test", token: "fixture", origin: server.url.origin } });
    // When: a daily job is retried after success.
    await maintenance();
    await maintenance();
    // Then: one backup, one expired object deletion, and one owner alert occurred.
    expect(requests.filter(path => path.startsWith("POST /upload/"))).toHaveLength(1);
    expect(requests.filter(path => path.startsWith("DELETE "))).toEqual(["DELETE /storage/v1/b/test/o/backups%2F2026-01-01.ndjson.gz"]);
    expect(requests.filter(path => path === "POST /emails")).toHaveLength(1);
    expect(Bun.gunzipSync(uploaded).length).toBeGreaterThan(0);
  } finally { server.stop(true); await f.close(); }
});
