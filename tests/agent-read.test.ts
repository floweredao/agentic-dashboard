import { afterAll, afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { agentRecord, bearer, fixture, payload, recordResult } from "./backend-helper";

let f = fixture();
afterEach(() => { f.close(); f = fixture(); });
afterAll(() => f.close());

const errorBody = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
const listBody = z.object({ items: z.array(recordResult.shape.record), nextCursor: z.string().nullable() });
type Source = "codex" | "omo";

async function agentCreate(source: Source, record: Record<string, unknown> = {}) {
  const response = await f.call("/api/v1/records", "POST", payload(agentRecord(record)), bearer(source));
  expect(response.status).toBe(201);
  return recordResult.parse(await response.json()).record;
}
async function ownerCreate(record: Record<string, unknown>) {
  const response = await f.call("/api/v1/records", "POST", payload(record), await f.login());
  expect(response.status).toBe(201);
  return recordResult.parse(await response.json()).record;
}
async function ownerPatch(id: string, expectedVersion: number, changes: Record<string, unknown>) {
  const response = await f.call(`/api/v1/records/${id}`, "PATCH", { expectedVersion, changes }, await f.login());
  expect(response.status).toBe(200);
  return recordResult.parse(await response.json()).record;
}
const read = (id: string, source: Source, publicOnly = false) => f.call(`/api/v1/records/${id}`, "GET", undefined, bearer(source), publicOnly);
const search = async (query: string, source: Source = "codex") => {
  const response = await f.call(`/api/v1/records?${query}`, "GET", undefined, bearer(source));
  expect(response.status).toBe(200);
  return listBody.parse(await response.json());
};

test("an agent reads any unarchived report, memo or link by id, without the owner's personal notes", async () => {
  // Given: another agent's report, the owner's memo with a personal note, and the owner's link.
  const report = await agentCreate("omo", { title: "OmO 조사" });
  const memo = await ownerCreate({ kind: "note", title: "주인 메모", body: "메모 본문", fields: { summary: "요약", personalNotes: "비밀" } });
  const link = await ownerCreate({ kind: "social", title: "주인 링크", links: [{ label: "원문", url: "https://example.com/a" }] });
  // When/Then: codex reads each one in full through the private listener; the personal note never leaves.
  for (const record of [report, memo, link]) {
    const response = await read(record.id, "codex");
    expect(response.status).toBe(200);
    const got = recordResult.parse(await response.json()).record;
    expect(got).toMatchObject({ id: record.id, title: record.title, body: record.body });
  }
  const gotMemo = recordResult.parse(await (await read(memo.id, "codex")).json()).record;
  expect(gotMemo.fields).toEqual({ summary: "요약" });
});

test("another agent's tasks, archived owner tasks and archived records stay hidden, while an agent's own archived record stays readable", async () => {
  // Given: the owner's live task and project, an archived owner task, an OmO task, archived owner/OmO/codex reports.
  const task = await ownerCreate({ kind: "task", title: "주인 업무", status: "todo" });
  const project = await ownerCreate({ kind: "project", title: "주인 프로젝트", status: "idea" });
  const archivedTask = await ownerCreate({ kind: "task", title: "보관한 주인 업무", status: "todo" });
  await ownerPatch(archivedTask.id, 1, { archived: true });
  const omoTask = await agentCreate("omo", { kind: "task", title: "OmO 업무" });
  const ownerReport = await ownerCreate({ kind: "research", title: "보관한 조사" });
  await ownerPatch(ownerReport.id, 1, { archived: true });
  const omoReport = await agentCreate("omo", { title: "보관한 OmO 조사" });
  await ownerPatch(omoReport.id, 1, { archived: true });
  const own = await agentCreate("codex", { title: "보관한 내 조사" });
  const ownArchived = await ownerPatch(own.id, 1, { archived: true, fields: { ...own.fields, personalNotes: "주인 메모" } });
  // Then: codex, a work partner, reads the owner's live task and project; it gets 404 for the rest and its own archived record in full.
  for (const record of [task, project]) expect((await read(record.id, "codex")).status).toBe(200);
  for (const record of [archivedTask, omoTask, ownerReport, omoReport]) expect((await read(record.id, "codex")).status).toBe(404);
  const mine = recordResult.parse(await (await read(own.id, "codex")).json()).record;
  expect(mine.fields).toEqual(ownArchived.fields);
});

test("the public agent listener still reads only the agent's own records", async () => {
  const report = await agentCreate("omo", { title: "OmO 조사" });
  const own = await agentCreate("codex", { title: "내 조사" });
  expect((await read(report.id, "codex", true)).status).toBe(404);
  expect((await read(own.id, "codex", true)).status).toBe(200);
});

test("an agent searches readable records by words and kind, page by page", async () => {
  // Given: readable and hidden records that all mention Alpha, plus one Beta report.
  const report = await agentCreate("omo", { title: "Alpha 조사" });
  const memo = await ownerCreate({ kind: "note", title: "Alpha 메모", fields: { personalNotes: "secret" } });
  const ownTask = await agentCreate("codex", { kind: "task", title: "Alpha 내 업무" });
  const ownerTask = await ownerCreate({ kind: "task", title: "Alpha 주인 업무", status: "todo" });
  await agentCreate("omo", { kind: "task", title: "Alpha OmO 업무" });
  const archived = await ownerCreate({ kind: "research", title: "Alpha 보관" });
  await ownerPatch(archived.id, 1, { archived: true });
  await agentCreate("omo", { title: "Beta 조사" });
  // When: codex searches for alpha.
  const found = await search("q=alpha");
  // Then: only what codex may read comes back, without personal notes.
  expect(found.items.map(item => item.id).sort()).toEqual([report.id, memo.id, ownTask.id, ownerTask.id].sort());
  expect(JSON.stringify(found.items)).not.toContain("secret");
  expect((await search("q=alpha&kind=note")).items.map(item => item.id)).toEqual([memo.id]);
  // And: pages of one item walk the same results without duplicates.
  const first = await search("q=alpha&limit=1");
  expect(first.items).toHaveLength(1);
  const second = await search(`q=alpha&limit=1&cursor=${encodeURIComponent(first.nextCursor ?? "")}`);
  expect(second.items).toHaveLength(1);
  expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
});

test("an agent reading someone else's record still cannot edit it", async () => {
  // Given: an OmO report and an owner task codex can read, and an OmO task codex cannot.
  const report = await agentCreate("omo", { title: "OmO 조사" });
  const task = await ownerCreate({ kind: "task", title: "주인 업무", status: "todo" });
  const omoTask = await agentCreate("omo", { kind: "task", title: "OmO 업무" });
  // When: codex tries to edit all three.
  const readable = await f.call(`/api/v1/records/${report.id}`, "PATCH", { expectedVersion: 1, changes: { title: "남의 기록" } }, bearer("codex"));
  const ownerItem = await f.call(`/api/v1/records/${task.id}`, "PATCH", { expectedVersion: 1, changes: { status: "done" } }, bearer("codex"));
  const hidden = await f.call(`/api/v1/records/${omoTask.id}`, "PATCH", { expectedVersion: 1, changes: { title: "남의 업무" } }, bearer("codex"));
  // Then: the readable ones are refused as forbidden with the way forward, the hidden one stays not found, and none changed.
  expect(readable.status).toBe(403);
  const refusal = errorBody.parse(await readable.json()).error;
  expect(refusal.code).toBe("forbidden");
  expect(refusal.message).toContain("previousId");
  expect(ownerItem.status).toBe(403);
  expect(hidden.status).toBe(404);
  expect(recordResult.parse(await (await read(report.id, "omo")).json()).record).toMatchObject({ version: 1, title: "OmO 조사" });
  expect(recordResult.parse(await (await read(task.id, "codex")).json()).record).toMatchObject({ version: 1, status: "todo" });
});
