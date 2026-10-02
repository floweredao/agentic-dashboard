import { afterEach, beforeEach, expect, test } from "bun:test";
import { z } from "zod";
import { createApp } from "../server/app";
import { bearer, fixture, origin, recordResult } from "./backend-helper";

let f: ReturnType<typeof fixture>;
let demo: ReturnType<typeof createApp>;
let recordId = "";
const list = z.object({ items: z.array(z.object({ id: z.string() })) });
const call = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => demo.fetch(new Request(`${origin}${path}`, {
  method, headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}));

beforeEach(async () => {
  // Given: a database the owner filled normally, then served by a demo app.
  f = fixture();
  const response = await f.call("/api/v1/records", "POST", { requestId: "demo-1", record: { kind: "note", title: "Seeded" } }, await f.login());
  recordId = recordResult.parse(await response.json()).record.id;
  demo = createApp({ ...f.options, demo: true });
});
afterEach(() => { demo.close(); f.close(); });

test("a demo reads as the owner without a key or cookie", async () => {
  const session = await call("/api/v1/auth/session");
  expect(session.status).toBe(200);
  expect(session.headers.get("set-cookie")).toBeNull();
  expect(z.object({ principal: z.object({ id: z.literal("owner") }) }).parse(await session.json()).principal.id).toBe("owner");
  expect(list.parse(await (await call("/api/v1/records")).json()).items.map(item => item.id)).toEqual([recordId]);
  expect(z.object({ features: z.object({ demo: z.boolean() }) }).parse(await (await call("/api/v1/config")).json()).features.demo).toBe(true);
});

test.each([
  { name: "owner create", method: "POST", path: "/api/v1/records", body: { requestId: "x", record: { kind: "note", title: "Spam" } }, headers: { Origin: origin, "X-CSRF-Token": "demo" } },
  { name: "agent create", method: "POST", path: "/api/v1/records", body: { requestId: "y", record: { kind: "note", title: "Spam", body: "b", tags: ["t"] } }, headers: bearer("codex") },
  { name: "patch", method: "PATCH", path: "/RECORD", body: { expectedVersion: 1, changes: { title: "Changed" } }, headers: { Origin: origin, "X-CSRF-Token": "demo" } },
  { name: "delete", method: "DELETE", path: "/RECORD", body: { expectedVersion: 1 }, headers: { Origin: origin, "X-CSRF-Token": "demo" } },
  { name: "share", method: "POST", path: "/RECORD/share", body: undefined, headers: { Origin: origin, "X-CSRF-Token": "demo" } },
  { name: "comment", method: "POST", path: "/api/v1/comments", body: { requestId: "z", recordId: "RECORD", body: "hi" }, headers: {} },
  { name: "sign out", method: "DELETE", path: "/api/v1/auth/session", body: undefined, headers: { Origin: origin, "X-CSRF-Token": "demo" } },
])("a demo refuses $name with 403 demo_read_only and changes nothing", async ({ method, path, body, headers }) => {
  const target = path.startsWith("/RECORD") ? `/api/v1/records/${recordId}${path.slice("/RECORD".length)}` : path;
  const payload = body && "recordId" in body ? { ...body, recordId } : body;
  const response = await call(target, method, payload, headers);
  expect(response.status).toBe(403);
  expect(z.object({ error: z.object({ code: z.string() }) }).parse(await response.json()).error.code).toBe("demo_read_only");
  const items = list.parse(await (await call("/api/v1/records")).json()).items;
  expect(items.map(item => item.id)).toEqual([recordId]);
  expect(recordResult.parse(await (await call(`/api/v1/records/${recordId}`)).json()).record).toMatchObject({ title: "Seeded", version: 1, archivedAt: null });
});

test("without demo mode a request with no key or cookie still gets 401", async () => {
  expect((await f.call("/api/v1/records")).status).toBe(401);
  expect((await f.call("/api/v1/auth/session")).status).toBe(401);
});
