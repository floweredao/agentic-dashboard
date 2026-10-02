import { afterAll, afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { Store } from "../server/store";
import { RecordInputSchema, TITLE_MAX_WIDTH, schemaInfo, titleWidth } from "../shared/contracts";
import { agentRecord, bearer, fixture, payload, recordResult } from "./backend-helper";

let f = fixture();
afterEach(() => { f.close(); f = fixture(); });
afterAll(() => f.close());

const longTitle = "OmO에서 Opus가 한국어 지침을 무시하고 영어로 답하는 원인";
const errorBody = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

test("titleWidth counts wide characters as two columns", () => {
  expect(TITLE_MAX_WIDTH).toBe(40);
  expect(schemaInfo.agentTitle).toEqual({ maxWidth: 40, wideCharacterWidth: 2 });
  expect(titleWidth("abc 123")).toBe(7);
  expect(titleWidth("한국어")).toBe(6);
  expect(titleWidth("Opus 한국어")).toBe(11);
  expect(titleWidth("日本語かな")).toBe(10);
  expect(titleWidth("ＡＢ")).toBe(4);
  expect(titleWidth("🚀")).toBe(2);
  expect(titleWidth(longTitle)).toBe(56);
  expect(RecordInputSchema.safeParse({ kind: "note", title: "가".repeat(100) }).success).toBe(true);
});

async function save(source: "omo" | "codex" | "chatgpt", title: string, requestId = crypto.randomUUID()) {
  return await f.call("/api/v1/records", "POST", payload(agentRecord({ title }), requestId), bearer(source));
}

test("agent creates over 40 columns are rejected with title_too_long", async () => {
  const response = await save("omo", longTitle);
  expect(response.status).toBe(400);
  const error = errorBody.parse(await response.json()).error;
  expect(error.code).toBe("title_too_long");
  expect(error.message).toContain("56 columns");
  for (const source of ["codex", "chatgpt"] as const) expect((await save(source, longTitle)).status).toBe(400);
});

test("concise and boundary titles are accepted", async () => {
  expect((await save("omo", "Opus 한국어 지침 무시 원인")).status).toBe(201);
  expect((await save("omo", "가".repeat(20))).status).toBe(201);
  expect((await save("omo", `${"가".repeat(20)}a`)).status).toBe(400);
});

test("owner titles are not limited", async () => {
  const response = await f.call("/api/v1/records", "POST", payload({ kind: "note", title: longTitle }), await f.login());
  expect(response.status).toBe(201);
  expect(recordResult.parse(await response.json()).record.title).toBe(longTitle);
});

test("a replay of an earlier save stays successful", () => {
  const store = new Store(":memory:", Date.now);
  store.db.query("INSERT INTO principals(id,source,token_hash) VALUES('omo','omo','x')").run();
  const input = RecordInputSchema.parse({ kind: "research", title: longTitle });
  const first = store.create({ id: "omo", source: "manual" }, "req-1", input, input);
  const again = store.create({ id: "omo", source: "omo" }, "req-1", input, input);
  expect(again).toMatchObject({ replayed: true, record: { id: first.record.id } });
  expect(() => store.create({ id: "omo", source: "omo" }, "req-2", input, { ...input, x: 1 })).toThrow(expect.objectContaining({ code: "title_too_long", status: 400 }));
});

test("MCP save_record surfaces title_too_long as a tool error", async () => {
  const body = { jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "save_record", arguments: { requestId: "chat-title-1", record: { kind: "research", title: longTitle } } } };
  const response = await f.app.mcpFetch(new Request("http://127.0.0.1:4313/mcp", { method: "POST", body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" } }));
  expect(response.status).toBe(200);
  const result = z.object({ result: z.object({ isError: z.boolean(), content: z.array(z.object({ text: z.string() })) }) }).parse(await response.json()).result;
  expect(result.isError).toBe(true);
  expect(result.content[0]?.text).toContain("title_too_long");
});
