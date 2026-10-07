import { afterAll, afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { z } from "zod";
import { createApp } from "../server/app";
import { CredentialsSchema } from "../server/auth";
import { bearer, fixture, origin, payload, recordResult, tokens } from "./backend-helper";

let f = fixture();
afterEach(() => { f.close(); f = fixture(); });
afterAll(() => f.close());

test("extreme nesting returns validation error rather than server error", async () => {
  let nested: unknown = 1;
  for (let index = 0; index < 1200; index++) nested = [nested];
  const response = await f.call("/api/v1/records", "POST", payload({ kind: "note", title: "Nested", fields: { nested } }), bearer("omo"));
  expect(response.status).toBe(400);
});

test("credentials generate once with restricted mode and database stores only token hashes", async () => {
  f.app.close();
  unlinkSync(f.options.credentialsPath);
  const app = createApp(f.options);
  const first = readFileSync(f.options.credentialsPath, "utf8");
  const credentials = CredentialsSchema.parse(JSON.parse(first));
  expect(Object.values(credentials).every(value => value.length >= 40)).toBe(true);
  const db = new Database(f.options.databasePath);
  try {
    const rows = z.array(z.object({ id: z.string(), source: z.string(), token_hash: z.string() })).parse(db.query("SELECT * FROM principals").all());
    expect(rows.length).toBe(4);
    expect(rows.every(row => /^[a-f0-9]{64}$/.test(row.token_hash))).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(credentials.owner);
    expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
  } finally { db.close(); app.close(); }
  chmodSync(f.options.credentialsPath, 0o644);
  const restarted = createApp(f.options);
  try {
    expect(readFileSync(f.options.credentialsPath, "utf8")).toBe(first);
    expect(statSync(f.options.credentialsPath).mode & 0o777).toBe(0o600);
  } finally { restarted.close(); }
});

test("session cookies protect HTTP and HTTPS and responses carry restrictive headers", async () => {
  const secure = fixture(10000, Date.now, { privateOrigin: "https://dashboard.example.test" });
  try {
  for (const [app, requestOrigin] of [[f, origin], [secure, "https://dashboard.example.test"]] as const) {
    const response = await app.call("/api/v1/auth/session", "POST", { token: tokens.owner }, { Origin: requestOrigin });
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie.includes("Secure")).toBe(requestOrigin.startsWith("https:"));
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const policy = Object.fromEntries((response.headers.get("content-security-policy") ?? "").split(";").map(part => part.trim().split(/\s+/)).map(([name = "", ...values]) => [name, values]));
    expect(policy["media-src"]).toEqual(["'self'", "data:", "blob:"]);
    expect(policy["img-src"]).toEqual(["'self'", "data:", "blob:"]);
    expect(policy["script-src"]).toEqual(["'self'"]);
  }
  } finally { secure.close(); }
});

test("filters select archived, review, project, status and exclude archived by default", async () => {
  const session = await f.login();
  const make = async (input: unknown) => {
    const response = await f.call("/api/v1/records", "POST", payload(input), session);
    expect(response.status).toBe(201);
    return recordResult.parse(await response.json()).record;
  };
  const project = await make({ kind: "project", title: "P", status: "active" });
  const task = await make({ kind: "task", title: "T", status: "review", projectId: project.id });
  await make({ kind: "note", title: "N" });
  expect((await f.call(`/api/v1/records/${task.id}`, "PATCH", { expectedVersion: 1, changes: { archived: true, reviewState: "rejected" } }, session)).status).toBe(200);
  const page = z.object({ items: z.array(z.object({ id: z.string() })) });
  const list = async (query: string) => {
    const response = await f.call(`/api/v1/records?${query}`, "GET", undefined, session);
    expect(response.status).toBe(200);
    return page.parse(await response.json()).items.map(item => item.id);
  };
  expect(await list("")).not.toContain(task.id);
  expect(await list(`archived=true&projectId=${project.id}&reviewState=rejected&status=review&kind=task`)).toEqual([task.id]);
  expect((await list("archived=all")).length).toBe(3);
  expect((await f.call(`/api/v1/records/${task.id}`, "PATCH", { expectedVersion: 2, changes: { archived: false, status: "done" } }, session)).status).toBe(200);
  expect(await list("kind=task&status=done")).toEqual([task.id]);
});

test("empty patches preserve data, explicit replacements remove old array and field content", async () => {
  const session = await f.login();
  const response = await f.call("/api/v1/records", "POST", payload({ kind: "note", title: "Keep", tags: ["old"], fields: { summary: "Old", starred: true } }), session);
  expect(response.status).toBe(201);
  const original = recordResult.parse(await response.json()).record;
  const next = await f.call(`/api/v1/records/${original.id}`, "PATCH", { expectedVersion: 1, changes: { tags: [], fields: { starred: false } } }, session);
  expect(next.status).toBe(200);
  const changed = recordResult.parse(await next.json()).record;
  expect(changed.tags).toEqual([]);
  expect(changed.fields).toEqual({ starred: false });
  const empty = await f.call(`/api/v1/records/${original.id}`, "PATCH", { expectedVersion: 2, changes: {} }, session);
  expect(empty.status).toBe(200);
  expect(recordResult.parse(await empty.json()).record).toEqual({ ...changed, version: 3 });
});
