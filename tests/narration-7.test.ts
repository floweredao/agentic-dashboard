
import { afterEach, expect, test } from "bun:test";

import { z } from "zod";
import { DashboardRecordSchema } from "../shared/contracts";
import { listeningSource, ProviderError } from "../server/narration";

import { agentRecord, bearer, fixture, payload, recordResult } from "./backend-helper";
import { cleanupNarration, fake, wavOnly, cleanups, setup, read, narration, AUTO } from "./narration-helper";
afterEach(cleanupNarration);

test("with records set to read only their summary, the script leaves the body out; back on the full document the body is read", async () => {
  const { f, tts, idle } = (await setup());
  const owner = await f.login();
  const record = recordResult.parse(await (await f.call("/api/v1/records", "POST", payload(agentRecord({
    title: "Scope research", body: "A sentence only in the body.", fields: { summary: "A sentence in the summary", conclusion: "The conclusion", nextActions: "- none" } })), bearer("omo"))).json()).record;
  expect((await f.call(AUTO, "PUT", { digests: "off", records: "off", scope: "summary" }, owner)).status).toBe(200);
  // When: the owner asks for the record's audio under Summary only.
  expect((await f.call(narration(record.id), "POST", { style: "read" }, owner)).status).toBe(202);
  await idle();
  // Then: the script was written from the summary fields only.
  expect(tts.calls.prompts[0]).toContain("A sentence in the summary");
  expect(tts.calls.prompts[0]).not.toContain("A sentence only in the body");
  expect((await read(await f.call(narration(record.id), "GET", undefined, owner))).narration?.status).toBe("ready");
  // When: the scope goes back to the full document and the owner asks again without forcing.
  expect((await f.call(AUTO, "PUT", { digests: "off", records: "off", scope: "full" }, owner)).status).toBe(200);
  expect((await f.call(narration(record.id), "POST", { style: "read" }, owner)).status).toBe(202);
  await idle();
  // Then: a new script covers the body.
  expect(tts.calls.prompts[1]).toContain("A sentence only in the body");
});

test("with new-record audio defaulting to read, research, work reports, notes and social posts get read audio on save; tasks get none", async () => {
  // Given: the server default for new records is read and the owner never saved a choice.
  const { f, tts, idle } = (await setup(undefined, { autoDefaults: { digests: "parts", records: "read" } }));
  const owner = await f.login();
  expect(await (await f.call(AUTO, "GET", undefined, owner)).json()).toEqual({ digests: "parts", records: "read", scope: "full" });
  // When: OmO saves one record of each narratable kind and a task.
  const save = async (record: Record<string, unknown>) =>
    recordResult.parse(await (await f.call("/api/v1/records", "POST", payload(agentRecord(record)), bearer("omo"))).json()).record;
  const saved = [await save({ title: "조사" }), await save({ kind: "work-report", title: "보고" }), await save({ kind: "note", title: "메모" }),
    await save({ kind: "social", title: "글", links: [{ label: "원문", url: "https://x.com/a/status/1" }] })];
  await save({ kind: "task", title: "할 일" });
  await idle();
  // Then: each of the four has read audio, and only those four scripts were written.
  for (const record of saved) {
    expect((await read(await f.call(narration(record.id), "GET", undefined, owner))).narration).toMatchObject({ status: "ready", style: "read" });
  }
  expect(tts.calls.script).toBe(4);
});

test("an edit that changes what the audio reads makes it again; an edit of tags or stars does not", async () => {
  const { f, tts, idle } = (await setup(undefined, { autoDefaults: { records: "read" } }));
  const owner = await f.login();
  const record = recordResult.parse(await (await f.call("/api/v1/records", "POST", payload(agentRecord({ title: "수정 조사", body: "첫 본문" })), bearer("omo"))).json()).record;
  await idle();
  expect(tts.calls.script).toBe(1);
  const patch = async (version: number, changes: Record<string, unknown>, headers: HeadersInit) => {
    const response = await f.call(`/api/v1/records/${record.id}`, "PATCH", { expectedVersion: version, changes }, headers);
    expect(response.status).toBe(200);
    return recordResult.parse(await response.json()).record.version;
  };
  // When: the owner changes tags and stars it.
  let version = await patch(record.version, { tags: ["새태그"], fields: { ...record.fields, starred: true } }, owner);
  await idle();
  // Then: no new script.
  expect(tts.calls.script).toBe(1);
  // When: OmO rewrites the body, then the owner changes the title.
  version = await patch(version, { body: "고친 본문입니다." }, bearer("omo"));
  await idle();
  expect(tts.calls.script).toBe(2);
  expect(tts.calls.prompts[1]).toContain("고친 본문입니다.");
  await patch(version, { title: "새 제목" }, owner);
  await idle();
  // Then: each content edit made the audio again, in the record's style, and it is not stale.
  expect(tts.calls.script).toBe(3);
  expect((await read(await f.call(narration(record.id), "GET", undefined, owner))).narration).toMatchObject({ status: "ready", style: "read", stale: false });
});

test("a new record's audio that was refused or failed is tried again later, and not once records are switched off", async () => {
  const { f, tts, idle } = (await setup(undefined, { autoDefaults: { records: "read" } }));
  const owner = await f.login();
  const save = async (title: string) =>
    recordResult.parse(await (await f.call("/api/v1/records", "POST", payload(agentRecord({ title })), bearer("omo"))).json()).record;
  // Given: one record saved while no key works, another whose speech fails for good once.
  tts.available = false;
  const refused = await save("키 없음");
  await idle();
  expect((await read(await f.call(narration(refused.id), "GET", undefined, owner))).narration).toBeNull();
  tts.available = true;
  tts.speakErrors = [new ProviderError("http_400", false)];
  const failed = await save("한 번 실패");
  await idle();
  expect((await read(await f.call(narration(failed.id), "GET", undefined, owner))).narration).toMatchObject({ status: "failed", attempts: 1 });
  // When: the later retry runs.
  (await f.app.narration.retryDeferred());
  await idle();
  // Then: both now have audio, and nothing is left to retry.
  for (const record of [refused, failed]) {
    expect((await read(await f.call(narration(record.id), "GET", undefined, owner))).narration?.status).toBe("ready");
  }
  const scripts = tts.calls.script;
  (await f.app.narration.retryDeferred());
  await idle();
  expect(tts.calls.script).toBe(scripts);
  // When: a record is refused, the owner turns new-record audio off, and the retry runs.
  tts.available = false;
  const off = await save("꺼짐");
  await idle();
  tts.available = true;
  expect((await f.call(AUTO, "PUT", { digests: "off", records: "off", scope: "full" }, owner)).status).toBe(200);
  (await f.app.narration.retryDeferred());
  await idle();
  // Then: it gets no audio.
  expect((await read(await f.call(narration(off.id), "GET", undefined, owner))).narration).toBeNull();
});

test("a ChatGPT save whose title the AI fills gets its audio once, after the fill, with the filled title", async () => {
  const tts = fake();
  const f = (await fixture(10000, Date.now, { narration: { provider: tts.provider, encode: wavOnly, retryDelayMs: 0, autoDefaults: { records: "read" } },
    aiFill: { sources: ["chatgpt"], run: async () => JSON.stringify({ title: "채워진 제목", summary: "채워진 요약" }), read: async () => "" } }));
  cleanups.push(async () => (await f.close()));
  const response = await f.call("/api/v1/records", "POST", payload({ kind: "note", title: "ChatGPT", body: "Bun으로 서버를 띄우는 방법을 정리했다.", tags: ["Bun"] }), bearer("chatgpt"));
  expect(response.status).toBe(201);
  await f.app.aiFill?.idle();
  await f.app.narration.idle();
  expect(tts.calls.script).toBe(1);
  expect(tts.calls.prompts[0]).toContain("채워진 제목");
});

test("the listening source leaves out how the work was done (verification, method, what was kept or deleted, grade legend), lane tags and citation tags", () => {
  const body = [
    "## 결론", "결론 문단입니다 [D6].", "## 근거 강도 표시", "- A: 무작위 대조 시험", "## 1. 열린 고리 (레인 r2·r5)", "계획을 세우면 줄었다 [A/D].",
    "## 서로 어긋나는 근거", "두 연구가 어긋난다.", "## 형 결정", "1. 고를 것", "## 검증", "레인 여덟 개가 확인했다.", "## 조사 방법·한계", "브라우저를 쓰지 못했다.",
    "## 못 한 것·한계", "효과크기를 다시 계산하지 않았다.", "## 남긴 것과 지운 것", "- 보고서만 남김", "## 남긴 것·지운 것", "- 폴더 지움",
  ].join("\n");
  expect(listeningSource(body)).toBe([
    "## 결론", "결론 문단입니다.", "## 1. 열린 고리", "계획을 세우면 줄었다.", "## 서로 어긋나는 근거", "두 연구가 어긋난다.", "## 형 결정", "1. 고를 것",
  ].join("\n"));
});

test("a record's link labels never reach the script model as a source line", async () => {
  const { f, tts, idle } = (await setup());
  const owner = await f.login();
  const response = await f.call("/api/v1/records", "POST", { requestId: crypto.randomUUID(), record: {
    kind: "research", title: "조사", body: "## 본문\n본문 문단입니다.", fields: { summary: "요약", conclusion: "결론" },
    links: [{ label: "platform.claude.com", url: "https://platform.claude.com/docs" }],
  } }, owner);
  const record = recordResult.parse(await response.json()).record;
  expect((await f.call(narration(record.id), "POST", {}, owner)).status).toBe(202);
  await idle();
  expect(tts.calls.prompts[0]).toContain("본문 문단입니다.");
  expect(tts.calls.prompts[0]).not.toContain("platform.claude.com");
  expect(tts.calls.prompts[0]).not.toContain("출처");
});

test("MCP record creation and text edits use automatic audio", async () => {
  const { f, tts, idle } = (await setup(undefined, { autoDefaults: { records: "read" } }));
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await f.app.mcpFetch(new Request("http://127.0.0.1:4313/mcp", {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }));
    expect(response.status).toBe(200);
    return z.object({ result: z.object({ isError: z.literal(false), structuredContent: z.object({ id: z.string(), version: z.number().optional() }) }) }).parse(await response.json()).result.structuredContent;
  };
  // Given: a newly saved note whose audio has finished.
  const saved = await call("save_record", { requestId: "auto-mcp", record: agentRecord({ kind: "note", title: "MCP note", body: "Initial content." }) });
  await idle();
  const owner = await f.login();
  const record = recordResult.parse(await (await f.call(`/api/v1/records/${saved.id}`, "GET", undefined, owner)).json()).record;
  expect(tts.calls.script).toBe(1);
  // When: the same MCP agent edits its text.
  await call("update_record", { id: saved.id, expectedVersion: record.version, changes: { body: "Changed content." } });
  await idle();
  // Then: the new audio reflects that version rather than staying stale.
  expect(tts.calls.script).toBe(2);
  expect((await read(await f.call(narration(saved.id), "GET", undefined, owner))).narration).toMatchObject({ status: "ready", stale: false });
});

test("a trusted capture gets automatic audio after enrichment", async () => {
  // Given: a trusted capture listener and automatic read audio.
  const tts = fake();
  const f = (await fixture(10000, Date.now, { privateOrigin: "https://capture.example.test",
    trustedIdentity: { header: "X-Verified-User", login: "owner@example.test" },
    enrichCapture: async () => ({ title: "Captured article", fields: { summary: "A captured summary.", captureEnrichment: { status: "available", source: "page" } } }),
    narration: { provider: tts.provider, encode: wavOnly, retryDelayMs: 0, autoDefaults: { records: "read" } } }));
  cleanups.push(async () => (await f.close()));
  // When: the native client saves a URL.
  const response = await f.app.fetch(new Request("https://capture.example.test/api/v1/capture", { method: "POST",
    headers: { Host: "capture.example.test", "X-Verified-User": "owner@example.test", "X-Capture": "v1", "Content-Type": "application/json" },
    body: JSON.stringify({ url: "https://example.com/article" }) }));
  expect(response.status).toBe(201);
  const record = z.object({ record: DashboardRecordSchema }).parse(await response.json()).record;
  await f.app.narration.idle();
  // Then: its social record was narrated once.
  expect(tts.calls.script).toBe(1);
  expect((await f.app.narration.state(record)).narration).toMatchObject({ status: "ready", style: "read" });
});
