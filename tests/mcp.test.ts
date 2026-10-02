import { afterAll, afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { agentRecord, fixture, payload, recordResult } from "./backend-helper";

let f = fixture();
afterEach(() => { f.close(); f = fixture(); });
afterAll(() => f.close());

const mcpUrl = "http://127.0.0.1:4313/mcp";
const legacy = "2025-06-18";
const stateless = "2026-07-28";
const rpcResult = z.object({ jsonrpc: z.literal("2.0"), id: z.union([z.string(), z.number()]), result: z.record(z.string(), z.unknown()) });
const rpcError = z.object({ jsonrpc: z.literal("2.0"), id: z.union([z.string(), z.number(), z.null()]),
  error: z.object({ code: z.number(), message: z.string() }) });
const toolResult = z.object({ isError: z.boolean().optional(), structuredContent: z.record(z.string(), z.unknown()).optional(),
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })) });

async function post(body: unknown, headers: HeadersInit = {}) {
  const h = new Headers({ "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...Object.fromEntries(new Headers(headers)) });
  return await f.app.mcpFetch(new Request(mcpUrl, { method: "POST", headers: h, body: JSON.stringify(body) }));
}
let nextId = 1;
async function rpc(method: string, params: Record<string, unknown> = {}, headers: HeadersInit = {}) {
  const response = await post({ jsonrpc: "2.0", id: nextId++, method, params }, headers);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/json");
  return rpcResult.parse(await response.json()).result;
}
async function call(name: string, args: Record<string, unknown>, version = legacy) {
  const params = version === stateless
    ? { name, arguments: args, _meta: { "io.modelcontextprotocol/protocolVersion": stateless } }
    : { name, arguments: args };
  return toolResult.parse(await rpc("tools/call", params, { "MCP-Protocol-Version": version }));
}
async function ownerRecord(record: Record<string, unknown>) {
  const response = await f.call("/api/v1/records", "POST", payload(record), await f.login());
  expect(response.status).toBe(201);
  return recordResult.parse(await response.json()).record;
}

test("legacy initialize handshake and stateless discovery both advertise tools", async () => {
  const init = await rpc("initialize", { protocolVersion: legacy, capabilities: {}, clientInfo: { name: "test", version: "1" } });
  expect(init.protocolVersion).toBe(legacy);
  expect(init.capabilities).toEqual({ tools: { listChanged: false } });
  expect(z.object({ name: z.string() }).parse(init.serverInfo).name).toBe("agentic-dashboard");
  expect(z.string().parse(init.instructions)).toContain("save_record");
  const unknownVersion = await rpc("initialize", { protocolVersion: "1999-01-01", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  expect(unknownVersion.protocolVersion).toBe("2025-11-25");
  const initialized = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  expect(initialized.status).toBe(202);
  expect(await initialized.text()).toBe("");
  const discover = await rpc("server/discover", { _meta: { "io.modelcontextprotocol/protocolVersion": stateless } });
  expect(z.array(z.string()).parse(discover.supportedVersions)).toEqual(expect.arrayContaining([legacy, "2025-11-25", stateless]));
  expect(discover.resultType).toBe("complete");
  expect(await rpc("ping")).toEqual({});
});

test("tools/list exposes save, update, get and search with read-only hints", async () => {
  const list = await rpc("tools/list");
  const tools = z.array(z.object({ name: z.string(), inputSchema: z.object({ type: z.literal("object") }).passthrough(),
    annotations: z.object({ readOnlyHint: z.boolean() }).passthrough() }).passthrough()).parse(list.tools);
  expect(tools.map(tool => tool.name)).toEqual(["save_record", "update_record", "get_record", "search_records"]);
  expect(Object.fromEntries(tools.map(tool => [tool.name, tool.annotations.readOnlyHint])))
    .toEqual({ save_record: false, update_record: false, get_record: true, search_records: true });
  expect(tools[1]?.annotations).toMatchObject({ destructiveHint: false, idempotentHint: false, openWorldHint: false });
  expect(list.cacheScope).toBe("private");
  expect(typeof list.ttlMs).toBe("number");
});

for (const version of [legacy, stateless]) test(`save_record (${version}) attributes ChatGPT and replays by requestId`, async () => {
  const args = { requestId: "chat-1-save-1", record: agentRecord({ title: "MCP 저장", fields: { summary: "요약" } }) };
  const first = await call("save_record", args, version);
  expect(first.isError).toBe(false);
  const saved = z.object({ id: z.string().uuid(), replayed: z.boolean(), source: z.string(), reviewState: z.string() }).parse(first.structuredContent);
  expect(saved).toMatchObject({ replayed: false, source: "chatgpt", reviewState: "pending" });
  expect(JSON.parse(first.content[0]?.text ?? "{}")).toEqual(first.structuredContent);
  const replay = await call("save_record", args, version);
  expect(replay.structuredContent).toMatchObject({ id: saved.id, replayed: true });
  const conflict = await call("save_record", { ...args, record: { kind: "note", title: "Different" } }, version);
  expect(conflict.isError).toBe(true);
  expect(conflict.content[0]?.text).toContain("idempotency_conflict");
  const stored = await f.call(`/api/v1/records/${saved.id}`, "GET", undefined, await f.login());
  expect(recordResult.parse(await stored.json()).record).toMatchObject({ source: "chatgpt", createdBy: "chatgpt", title: "MCP 저장" });
});

test("save_record merges an identical ChatGPT save sent again with a new requestId within ten minutes", async () => {
  // Given: a controllable clock, and ChatGPT already saved a note.
  let clock = Date.parse("2026-09-27T11:58:33Z");
  f.close();
  f = fixture(10000, () => clock);
  const record = agentRecord({ kind: "note", title: "연결 시험" });
  const first = z.object({ id: z.string().uuid() }).parse((await call("save_record", { requestId: "connection-test-b79c", record })).structuredContent);
  // When: a second run sends the same record 23 seconds later under a fresh requestId, then again after the window.
  clock += 23000;
  const again = await call("save_record", { requestId: "connection-test-c91e", record });
  const different = await call("save_record", { requestId: "connection-test-d02f", record: { ...record, body: "다른 내용" } });
  clock += 10 * 60000;
  const later = await call("save_record", { requestId: "connection-test-e13a", record });
  // Then: only the repeat inside the window returns the existing record.
  expect(again.structuredContent).toMatchObject({ id: first.id, replayed: true });
  expect(different.structuredContent).toMatchObject({ replayed: false });
  expect(later.structuredContent).toMatchObject({ replayed: false });
  const list = await f.call("/api/v1/records?archived=all", "GET", undefined, await f.login());
  expect(z.object({ items: z.array(z.unknown()) }).parse(await list.json()).items).toHaveLength(3);
});

test("save_record returns the agent format problems to ChatGPT without persisting", async () => {
  // Given: ChatGPT sends a research result with only a title, as its connector description used to allow.
  const incomplete = await call("save_record", { requestId: "bare-1", record: { kind: "research", title: "제목만 있는 조사" } });
  // Then: the tool error names the format code and each missing part, and nothing is stored.
  expect(incomplete.isError).toBe(true);
  expect(incomplete.content[0]?.text).toMatch(/^record_incomplete: .*tags: .*fields\.summary: required/);
  const list = await f.call("/api/v1/records?archived=all", "GET", undefined, await f.login());
  expect(z.object({ items: z.array(z.unknown()) }).parse(await list.json()).items).toHaveLength(0);
});

test("save_record rejects invalid input without persisting", async () => {
  const invalid = await call("save_record", { requestId: "bad-1", record: { kind: "research", title: "" } });
  expect(invalid.isError).toBe(true);
  expect(invalid.content[0]?.text).toContain("invalid_input");
  const missing = await call("save_record", { record: { kind: "research", title: "No request" } });
  expect(missing.isError).toBe(true);
  const list = await f.call("/api/v1/records?archived=all", "GET", undefined, await f.login());
  expect(z.object({ items: z.array(z.unknown()) }).parse(await list.json()).items).toHaveLength(0);
});

test("get_record reads own records, unarchived reports, memos and links, and the owner's tasks and projects", async () => {
  const saved = await call("save_record", { requestId: "own-note", record: agentRecord({ kind: "note", title: "ChatGPT note" }) });
  const ownId = z.object({ id: z.string() }).parse(saved.structuredContent).id;
  expect((await call("get_record", { id: ownId })).structuredContent).toMatchObject({ id: ownId, kind: "note", title: "ChatGPT note" });
  const research = await ownerRecord({ kind: "research", title: "Owner research", body: "Body", fields: { summary: "S", personalNotes: "private" } });
  const got = await call("get_record", { id: research.id });
  expect(got.structuredContent).toMatchObject({ id: research.id, source: "manual", body: "Body", fields: { summary: "S" } });
  expect(JSON.stringify(got.structuredContent)).not.toContain("private");
  const memo = await ownerRecord({ kind: "note", title: "Owner memo", body: "Memo body", fields: { personalNotes: "private memo" } });
  const gotMemo = await call("get_record", { id: memo.id });
  expect(gotMemo.structuredContent).toMatchObject({ id: memo.id, kind: "note", body: "Memo body" });
  expect(JSON.stringify(gotMemo.structuredContent)).not.toContain("private memo");
  const archived = await ownerRecord({ kind: "research", title: "Owner archived" });
  expect((await f.call(`/api/v1/records/${archived.id}`, "PATCH", { expectedVersion: 1, changes: { archived: true } }, await f.login())).status).toBe(200);
  expect((await call("get_record", { id: archived.id })).content[0]?.text).toContain("not_found");
  // Every registered agent works with the owner, so it reads the owner's unarchived tasks and projects too.
  for (const kind of ["task", "project"]) {
    const shared = await ownerRecord({ kind, title: `Owner ${kind}` });
    const result = await call("get_record", { id: shared.id });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({ id: shared.id, kind });
  }
  expect((await call("get_record", { id: "not-a-uuid" })).isError).toBe(true);
});

test("update_record edits ChatGPT's own record by version and cannot touch other records", async () => {
  const saved = z.object({ id: z.string() }).parse((await call("save_record", { requestId: "edit-me", record: agentRecord({ kind: "note", title: "고칠 메모" }) })).structuredContent);
  const read = z.object({ version: z.number(), fields: z.record(z.string(), z.unknown()) }).parse((await call("get_record", { id: saved.id })).structuredContent);
  expect(read.version).toBe(1);
  const updated = await call("update_record", { id: saved.id, expectedVersion: read.version, changes: { body: "고친 본문", fields: { summary: "요약" } } }, stateless);
  expect(updated.isError).toBe(false);
  expect(Object.keys(updated.structuredContent ?? {}).sort()).toEqual(["id", "kind", "reviewState", "source", "title", "updatedAt", "version"]);
  expect(updated.structuredContent).toMatchObject({ id: saved.id, kind: "note", source: "chatgpt", reviewState: "pending", version: 2 });
  expect((await call("get_record", { id: saved.id })).structuredContent).toMatchObject({ body: "고친 본문", version: 2 });
  const stale = await call("update_record", { id: saved.id, expectedVersion: 1, changes: { body: "늦은 수정" } });
  expect(stale.content[0]?.text).toStartWith("version_conflict:");
  const review = await call("update_record", { id: saved.id, expectedVersion: 2, changes: { reviewState: "approved" } });
  expect(review.content[0]?.text).toStartWith("invalid_input:");
  const research = await ownerRecord({ kind: "research", title: "Owner research" });
  const other = await call("update_record", { id: research.id, expectedVersion: 1, changes: { title: "Hijack" } });
  expect(other.isError).toBe(true);
  expect(other.content[0]?.text).toStartWith("forbidden:");
});

test("search_records returns trimmed research/work-report/note/social results and excludes archived", async () => {
  const research = await ownerRecord({ kind: "research", title: "Alpha 조사", body: "long body", fields: { summary: "Alpha summary", personalNotes: "secret" } });
  const report = await ownerRecord({ kind: "work-report", title: "Alpha 보고" });
  const social = await ownerRecord({ kind: "social", title: "Alpha 링크", links: [{ label: "원문", url: "https://example.com/a" }] });
  const note = await ownerRecord({ kind: "note", title: "Alpha note" });
  await ownerRecord({ kind: "task", title: "Alpha task" });
  const archived = await ownerRecord({ kind: "research", title: "Alpha archived" });
  const session = await f.login();
  expect((await f.call(`/api/v1/records/${archived.id}`, "PATCH", { expectedVersion: 1, changes: { archived: true } }, session)).status).toBe(200);
  await ownerRecord({ kind: "research", title: "Beta 조사" });

  const all = await call("search_records", { query: "alpha" });
  const items = z.object({ items: z.array(z.record(z.string(), z.unknown())) }).parse(all.structuredContent).items;
  expect(items.map(item => item.id).sort()).toEqual([research.id, report.id, social.id, note.id].sort());
  const found = items.find(item => item.id === research.id);
  expect(found).toMatchObject({ kind: "research", title: "Alpha 조사", summary: "Alpha summary", source: "manual" });
  expect(found).not.toHaveProperty("body");
  expect(JSON.stringify(items)).not.toContain("secret");
  expect(items.find(item => item.id === social.id)).toMatchObject({ links: [{ label: "원문", url: "https://example.com/a" }] });

  const onlySocial = await call("search_records", { query: "alpha", kind: "social", limit: 5 });
  expect(z.object({ items: z.array(z.object({ id: z.string() }).passthrough()) }).parse(onlySocial.structuredContent).items.map(item => item.id)).toEqual([social.id]);
  const onlyNotes = await call("search_records", { query: "alpha", kind: "note" });
  expect(z.object({ items: z.array(z.object({ id: z.string() }).passthrough()) }).parse(onlyNotes.structuredContent).items.map(item => item.id)).toEqual([note.id]);
  expect((await call("search_records", { kind: "task" })).isError).toBe(true);
  const limited = z.object({ items: z.array(z.unknown()) }).parse((await call("search_records", { limit: 2 })).structuredContent);
  expect(limited.items).toHaveLength(2);
});

test("transport rejects foreign hosts, browser origins, bad versions and non-POST methods", async () => {
  const body = { jsonrpc: "2.0", id: 1, method: "tools/list" };
  const foreign = await f.app.mcpFetch(new Request("http://evil.example/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  expect(foreign.status).toBe(421);
  expect((await post(body, { Origin: "https://chatgpt.com" })).status).toBe(403);
  expect((await post(body, { "MCP-Protocol-Version": "1999-01-01" })).status).toBe(400);
  const unsupported = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "1999-01-01" } } });
  expect(unsupported.status).toBe(200);
  expect(rpcError.parse(await unsupported.json()).error.code).toBe(-32022);
  const get = await f.app.mcpFetch(new Request(mcpUrl, { method: "GET" }));
  expect(get.status).toBe(405);
  expect(get.headers.get("allow")).toBe("POST");
  expect((await f.app.mcpFetch(new Request("http://127.0.0.1:4313/other", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }))).status).toBe(404);
  const text = await f.app.mcpFetch(new Request(mcpUrl, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" }));
  expect(text.status).toBe(415);
  const malformed = await f.app.mcpFetch(new Request(mcpUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" }));
  expect(malformed.status).toBe(400);
  expect(rpcError.parse(await malformed.json()).error.code).toBe(-32700);
  const batch = await post([body]);
  expect(batch.status).toBe(400);
  const unknown = await post({ jsonrpc: "2.0", id: 3, method: "records/delete" });
  expect(rpcError.parse(await unknown.json()).error.code).toBe(-32601);
  const unknownTool = await post({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "patch_record", arguments: {} } });
  expect(rpcError.parse(await unknownTool.json()).error.code).toBe(-32602);
});

test("existing listeners never serve the MCP endpoint", async () => {
  expect((await f.call("/mcp", "POST", { jsonrpc: "2.0", id: 1, method: "tools/list" }, {}, true)).status).toBe(404);
});
