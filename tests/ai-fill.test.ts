import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAiFill, weakness, type ModelRunner } from "../server/ai-fill";
import { createApp } from "../server/app";
import { pageText } from "../server/capture-enrichment";
import { Store } from "../server/store";
import type { RecordInput } from "../shared/contracts";
import { tokens } from "./backend-helper";

const dirs: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function store() {
  const dir = mkdtempSync(join(tmpdir(), "agentic-ai-fill-"));
  dirs.push(dir);
  const created = new Store(join(dir, "db.sqlite"), () => Date.parse("2026-09-27T12:00:00Z"));
  created.db.query("INSERT INTO principals(id,source,token_hash) VALUES('owner','manual','x'),('chatgpt','chatgpt','y')").run();
  stores.push(created);
  return created;
}
function save(target: Store, record: Partial<RecordInput> & Pick<RecordInput, "kind" | "title">, source: "manual" | "chatgpt" = "manual") {
  const input = { body: "", status: "new", projectId: null, taskId: null, dueDate: null, tags: [], links: [], fields: {}, ...record };
  return target.create({ id: source === "chatgpt" ? "chatgpt" : "owner", source }, crypto.randomUUID(), input, input).record;
}
const xPost = { kind: "social" as const, title: "jack (@jack) on X", links: [{ label: "원문", url: "https://x.com/jack/status/20" }],
  fields: { origin: "x", summary: "just setting up my twttr" } };
const reply = (value: unknown): ModelRunner => async () => JSON.stringify(value);

test.each([
  ["jack (@jack) on X", "just setting up my twttr", { title: true, summary: false }],
  ["Mark Zuckerberg (@zuck) on Threads", "", { title: true, summary: true }],
  ["ChatGPT", "Shared via ChatGPT", { title: true, summary: true }],
  ["Check out this chat", "Here's a chat someone thought you'd want to see.", { title: true, summary: true }],
  ["x.com/jack/status/20", "", { title: true, summary: true }],
  ["iPhone 단축어 실행하기", "다른 앱에서 단축어를 실행합니다.", null],
] as const)("detects weak link title %p and summary %p", (title, summary, expected) => {
  // Given: a saved link whose metadata came from the page.
  const record = { kind: "social", source: "manual", title, body: "", links: xPost.links, fields: { summary } } as const;
  // When / Then: only placeholder values are selected for filling.
  expect(weakness(record, new Set(["chatgpt"]))).toEqual(expected);
});

test("skips records without readable source and records from other agents", () => {
  // Given: a ChatGPT test note with no body or link, and an OmO report with an empty summary.
  const note = { kind: "note", source: "chatgpt", title: "연결 시험", body: "", links: [], fields: {} } as const;
  const report = { kind: "research", source: "omo", title: "ChatGPT", body: "본문", links: [], fields: {} } as const;
  // When / Then: nothing would be sent to the model.
  expect(weakness(note, new Set(["chatgpt"]))).toBeNull();
  expect(weakness(report, new Set(["chatgpt"]))).toBeNull();
});

test("fills a weak title from the source text and keeps the original values", async () => {
  // Given: an X post saved with the account label as its title.
  const target = store();
  const record = save(target, xPost);
  const prompts: string[] = [];
  const fill = createAiFill({ store: target, sources: ["chatgpt"], model: "test-model",
    read: async () => "og:title: jack (@jack) on X\nog:description: just setting up my twttr",
    run: async (_system: string, prompt: string) => { prompts.push(prompt); return `결과\n{"title":"잭 도시의 첫 트윗","summary":"무시돼야 함"}`; } });
  // When: the saved record is filled.
  fill.enqueue(record.id);
  await fill.idle();
  // Then: the model saw the post text, only the weak title changed, and the original is kept for undo.
  expect(prompts[0]).toContain("just setting up my twttr");
  const filled = target.get(record.id);
  expect(filled.title).toBe("잭 도시의 첫 트윗");
  expect(filled.fields.summary).toBe("just setting up my twttr");
  expect(filled.fields.aiFill).toEqual({ status: "filled", model: "test-model", at: "2026-09-27T12:00:00.000Z", attempts: 1,
    filled: ["title"], original: { title: "jack (@jack) on X", summary: "just setting up my twttr" } });
  expect(filled.reviewState).toBe(record.reviewState);
});

test("fills an empty summary of a ChatGPT save from its body", async () => {
  // Given: a ChatGPT web save titled "ChatGPT" with a body but no summary.
  const target = store();
  const record = save(target, { kind: "note", title: "ChatGPT", body: "Bun 1.4 WebView로 스크린숏을 찍는 방법을 정리했다.", tags: ["Bun"] }, "chatgpt");
  const prompts: string[] = [];
  const fill = createAiFill({ store: target, sources: ["chatgpt"], read: async () => { throw new Error("must not fetch"); },
    run: async (_system: string, prompt: string) => { prompts.push(prompt); return JSON.stringify({ title: "Bun WebView 스크린숏 방법", summary: "Bun 1.4 WebView로 화면을 찍는다.\n별도 브라우저 설치가 필요 없다." }); } });
  // When: the save is filled.
  fill.enqueue(record.id);
  await fill.idle();
  // Then: title and summary follow the fixed format.
  expect(prompts[0]).toContain("WebView로 스크린숏");
  const filled = target.get(record.id);
  expect(filled.title).toBe("Bun WebView 스크린숏 방법");
  expect(filled.fields.summary).toBe("Bun 1.4 WebView로 화면을 찍는다.\n별도 브라우저 설치가 필요 없다.");
  expect(filled.fields.aiFill).toMatchObject({ status: "filled", filled: ["title", "summary"], original: { title: "ChatGPT", summary: "" } });
});

const broken: readonly (readonly [string, ModelRunner])[] = [
  ["a failing model", async () => { throw new Error("offline"); }],
  ["invalid output", reply({ title: "두 줄\n제목", summary: "" })],
  ["an over-long title", reply({ title: "OmO에서 Opus가 한국어 지침을 무시하고 영어로 답하는 원인", summary: "" })],
  ["non-JSON output", async () => "모르겠습니다"],
];
test.each(broken)("keeps the original values after %s and stops retrying after three attempts", async (_name, run) => {
  // Given: a weak record and a model call that cannot produce a valid result.
  const target = store();
  const record = save(target, xPost);
  let calls = 0;
  const fill = createAiFill({ store: target, sources: ["chatgpt"], read: async () => "og:description: just setting up my twttr",
    run: async (system: string, prompt: string, signal: AbortSignal) => { calls++; return await run(system, prompt, signal); } });
  // When: the fill is attempted on save and on two later sweeps, then swept again.
  fill.enqueue(record.id);
  for (let sweep = 0; sweep < 3; sweep++) { await fill.idle(); fill.sweep(); }
  await fill.idle();
  // Then: the saved values are unchanged, and failures are bounded.
  const kept = target.get(record.id);
  expect(kept.title).toBe("jack (@jack) on X");
  expect(kept.fields.aiFill).toMatchObject({ status: "failed", attempts: 3 });
  expect(calls).toBe(3);
});

test("does not overwrite a title the owner edited while the model was running", async () => {
  // Given: the model result arrives after the owner renamed the record.
  const target = store();
  const record = save(target, xPost);
  const started = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<string>();
  const fill = createAiFill({ store: target, sources: ["chatgpt"], read: async () => "og:description: just setting up my twttr",
    run: async () => { started.resolve(); return await answer.promise; } });
  // When: the owner edits the title after the model call starts, then the model answers.
  fill.enqueue(record.id);
  await started.promise;
  target.patch(record.id, { expectedVersion: 1, changes: { title: "직접 쓴 제목" } });
  answer.resolve(JSON.stringify({ title: "모델 제목", summary: "" }));
  await fill.idle();
  // Then: the owner's value wins.
  expect(target.get(record.id).title).toBe("직접 쓴 제목");
});

test("does not refill a record the owner reverted", async () => {
  // Given: a filled record reverted to its original title.
  const target = store();
  const record = save(target, { ...xPost, fields: { ...xPost.fields, aiFill: { status: "reverted", attempts: 1 } } });
  let calls = 0;
  const fill = createAiFill({ store: target, sources: ["chatgpt"], read: async () => "", run: async () => { calls++; return "{}"; } });
  // When: records are swept again.
  fill.sweep();
  await fill.idle();
  // Then: the model is not called.
  expect(target.get(record.id).title).toBe("jack (@jack) on X");
  expect(calls).toBe(0);
});

test("fills a ChatGPT MCP save in the background after the save returns", async () => {
  // Given: an app with a model runner, and a ChatGPT web save titled only "ChatGPT".
  const dir = mkdtempSync(join(tmpdir(), "agentic-ai-fill-app-"));
  dirs.push(dir);
  writeFileSync(join(dir, "credentials.json"), JSON.stringify({ owner: tokens.owner }), { mode: 0o600 });
  const answer = Promise.withResolvers<string>();
  const app = createApp({ databasePath: join(dir, "db.sqlite"), credentialsPath: join(dir, "credentials.json"), mcpAgent: "chatgpt",
    aiFill: { run: async () => await answer.promise, read: async () => "", sources: ["chatgpt"] } });
  app.agents.add("chatgpt", tokens.chatgpt);
  try {
    // When: save_record returns before the model answers.
    const response = await app.mcpFetch(new Request("http://127.0.0.1:4313/mcp", { method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "save_record",
        arguments: { requestId: "ai-fill-1", record: { kind: "note", title: "ChatGPT", body: "Bun 테스트 러너의 스냅샷 갱신 방법.", tags: ["Bun"] } } } }) }));
    const saved = await response.json() as { result: { structuredContent: { id: string; title: string } } };
    expect(saved.result.structuredContent.title).toBe("ChatGPT");
    answer.resolve(JSON.stringify({ title: "Bun 스냅샷 갱신 방법", summary: "bun test --update-snapshots로 갱신한다." }));
    await app.aiFill?.idle();
    // Then: the stored record carries the filled values.
    const response2 = await app.mcpFetch(new Request("http://127.0.0.1:4313/mcp", { method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_record", arguments: { id: saved.result.structuredContent.id } } }) }));
    expect(JSON.stringify(await response2.json())).toContain("Bun 스냅샷 갱신 방법");
  } finally { app.close(); }
});

test("clears share boilerplate when the source holds only a title", async () => {
  // Given: a ChatGPT share link whose summary is the share page's boilerplate.
  const target = store();
  const record = save(target, { kind: "social", title: "Check out this chat", links: [{ label: "원문", url: "https://chatgpt.com/share/a" }],
    fields: { summary: "Shared via ChatGPT" } });
  const fill = createAiFill({ store: target, sources: ["chatgpt"], read: async () => "title: ChatGPT - Rerank API", run: reply({ title: "Rerank API", summary: "" }) });
  // When: the model finds nothing beyond the title.
  fill.enqueue(record.id);
  await fill.idle();
  // Then: the boilerplate is removed and kept as the original.
  const filled = target.get(record.id);
  expect(filled.fields.summary).toBe("");
  expect(filled.fields.aiFill).toMatchObject({ filled: ["title", "summary"], original: { summary: "Shared via ChatGPT" } });
});

test("page text lists title, metadata and visible body text for the model", async () => {
  // Given: a share page whose useful title is only in <title>.
  const html = `<title>ChatGPT - CLI Local Business Search</title><meta property="og:title" content="Check out this chat">
    <meta property="og:description" content="Shared via ChatGPT"><script>secret()</script><main><p>Find shops from a terminal.</p></main>`;
  // When: model input is built from it.
  const text = await pageText(html);
  // Then: every candidate is present, scripts are not.
  expect(text).toContain("title: ChatGPT - CLI Local Business Search");
  expect(text).toContain("og:title: Check out this chat");
  expect(text).toContain("본문: Find shops from a terminal.");
  expect(text).not.toContain("secret");
});
