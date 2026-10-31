import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app";
import { SESSION_COOKIE } from "../server/auth";
import { DashboardRecordSchema } from "../shared/contracts";
import { LEGACY_CORE, LEGACY_EXTRA } from "./fixtures/legacy-schema";
import { isolationFixture, origin } from "./isolation-fixture";

// Real loopback HTTP, not app.fetch: fixture credentials never appear in the output.
const f = await isolationFixture();
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: f.app.fetch });
try {
  const before = await f.snapshot();
  const request = Bun.spawn(["curl", "--silent", "--show-error", "--include",
    "--header", `Host: ${new URL(origin).host}`, "--header", `Authorization: Bearer ${f.tokens.b}`,
    `http://127.0.0.1:${server.port}/api/v1/records/${f.record.id}`],
  { stdout: "pipe", stderr: "pipe" });
  const response = await new Response(request.stdout).text();
  assert.equal(await request.exited, 0);
  assert.match(response, /^HTTP\/1\.1 404/);
  assert.match(response, /"code":"not_found"/);
  assert.equal(await f.snapshot(), before);
  console.log("PASS curl: B bearer -> A record: HTTP 404 not_found; all A table hashes unchanged");
} finally { await server.stop(true); await f.close(); }

const dir = mkdtempSync(join(tmpdir(), "tenant-http-upgrade-"));
const databasePath = join(dir, "legacy.sqlite");
const credentialsPath = join(dir, "credentials.json");
const timestamp = "2026-10-24T00:00:00.000Z";
const record = DashboardRecordSchema.parse({
  id: "11111111-1111-4111-8111-111111111111", kind: "note", title: "Before upgrade", body: "Keep this",
  source: "manual", createdBy: "owner", createdAt: timestamp, updatedAt: timestamp, version: 1, reviewState: "approved", archivedAt: null,
});
const legacy = new Database(databasePath);
legacy.exec(LEGACY_CORE + LEGACY_EXTRA);
legacy.run("INSERT INTO principals(id,source,token_hash) VALUES('owner','manual','old-owner-hash')");
legacy.run("INSERT INTO records VALUES(?,?,?,NULL,NULL)", [record.id, JSON.stringify(record), "owner"]);
legacy.close();
writeFileSync(credentialsPath, JSON.stringify({ owner: "upgrade-http-fixture-key" }), { mode: 0o600 });
const upgraded = await createApp({ databasePath, credentialsPath });
const upgradedServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: upgraded.fetch });
try {
  const session = await upgraded.auth.createOwnerSession();
  const response = await fetch(`http://127.0.0.1:${upgradedServer.port}/api/v1/records`, {
    headers: { Host: new URL(origin).host, Cookie: `${SESSION_COOKIE}=${session.value}` },
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  const body: unknown = await response.json();
  assert.deepEqual(body, { items: [record], nextCursor: null });
  console.log("PASS HTTP upgrade: v0.4.0 file -> local owner: HTTP 200; record ID and content preserved");
} finally {
  await upgradedServer.stop(true);
  await upgraded.close();
  rmSync(dir, { recursive: true, force: true });
}
