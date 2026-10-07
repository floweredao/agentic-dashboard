import { afterAll, afterEach, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { z } from "zod";
import { RECORD_LIMITS } from "../shared/contracts";
import { agentRecord, bearer, fixture, origin, payload, recordResult, tokens } from "./backend-helper";

let f = fixture();
afterEach(() => { f.close(); f = fixture(); });
afterAll(() => f.close());

test("health and schema expose private metadata only", async () => {
  expect((await f.call("/api/health")).status).toBe(200);
  expect(await (await f.call("/api/v1/health")).json()).toEqual({ status: "ok" });
  expect((await f.call("/api/v1/schema")).status).toBe(200);
});
for (const source of ["chatgpt", "codex", "omo"] as const) {
  test(`${source} receives authenticated attribution, reads its record and other agents' reports, and can search`, async () => {
    const response = await f.call("/api/v1/records", "POST", payload(), bearer(source));
    expect(response.status).toBe(201);
    const { record } = recordResult.parse(await response.json());
    expect(record.source).toBe(source);
    expect(record.reviewState).toBe("pending");
    expect((await f.call(`/api/v1/records/${record.id}`, "GET", undefined, bearer(source))).status).toBe(200);
    const other = source === "omo" ? "codex" : "omo";
    expect((await f.call(`/api/v1/records/${record.id}`, "GET", undefined, bearer(other))).status).toBe(200);
    expect((await f.call("/api/v1/records", "GET", undefined, bearer(source))).status).toBe(200);
  });
}
test("identical concurrent requests persist once, conflict on different payload and survive restart", async () => {
  const p = payload();
  const responses = await Promise.all(Array.from({ length: 6 }, () => f.call("/api/v1/records", "POST", p, bearer("codex"))));
  expect(responses.map(r => r.status).sort()).toEqual([200, 200, 200, 200, 200, 201]);
  const records = await Promise.all(responses.map(async r => recordResult.parse(await r.json()).record));
  expect(new Set(records.map(r => r.id)).size).toBe(1);
  expect((await f.call("/api/v1/records", "POST", payload({ kind: "note", title: "Different" }, p.requestId), bearer("codex"))).status).toBe(409);
  f.restart();
  const replay = await f.call("/api/v1/records", "POST", p, bearer("codex"));
  expect(replay.status).toBe(200);
  expect(recordResult.parse(await replay.json()).record).toEqual(recordResult.shape.record.parse(records[0]));
  expect((await f.call("/api/v1/records", "POST", p, bearer("omo"))).status).toBe(201);
});
test("owner session survives restart, has protected cookie and logout revokes", async () => {
  const session = await f.login();
  expect(session.Cookie).toContain("=");
  f.restart();
  expect((await f.call("/api/v1/auth/session", "GET", undefined, session)).status).toBe(200);
  expect((await f.call("/api/v1/auth/session", "DELETE", undefined, session)).status).toBe(204);
  expect((await f.call("/api/v1/auth/session", "GET", undefined, session)).status).toBe(401);
  expect(statSync(f.options.credentialsPath).mode & 0o777).toBe(0o600);
});
test("browser origin, CSRF and failed bearer never permit cookie fallback", async () => {
  expect((await f.call("/api/v1/auth/session", "POST", { token: tokens.owner })).status).toBe(403);
  expect((await f.call("/api/v1/auth/session", "POST", { token: tokens.codex }, { Origin: origin })).status).toBe(403);
  const session = await f.login();
  expect((await f.call("/api/v1/records", "POST", payload(), { Cookie: session.Cookie, Origin: origin })).status).toBe(403);
  expect((await f.call("/api/v1/records", "POST", payload(), { ...session, Origin: "https://evil.example" })).status).toBe(403);
  expect((await f.call("/api/v1/records", "GET", undefined, { ...session, Authorization: "Bearer invalid" })).status).toBe(401);
  expect((await f.call("/api/v1/records", "POST", payload(), { ...bearer("codex"), Origin: "null" })).status).toBe(403);
  expect((await f.call("/api/v1/records", "POST", payload(), bearer("owner"))).status).toBe(403);
});
test("expired sessions fail without timing waits", async () => {
  f.close();
  let now = Date.now();
  f = fixture(10000, () => now);
  const session = await f.login();
  now += 8 * 24 * 60 * 60 * 1000;
  expect((await f.call("/api/v1/auth/session", "GET", undefined, session)).status).toBe(401);
});
test("public listener permits only agent create and own read", async () => {
  for (const route of ["/", "/api/health", "/api/v1/health", "/api/v1/schema", "/api/v1/auth/session", "/api/v1/records"]) {
    expect((await f.call(route, "GET", undefined, bearer("codex"), true)).status).toBe(404);
  }
  expect((await f.call("/api/v1/records", "POST", payload(), bearer("owner"), true)).status).toBe(403);
  const created = await f.call("/api/v1/records", "POST", payload(), bearer("omo"), true);
  expect(created.status).toBe(201);
  const { record } = recordResult.parse(await created.json());
  expect((await f.call(`/api/v1/records/${record.id}`, "GET", undefined, bearer("omo"), true)).status).toBe(200);
  expect((await f.call(`/api/v1/records/${record.id}`, "PATCH", {}, bearer("omo"), true)).status).toBe(404);
});
test("invalid schemas, forged provenance, dates, links, nested fields and relationships are rejected", async () => {
  const invalid = [
    { title: "" }, { title: "a".repeat(201) }, { source: "manual" }, { body: "a".repeat(RECORD_LIMITS.bodyChars + 1) },
    { dueDate: "2026-02-30" }, { links: [{ label: "x", url: "javascript:alert(1)" }] },
    { fields: { today: "yes" } }, { fields: { revisitDate: "2026-13-01" } },
    { fields: { summary: "x".repeat(8193) } }, { fields: { nested: [[[[[[[[[1]]]]]]]]] } },
    { projectId: crypto.randomUUID() }, { taskId: crypto.randomUUID() },
    { kind: "task", fields: { evidenceIds: [crypto.randomUUID()] } },
    { kind: "project", status: "not-a-status" },
  ];
  for (const changes of invalid) {
    const response = await f.call("/api/v1/records", "POST", payload(agentRecord({ title: "Test", ...changes })), bearer("codex"));
    expect(response.status).toBe(400);
    const body = z.object({ error: z.object({ code: z.string(), message: z.string() }) }).parse(await response.json());
    expect(body.error.code).not.toBe("record_incomplete");
  }
});
test("real fields and relationship IDs roundtrip across all three logical collections", async () => {
  const session = await f.login();
  async function create(record: unknown) {
    const response = await f.call("/api/v1/records", "POST", payload(record), session);
    expect(response.status).toBe(201);
    return recordResult.parse(await response.json()).record;
  }
  const project = await create({ kind: "project", title: "Project", status: "planning", body: "Overview", fields: { goal: "Goal", stage: "Prototype", nextAction: "Build", priority: "high", decisions: "Decided" } });
  const evidence = await create({ kind: "research", title: "Evidence", projectId: project.id });
  const fields = { taskType: "project", priority: "normal", today: true, acceptance: "Pass", progress: "Started", result: "Done", evidenceIds: [evidence.id] };
  const task = await create({ kind: "task", title: "Task", status: "review", projectId: project.id, dueDate: "2028-02-29", fields });
  expect(task.fields).toEqual(fields);
  const reportFields = { origin: "x", summary: "Summary", conclusion: "Conclusion", significance: "Useful", questions: "Why", nextActions: "Build", personalNotes: "Memo", savedReason: "Later", starred: true, revisitDate: "2026-09-27" };
  const social = await create({ kind: "social", title: "Social", body: "Details", projectId: project.id, taskId: task.id, fields: reportFields, tags: ["reference"], links: [{ label: "Source", url: "https://example.com/path" }] });
  expect(social.fields).toEqual(reportFields);
  expect(social.source).toBe("manual");
  expect(social.reviewState).toBe("approved");
  expect((await f.call("/api/v1/records", "POST", payload({ kind: "task", title: "Wrong evidence", fields: { evidenceIds: [project.id] } }), session)).status).toBe(400);
  expect((await f.call("/api/v1/records", "POST", payload({ kind: "note", title: "Wrong relation", projectId: task.id }), session)).status).toBe(400);
});
test("patch is atomic and archives/reviews without changing immutable provenance", async () => {
  const session = await f.login();
  const created = await f.call("/api/v1/records", "POST", payload(), bearer("codex"));
  expect(created.status).toBe(201);
  const { record } = recordResult.parse(await created.json());
  const path = `/api/v1/records/${record.id}`;
  expect((await f.call(path, "PATCH", { expectedVersion: 1, changes: { archived: true } }, bearer("codex"))).status).toBe(403);
  const responses = await Promise.all([true, false].map(archived => f.call(path, "PATCH", { expectedVersion: 1, changes: { archived, reviewState: "approved", fields: { starred: true }, tags: ["new"] } }, session)));
  expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
  const current = recordResult.parse(await (await f.call(path, "GET", undefined, session)).json()).record;
  expect(current.version).toBe(2);
  expect(current.reviewState).toBe("approved");
  expect(current.source).toBe("codex");
  expect((await f.call(path, "PATCH", { expectedVersion: 2, changes: { kind: "task" } }, session)).status).toBe(400);
  expect((await f.call(path, "PATCH", { expectedVersion: 2, changes: { archived: false } }, session)).status).toBe(200);
});
const errorBody = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
async function agentCreate(source: "codex" | "omo" | "chatgpt", record: Record<string, unknown> = {}) {
  const response = await f.call("/api/v1/records", "POST", payload(agentRecord(record)), bearer(source));
  expect(response.status).toBe(201);
  return recordResult.parse(await response.json()).record;
}
test("previousId must reference another existing research, work-report, note or social record", async () => {
  const session = await f.login();
  const earlier = await agentCreate("codex", { title: "앞 조사" });
  const next = await agentCreate("omo", { kind: "note", title: "이어지는 메모", fields: { previousId: earlier.id } });
  expect(next.fields.previousId).toBe(earlier.id);
  const project = recordResult.parse(await (await f.call("/api/v1/records", "POST", payload({ kind: "project", title: "P" }), session)).json()).record;
  for (const previousId of [crypto.randomUUID(), project.id]) {
    const response = await f.call("/api/v1/records", "POST", payload(agentRecord({ fields: { previousId } })), bearer("codex"));
    expect(response.status).toBe(400);
    expect(errorBody.parse(await response.json()).error).toEqual({ code: "invalid_relationship",
      message: "previousId must reference an existing research, work-report, note or social record" });
  }
  const self = await f.call(`/api/v1/records/${earlier.id}`, "PATCH", { expectedVersion: 1, changes: { fields: { ...earlier.fields, previousId: earlier.id } } }, session);
  expect(errorBody.parse(await self.json()).error.code).toBe("invalid_relationship");
  const task = await f.call("/api/v1/records", "POST", payload(agentRecord({ kind: "task", fields: { previousId: earlier.id } })), bearer("codex"));
  expect(errorBody.parse(await task.json()).error.message).toContain("fields.previousId: not part of the task format");
});
test("an agent edits its own record, which returns to pending while owner marks stay", async () => {
  const session = await f.login();
  const created = await agentCreate("codex", { fields: { summary: "처음 요약" } });
  const path = `/api/v1/records/${created.id}`;
  const marks = { starred: true, revisitDate: "2026-10-05", personalNotes: "내 메모" };
  const reviewed = await f.call(path, "PATCH", { expectedVersion: 1, changes: { reviewState: "approved", fields: { ...created.fields, ...marks } } }, session);
  expect(reviewed.status).toBe(200);
  // The agent reads the record and sends its body back with its own changes and a stale view of the owner marks.
  const read = recordResult.parse(await (await f.call(path, "GET", undefined, bearer("codex"))).json()).record;
  const { title, body, status, projectId, taskId, dueDate, tags, links, fields } = read;
  const edited = await f.call(path, "PATCH", { expectedVersion: read.version, changes: {
    title: "고친 조사", body, status, projectId, taskId, dueDate, tags, links, fields: { ...fields, summary: "고친 요약", starred: false, personalNotes: "덮어쓰기" } } }, bearer("codex"));
  expect(edited.status).toBe(200);
  const record = recordResult.parse(await edited.json()).record;
  expect(record).toMatchObject({ title: "고친 조사", version: 3, reviewState: "pending", source: "codex", createdBy: "codex" });
  expect(record.fields).toEqual({ ...created.fields, ...marks, summary: "고친 요약" });
  const titleOnly = recordResult.parse(await (await f.call(path, "PATCH", { expectedVersion: 3, changes: { title: "제목만" } }, bearer("codex"))).json()).record;
  expect(titleOnly).toMatchObject({ version: 4, fields: record.fields });
  expect((await f.call(path, "PATCH", { expectedVersion: 4, changes: { title: "주인 수정" } }, session)).status).toBe(200);
});
test("agent edits are refused for other agents' records, review changes, stale versions and format violations", async () => {
  const created = await agentCreate("codex");
  const path = `/api/v1/records/${created.id}`;
  const cases: [HeadersInit, unknown, number, string][] = [
    [bearer("omo"), { expectedVersion: 1, changes: { title: "남의 기록" } }, 403, "forbidden"],
    [bearer("codex"), { expectedVersion: 1, changes: { reviewState: "approved" } }, 403, "forbidden"],
    [bearer("codex"), { expectedVersion: 1, changes: { archived: true } }, 403, "forbidden"],
    [bearer("codex"), { expectedVersion: 2, changes: { title: "Stale" } }, 409, "version_conflict"],
    [bearer("codex"), { expectedVersion: 1, changes: { fields: { ...created.fields, verificationStatus: "검증" } } }, 400, "record_incomplete"],
    [bearer("codex"), { expectedVersion: 1, changes: { fields: { ...created.fields, starred: true } } }, 400, "record_incomplete"],
    [bearer("codex"), { expectedVersion: 1, changes: { title: "가".repeat(21) } }, 400, "title_too_long"],
  ];
  for (const [headers, body, status, code] of cases) {
    const response = await f.call(path, "PATCH", body, headers);
    expect(response.status).toBe(status);
    const { error } = errorBody.parse(await response.json());
    expect(error.code).toBe(code);
    if (code === "record_incomplete") expect(error.message).toStartWith("Edit does not follow the agent record format; fix every item and send it again: fields.");
  }
  expect((await f.call(path, "PATCH", { expectedVersion: 1, changes: { title: "Public" } }, bearer("codex"), true)).status).toBe(404);
  const current = recordResult.parse(await (await f.call(path, "GET", undefined, bearer("codex"))).json()).record;
  expect(current).toMatchObject({ version: 1, title: created.title, fields: created.fields });
});
test("pagination filters avoid duplicates and reject invalid query/cursor", async () => {
  const session = await f.login();
  for (let index = 0; index < 7; index++) {
    expect((await f.call("/api/v1/records", "POST", payload({ kind: "task", title: `Needle ${index}`, status: "todo", dueDate: "2026-09-21" }), session)).status).toBe(201);
  }
  const pageSchema = z.object({ items: z.array(z.object({ id: z.string() })), nextCursor: z.string().nullable() });
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const response = await f.call(`/api/v1/records?kind=task&q=Needle&dueFrom=2026-09-20&dueTo=2026-09-22&limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, "GET", undefined, session);
    expect(response.status).toBe(200);
    const page = pageSchema.parse(await response.json());
    ids.push(...page.items.map(r => r.id));
    cursor = page.nextCursor;
  } while (cursor);
  expect(ids.length).toBe(7);
  expect(new Set(ids).size).toBe(7);
  for (const query of ["limit=51", "limit=0", "kind=wrong", "dueFrom=2026-02-30", "cursor=garbage", "archived=no", "unknown=x"]) {
    expect((await f.call(`/api/v1/records?${query}`, "GET", undefined, session)).status).toBe(400);
  }
});
test("transport rejects Host, media type, malformed JSON, oversized body and unauthenticated access", async () => {
  expect((await f.call("/api/health", "GET", undefined, { Host: "evil.example" })).status).toBe(421);
  expect((await f.call("/api/v1/records")).status).toBe(401);
  for (const [body, contentType, expected] of [["{", "application/json", 400], ["{}", "text/plain", 415], ["x".repeat(RECORD_LIMITS.requestBytes + 1), "application/json", 413]] as const) {
    const response = await f.app.fetch(new Request(`${origin}/api/v1/records`, { method: "POST", headers: { ...bearer("codex"), "Content-Type": contentType }, body }));
    expect(response.status).toBe(expected);
  }
});
test("request rate limit produces 429", async () => {
  f.close(); f = fixture(2);
  const statuses = [];
  for (let index = 0; index < 3; index++) statuses.push((await f.call("/api/v1/records", "POST", payload(), bearer("omo"))).status);
  expect(statuses).toEqual([201, 201, 429]);
});

test("partial patch preserves omitted values and original idempotent response", async () => {
  const session = await f.login();
  const p = payload(agentRecord({ title: "Original", body: "Keep body", dueDate: "2026-09-22",
    tags: ["keep"], fields: { summary: "Keep" }, links: [{ label: "Keep", url: "https://example.com" }] }));
  const created = await f.call("/api/v1/records", "POST", p, bearer("codex"));
  expect(created.status).toBe(201);
  const original = recordResult.parse(await created.json()).record;
  const patched = await f.call(`/api/v1/records/${original.id}`, "PATCH", { expectedVersion: 1, changes: { title: "Edited" } }, session);
  expect(patched.status).toBe(200);
  expect(recordResult.parse(await patched.json()).record).toEqual({ ...original, title: "Edited", version: 2 });
  const replay = await f.call("/api/v1/records", "POST", p, bearer("codex"));
  expect(replay.status).toBe(200);
  expect(recordResult.parse(await replay.json()).record).toEqual(original);
});

test("different raw payload conflicts even when normalization yields same record", async () => {
  const p = payload(agentRecord({ kind: "note", title: "Trimmed" }));
  expect((await f.call("/api/v1/records", "POST", p, bearer("omo"))).status).toBe(201);
  const changed = payload(agentRecord({ kind: "note", title: " Trimmed " }), p.requestId);
  expect((await f.call("/api/v1/records", "POST", changed, bearer("omo"))).status).toBe(409);
});
