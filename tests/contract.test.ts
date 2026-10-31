import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { ApiError } from "../server/errors";
import { agentRecord, bearer, fixture, origin, payload, recordResult } from "./backend-helper";

// CONTRACT.md promises that had no test of their own, one test per claim, in the order the document makes them.

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });
async function setup(...args: Parameters<typeof fixture>) {
  const f = (await fixture(...args));
  cleanups.push(() => f.close());
  return f;
}
const errorBody = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.array(z.unknown()).optional() }).strict() }).strict();
const error = async (response: Response) => ({ status: response.status, ...errorBody.parse(await response.json()).error });
const created = z.object({ record: recordResult.shape.record, replayed: z.boolean() }).strict();
const DAY = 24 * 60 * 60 * 1000;

test("Principals: an owner session lasts 7 days in the agentic_session cookie", async () => {
  let clock = Date.parse("2026-10-07T10:00:00Z");
  const f = (await setup(10000, () => clock));
  const login = await f.call("/api/v1/auth/session", "POST", { token: "owner-test-secret" }, { Origin: origin });
  const { expiresAt } = z.object({ csrfToken: z.string(), expiresAt: z.string() }).parse(await login.json());
  expect(expiresAt).toBe(new Date(clock + 7 * DAY).toISOString());
  const cookie = login.headers.get("set-cookie") ?? "";
  expect(cookie).toStartWith("agentic_session=");
  const session = { Cookie: cookie.split(";")[0] ?? "" };
  clock += 7 * DAY - 60_000;
  expect((await f.call("/api/v1/auth/session", "GET", undefined, session)).status).toBe(200);
  clock += 2 * 60_000;
  expect((await f.call("/api/v1/auth/session", "GET", undefined, session)).status).toBe(401);
});

test("Principals: a connection code is valid for 15 minutes, and a registered name gets none (409 agent_exists)", async () => {
  let clock = Date.parse("2026-10-07T10:00:00Z");
  const f = (await setup(10000, () => clock));
  const invite = (await f.app.invites.create("desk-agent"));
  expect(invite.expiresAt).toBe(new Date(clock + 15 * 60_000).toISOString());
  clock += 15 * 60_000 - 1;
  expect((await f.call("/api/v1/agents/connect", "POST", { code: invite.code })).status).toBe(201);
  let refused: unknown = null;
  try { (await f.app.invites.create("codex")); } catch (caught) { refused = caught; }
  expect(refused).toBeInstanceOf(ApiError);
  expect(refused).toMatchObject({ status: 409, code: "agent_exists" });
});

test("RecordInput: omitted values take the documented defaults, and a first save answers replayed: false", async () => {
  const f = (await setup());
  const response = await f.call("/api/v1/records", "POST", payload({ kind: "note", title: "  Plain  " }), await f.login());
  expect(response.status).toBe(201);
  const result = created.parse(await response.json());
  expect(result.replayed).toBe(false);
  expect(result.record).toMatchObject({ title: "Plain", body: "", status: "new", projectId: null, taskId: null, dueDate: null, tags: [], links: [], fields: {},
    source: "manual", reviewState: "approved", archivedAt: null, version: 1 });
});

test("RecordInput: status is 1..50 characters; agents keep other kinds new while the owner's plain schema takes any status", async () => {
  const f = (await setup());
  const owner = await f.login();
  const note = await f.call("/api/v1/records", "POST", payload({ kind: "note", title: "Owner note", status: " read " }), owner);
  expect(created.parse(await note.json()).record.status).toBe("read");
  for (const status of ["", " ", "s".repeat(51)]) {
    expect(await error(await f.call("/api/v1/records", "POST", payload({ kind: "note", title: "Bad", status }), owner))).toMatchObject({ status: 400, code: "invalid_input" });
  }
  const agent = await error(await f.call("/api/v1/records", "POST", payload(agentRecord({ kind: "note", status: "read" })), bearer("omo")));
  expect(agent).toMatchObject({ status: 400, code: "record_incomplete" });
  expect(agent.message).toContain("status: leave it unset for this kind");
});

test("RecordInput: tags 1..100 characters, link URLs at most 2048, evidenceIds at most 100, fields at most depth 8", async () => {
  const f = (await setup());
  const owner = await f.login();
  const save = (record: Record<string, unknown>) => f.call("/api/v1/records", "POST", payload({ kind: "note", title: "Limits", ...record }), owner);
  const url = (length: number) => `https://example.com/${"a".repeat(length - "https://example.com/".length)}`;
  let nested: unknown = 1;
  for (let depth = 1; depth < 8; depth++) nested = [nested];
  // At the limits: saved.
  for (const record of [{ tags: ["t".repeat(100)] }, { links: [{ label: "Long", url: url(2048) }] }, { fields: { nested } }]) {
    expect((await save(record)).status).toBe(201);
  }
  // One past: 400 invalid_input.
  for (const record of [{ tags: ["t".repeat(101)] }, { tags: [" "] }, { links: [{ label: "Long", url: url(2049) }] }, { fields: { nested: [nested] } },
    { kind: "task", fields: { evidenceIds: Array.from({ length: 101 }, () => crypto.randomUUID()) } }]) {
    expect(await error(await save(record))).toMatchObject({ status: 400, code: "invalid_input" });
  }
});

test("Idempotency: the same requestId and payload answers 200 with the stored record and replayed: true; another payload 409 idempotency_conflict", async () => {
  const f = (await setup());
  const first = payload(agentRecord({ title: "Once" }));
  const original = created.parse(await (await f.call("/api/v1/records", "POST", first, bearer("codex"))).json());
  const again = await f.call("/api/v1/records", "POST", first, bearer("codex"));
  expect(again.status).toBe(200);
  expect(created.parse(await again.json())).toEqual({ record: original.record, replayed: true });
  const other = await f.call("/api/v1/records", "POST", payload(agentRecord({ title: "Twice" }), first.requestId), bearer("codex"));
  expect(await error(other)).toMatchObject({ status: 409, code: "idempotency_conflict" });
});

test("Comments: a body is at most 4000 characters", async () => {
  const f = (await setup());
  const task = created.parse(await (await f.call("/api/v1/records", "POST", payload(agentRecord({ kind: "task", title: "Task" })), bearer("omo"))).json()).record;
  const comment = (body: string) => f.call("/api/v1/comments", "POST", { requestId: crypto.randomUUID(), recordId: task.id, body }, bearer("omo"));
  expect((await comment("x".repeat(4000))).status).toBe(201);
  expect(await error(await comment("x".repeat(4001)))).toMatchObject({ status: 400, code: "invalid_input" });
});

test("Record documents: tasks take none (400 document_unsupported) and a request past 2 MiB is 413 too_large", async () => {
  const f = (await setup());
  const owner = await f.login();
  const task = created.parse(await (await f.call("/api/v1/records", "POST", payload({ kind: "task", title: "Task" }), owner)).json()).record;
  expect(await error(await f.call(`/api/v1/records/${task.id}/document`, "PUT", { html: "<p>x</p>" }, owner))).toMatchObject({ status: 400, code: "document_unsupported" });
  const note = created.parse(await (await f.call("/api/v1/records", "POST", payload({ kind: "note", title: "Note" }), owner)).json()).record;
  const response = await f.call(`/api/v1/records/${note.id}/document`, "PUT", { html: "x".repeat(2 * 1024 * 1024) }, owner);
  expect(await error(response)).toMatchObject({ status: 413, code: "too_large" });
});

test("Digests: a section has at most 60 items and an upload body at most 256 KiB (413 too_large)", async () => {
  const f = (await setup());
  const item = (index: number, summary = "") => ({ key: `k${index}`, title: `Story ${index}`, summary, url: `https://news.example.com/${index}` });
  const upload = (slot: string, items: unknown[]) => f.call("/api/v1/digests", "POST", { date: "2026-10-01", slot, notify: false,
    sections: [{ key: "world", title: "World", kind: "articles", items }] }, bearer("omo"));
  expect((await upload("07:00", Array.from({ length: 60 }, (_, index) => item(index)))).status).toBe(201);
  expect(await error(await upload("07:01", Array.from({ length: 61 }, (_, index) => item(index))))).toMatchObject({ status: 400, code: "invalid_input" });
  const big = Array.from({ length: 60 }, (_, index) => item(index, "가".repeat(1600)));
  expect(new TextEncoder().encode(JSON.stringify(big)).byteLength).toBeGreaterThan(256 * 1024);
  expect(await error(await upload("07:02", big))).toMatchObject({ status: 413, code: "too_large" });
});

test("Digests: recent reactions take days 1 to 92, default 30", async () => {
  const clock = Date.parse("2026-10-07T10:00:00Z");
  const f = (await setup(10000, () => clock));
  const reactions = (query: string) => f.call(`/api/v1/digests/reactions${query}`, "GET", undefined, bearer("omo"));
  const from = async (query: string) => z.object({ items: z.array(z.unknown()), from: z.string() }).parse(await (await reactions(query)).json()).from;
  expect(await from("")).toBe(new Date(clock - 30 * DAY).toISOString());
  expect(await from("?days=1")).toBe(new Date(clock - DAY).toISOString());
  expect(await from("?days=92")).toBe(new Date(clock - 92 * DAY).toISOString());
  for (const days of ["0", "93", "x"]) expect((await reactions(`?days=${days}`)).status).toBe(400);
});

test("Errors: a body of { error: { code, message } }, with details on validation errors", async () => {
  const f = (await setup());
  const invalid = await f.call("/api/v1/records", "POST", payload({ kind: "note" }), await f.login());
  const body = errorBody.parse(await invalid.json());
  expect(invalid.status).toBe(400);
  expect(body.error.code).toBe("invalid_input");
  expect(body.error.details?.length).toBeGreaterThan(0);
  expect(errorBody.parse(await (await f.call("/api/v1/records")).json()).error.details).toBeUndefined();
});

test("Limits and checks: 421 invalid_host, 403 origin, 415 unsupported_media_type and 413 too_large", async () => {
  const f = (await setup());
  expect(await error(await f.call("/api/v1/records", "GET", undefined, { ...bearer("omo"), Host: "evil.example" }))).toMatchObject({ status: 421, code: "invalid_host" });
  expect(await error(await f.call("/api/v1/records", "GET", undefined, { ...bearer("omo"), Origin: "https://evil.example" }))).toMatchObject({ status: 403, code: "origin" });
  const post = (contentType: string, body: string) => f.app.fetch(new Request(`${origin}/api/v1/records`, { method: "POST", headers: { ...bearer("omo"), "Content-Type": contentType }, body }));
  expect(await error(await post("text/plain", "{}"))).toMatchObject({ status: 415, code: "unsupported_media_type" });
  expect(await error(await post("application/json", "x".repeat(512 * 1024 + 1)))).toMatchObject({ status: 413, code: "too_large" });
});

test("Limits and checks: every response, errors included, sends X-Frame-Options DENY, nosniff and Cache-Control no-store", async () => {
  const f = (await setup());
  for (const response of [await f.call("/api/v1/health"), await f.call("/api/v1/records"), await f.call("/api/v1/nowhere")]) {
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("script-src 'self';");
  }
});

test("Limits and checks: past the limit 429 rate_limited with Retry-After: 60; unknown credentials share one bucket, a known key keeps its own", async () => {
  const f = (await setup(2));
  const statuses: number[] = [];
  let last: Response | null = null;
  for (let index = 0; index < 3; index++) {
    last = await f.call("/api/v1/records", "GET", undefined, { Authorization: `Bearer unknown-${index}` });
    statuses.push(last.status);
  }
  expect(statuses).toEqual([401, 401, 429]);
  expect(last?.headers.get("retry-after")).toBe("60");
  expect(errorBody.parse(await last?.json()).error.code).toBe("rate_limited");
  expect((await f.call("/api/v1/records", "GET", undefined, bearer("omo"))).status).toBe(200);
});

test("Public and session: the schema names the kinds, field lists, agent format, the RecordInput JSON Schema and the time zone", async () => {
  const f = (await setup());
  const schema = z.object({ kinds: z.array(z.string()), fields: z.record(z.string(), z.array(z.string())), agentRecord: z.object({ kinds: z.record(z.string(), z.unknown()) }).passthrough(),
    input: z.object({ type: z.literal("object") }).passthrough(), timeZone: z.string() }).passthrough().parse(await (await f.call("/api/v1/schema")).json());
  expect(schema.kinds).toEqual(["project", "task", "research", "work-report", "note", "social"]);
  expect(schema.timeZone).toBe("Asia/Seoul");
  expect(Object.keys(schema.agentRecord.kinds)).toEqual(schema.kinds);
  expect(schema.fields).toMatchObject({ project: ["nextAction"], task: ["today", "evidenceIds"] });
});
