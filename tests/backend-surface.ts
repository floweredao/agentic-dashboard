import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createApp } from "../server/app";
import { CredentialsSchema, secret } from "../server/auth";
import { DashboardRecordSchema } from "../shared/contracts";

const dir = mkdtempSync(join(tmpdir(), "agentic-backend-surface-"));
const origin = "http://127.0.0.1:4310";
const options = { databasePath: join(dir, "db.sqlite"), credentialsPath: join(dir, "credentials.json"), staticRoot: join(dir, "dist") };
mkdirSync(options.staticRoot);
writeFileSync(join(options.staticRoot, "index.html"), "<!doctype html><html><body>static-root-smoke</body></html>");
let app = createApp(options);
const agentKeys = { chatgpt: secret(), codex: secret(), omo: secret() };
for (const [name, key] of Object.entries(agentKeys)) app.agents.add(name, key);
let server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
const ingress = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.publicFetch });
const credentials = CredentialsSchema.parse(JSON.parse(readFileSync(options.credentialsPath, "utf8")));
const recordEnvelope = z.object({ record: DashboardRecordSchema });
async function request(path: string, init: RequestInit = {}, publicOnly = false) {
  const headers = new Headers(init.headers);
  headers.set("Host", publicOnly ? "127.0.0.1:4312" : "127.0.0.1:4310");
  const response = await fetch(`http://127.0.0.1:${publicOnly ? ingress.port : server.port}${path}`, { ...init, headers, signal: AbortSignal.timeout(5000) });
  const body = await response.text();
  const safeHeaders = Object.fromEntries([...response.headers].filter(([name]) => name !== "set-cookie"));
  const capturedBody: unknown = path.includes("/auth/") ? "[authentication response redacted]"
    : response.headers.get("content-type")?.includes("application/json") ? JSON.parse(body) : body;
  console.log(JSON.stringify({ action: `${init.method ?? "GET"} ${path}`, status: response.status, headers: safeHeaders,
    body: capturedBody }, null, 2));
  return { response, body };
}
try {
  const root = await request("/");
  assert.equal(root.response.status, 200);
  assert.match(root.body, /static-root-smoke/);
  assert.equal((await request("/projects/example")).response.status, 200);
  const saved = [];
  for (const source of ["chatgpt", "codex", "omo"] as const) {
    const headers = { Authorization: `Bearer ${agentKeys[source]}`, "Content-Type": "application/json" };
    const create = await request("/api/v1/records", { method: "POST", headers,
      body: JSON.stringify({ requestId: `surface-${source}`, record: { kind: "research", title: `Live ${source}`, body: "Body", tags: ["surface"], fields: { summary: "Summary", conclusion: "Real HTTP", nextActions: "- none" } } }) }, true);
    assert.equal(create.response.status, 201);
    const record = recordEnvelope.parse(JSON.parse(create.body)).record;
    assert.equal(record.source, source);
    const read = await request(`/api/v1/records/${record.id}`, { headers }, true);
    assert.equal(read.response.status, 200);
    assert.deepEqual(recordEnvelope.parse(JSON.parse(read.body)).record, record);
    const changed = await request("/api/v1/records", { method: "POST", headers,
      body: JSON.stringify({ requestId: `surface-${source}`, record: { kind: "research", title: ` Live ${source} `, body: "Body", tags: ["surface"], fields: { summary: "Summary", conclusion: "Real HTTP", nextActions: "- none" } } }) }, true);
    assert.equal(changed.response.status, 409);
    saved.push({ source, record });
  }
  assert.equal((await request("/api/v1/health", {}, true)).response.status, 404);
  assert.equal((await request("/api/v1/records", {}, true)).response.status, 404);
  assert.equal((await request("/api/v1/records", { headers: { Authorization: `Bearer ${agentKeys.codex}` } })).response.status, 200);
  const login = await request("/api/v1/auth/session", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ token: credentials.owner }) });
  assert.equal(login.response.status, 200);
  const session = z.object({ csrfToken: z.string() }).parse(JSON.parse(login.body));
  const cookie = login.response.headers.get("set-cookie")?.split(";")[0] ?? "";
  const ownerHeaders = { Cookie: cookie, Origin: origin, "X-CSRF-Token": session.csrfToken, "Content-Type": "application/json" };
  const first = saved.at(0);
  assert.ok(first);
  const patch = await request(`/api/v1/records/${first.record.id}`, { method: "PATCH", headers: ownerHeaders,
    body: JSON.stringify({ expectedVersion: 1, changes: { reviewState: "approved", archived: true } }) });
  assert.equal(patch.response.status, 200);
  assert.equal(recordEnvelope.parse(JSON.parse(patch.body)).record.version, 2);
  assert.equal((await request(`/api/v1/records/${first.record.id}`, { method: "PATCH", headers: ownerHeaders,
    body: JSON.stringify({ expectedVersion: 1, changes: { title: "Stale" } }) })).response.status, 409);
  assert.equal((await request("/api/v1/records?archived=all", { headers: ownerHeaders })).response.status, 200);
  await server.stop(true);
  await ingress.stop(true);
  app.close();
  app = createApp(options);
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  const restart = await request(`/api/v1/records/${first.record.id}`, { headers: ownerHeaders });
  assert.equal(restart.response.status, 200);
  const restored = recordEnvelope.parse(JSON.parse(restart.body)).record;
  assert.equal(restored.version, 2);
  assert.equal(restored.reviewState, "approved");
  assert.notEqual(restored.archivedAt, null);
  console.log("PASS real HTTP: three agents, owner session, archive/review, stale version, public restriction, restart, static SPA.");

  const child = Bun.spawn(["bun", "server/index.ts"], {
    cwd: process.cwd(), stdout: "pipe", stderr: "pipe",
    env: { ...process.env, DATABASE_PATH: options.databasePath, CREDENTIALS_PATH: options.credentialsPath,
      PORT: "0", APP_ORIGIN: origin, ENABLE_AGENT_INGRESS: "false" },
  });
  try {
    const reader = child.stdout.getReader();
    let output = "";
    while (!output.includes("\n")) {
      const line = await reader.read();
      assert.equal(line.done, false, "Entrypoint must emit readiness before exit");
      output += new TextDecoder().decode(line.value);
    }
    reader.releaseLock();
    console.log(output.trim());
    assert.match(output, /agent ingress disabled/);
    const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
    assert.ok(match?.[1]);
    const health = await fetch(`http://127.0.0.1:${match[1]}/api/v1/health`, { headers: { Host: "127.0.0.1:4310" }, signal: AbortSignal.timeout(5000) });
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });
    console.log("PASS entrypoint starts with ingress disabled and real HTTP health 200.");
  } finally {
    child.kill("SIGTERM");
    assert.equal(await child.exited, 0);
    console.log(`cleanup: entrypoint PID ${child.pid} exited 0.`);
  }
} finally {
  await server.stop(true);
  await ingress.stop(true);
  app.close();
  rmSync(dir, { recursive: true, force: true });
  assert.equal(existsSync(dir), false);
  console.log(`cleanup: both ephemeral listeners stopped; database, credentials and static fixture removed (${dir}).`);
}
