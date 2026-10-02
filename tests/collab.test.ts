import { afterAll, afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { CommentSchema, QueuedCommentSchema } from "../shared/contracts";
import { agentRecord, bearer, fixture, payload, recordResult } from "./backend-helper";

let f = fixture();
afterEach(() => { f.close(); f = fixture(); });
afterAll(() => f.close());

type Agent = "omo" | "codex" | "chatgpt";
const created = z.object({ comment: CommentSchema, record: recordResult.shape.record.nullable(), replayed: z.boolean() });
const timeline = z.object({ items: z.array(CommentSchema) });
const queue = z.object({ items: z.array(QueuedCommentSchema) });
const errorCode = async (response: Response) => z.object({ error: z.object({ code: z.string() }) }).parse(await response.json()).error.code;

async function agentTask(source: Agent, title = "작업 항목") {
  const response = await f.call("/api/v1/records", "POST", payload(agentRecord({ kind: "task", title, status: "active", body: "설명" })), bearer(source));
  expect(response.status).toBe(201);
  return recordResult.parse(await response.json()).record;
}
async function ownerTask(title = "오너 할 일", extra: Record<string, unknown> = {}) {
  const response = await f.call("/api/v1/records", "POST", payload({ kind: "task", title, status: "todo", ...extra }), await f.login());
  expect(response.status).toBe(201);
  return recordResult.parse(await response.json()).record;
}
const post = async (who: Agent | "owner", body: Record<string, unknown>) =>
  f.call("/api/v1/comments", "POST", { requestId: crypto.randomUUID(), ...body }, who === "owner" ? await f.login() : bearer(who));
async function comment(who: Agent | "owner", body: Record<string, unknown>) {
  const response = await post(who, body);
  expect(response.status).toBe(201);
  return created.parse(await response.json());
}
async function listed(who: Agent | "owner", query = "") {
  const response = await f.call(`/api/v1/comments${query}`, "GET", undefined, who === "owner" ? await f.login() : bearer(who));
  expect(response.status).toBe(200);
  return await response.json();
}
const mark = async (who: Agent | "owner", id: string, what: "seen" | "done") =>
  f.call(`/api/v1/comments/${id}/${what}`, "POST", undefined, who === "owner" ? await f.login() : bearer(who));

test("OmO reports on its task, the owner comments, and OmO finds, marks and answers the comment", async () => {
  // Given: an OmO task with a report that asks the owner to check it.
  const task = await agentTask("omo");
  const report = await comment("omo", { recordId: task.id, body: "1차 작업 끝, 확인 부탁", status: "review" });
  expect(report.record).toMatchObject({ id: task.id, status: "review", version: 2 });
  // When: the owner comments, OmO lists new comments, marks it seen, then replies and marks it done in one call.
  const ownerComment = (await comment("owner", { recordId: task.id, body: "버튼 색 바꿔줘" })).comment;
  const fresh = queue.parse(await listed("omo", "?state=new")).items;
  expect(fresh.map(item => [item.id, item.recordTitle, item.body])).toEqual([[ownerComment.id, "작업 항목", "버튼 색 바꿔줘"]]);
  const seen = await mark("omo", ownerComment.id, "seen");
  expect(seen.status).toBe(200);
  expect(queue.parse(await listed("omo", "?state=new")).items).toEqual([]);
  expect(queue.parse(await listed("omo", "?state=open")).items.map(item => item.id)).toEqual([ownerComment.id]);
  const reply = await comment("omo", { replyTo: ownerComment.id, body: "바꿨어요", done: true, status: "review" });
  expect(reply.comment).toMatchObject({ recordId: task.id, replyTo: ownerComment.id, source: "omo" });
  // Then: nothing is open for OmO, and the owner's timeline shows the report, the comment marked seen and done by OmO, and the reply.
  expect(queue.parse(await listed("omo")).items).toEqual([]);
  const items = timeline.parse(await listed("owner", `?recordId=${task.id}`)).items;
  expect(items.map(item => [item.source, item.body, item.replyTo, item.status])).toEqual([
    ["omo", "1차 작업 끝, 확인 부탁", null, "review"], ["manual", "버튼 색 바꿔줘", null, null], ["omo", "바꿨어요", ownerComment.id, "review"],
  ]);
  expect(items[1]).toMatchObject({ seenBy: "omo", doneBy: "omo" });
  expect(items[1]?.seenAt).not.toBeNull();
  expect(items[1]?.doneAt).not.toBeNull();
  // And: the owner's full list carries the same entries; a status-only entry needs no body.
  expect(timeline.parse(await listed("owner")).items).toHaveLength(3);
  expect((await comment("omo", { recordId: task.id, status: "done" })).record).toMatchObject({ status: "done" });
});

test("OmO reads and comments on the owner's item but changes nothing on it, and answers the owner's comments there", async () => {
  // Given: the owner's task with a comment.
  const task = await ownerTask();
  const ownerComment = (await comment("owner", { recordId: task.id, body: "이거 맡아줘" })).comment;
  // When/Then: OmO reads it and sees the comment in its queue, reports and replies, but cannot change status or edit it.
  expect((await f.call(`/api/v1/records/${task.id}`, "GET", undefined, bearer("omo"))).status).toBe(200);
  expect(queue.parse(await listed("omo")).items.map(item => item.id)).toEqual([ownerComment.id]);
  await comment("omo", { recordId: task.id, body: "시작했어요" });
  await comment("omo", { replyTo: ownerComment.id, body: "맡을게요", done: true });
  const statusChange = await post("omo", { recordId: task.id, body: "끝", status: "done" });
  expect(statusChange.status).toBe(403);
  expect((await f.call(`/api/v1/records/${task.id}`, "PATCH", { expectedVersion: 1, changes: { status: "done" } }, bearer("omo"))).status).toBe(403);
  expect(recordResult.parse(await (await f.call(`/api/v1/records/${task.id}`, "GET", undefined, bearer("omo"))).json()).record)
    .toMatchObject({ status: "todo", version: 1 });
});

test("comment boundaries: other agents' items, agent entries, archived items, ChatGPT, the public listener and CSRF", async () => {
  // Given: an OmO task with an owner comment and an OmO report, a codex task with an owner comment, and an archived owner task with a comment.
  const omoTask = await agentTask("omo", "OmO 작업");
  const ownerOnOmo = (await comment("owner", { recordId: omoTask.id, body: "OmO에게" })).comment;
  const omoReport = (await comment("omo", { recordId: omoTask.id, body: "보고" })).comment;
  const codexTask = await agentTask("codex", "Codex 작업");
  const ownerOnCodex = (await comment("owner", { recordId: codexTask.id, body: "Codex에게" })).comment;
  const archived = await ownerTask("보관할 할 일");
  const ownerOnArchived = (await comment("owner", { recordId: archived.id, body: "보관 전 코멘트" })).comment;
  const login = await f.login();
  expect((await f.call(`/api/v1/records/${archived.id}`, "PATCH", { expectedVersion: 1, changes: { archived: true } }, login)).status).toBe(200);
  // Then: each agent's queue holds only the owner's comments on its own and the owner's live items.
  expect(queue.parse(await listed("omo")).items.map(item => item.id)).toEqual([ownerOnOmo.id]);
  expect(queue.parse(await listed("codex")).items.map(item => item.id)).toEqual([ownerOnCodex.id]);
  // And: codex cannot see, report on, reply to or mark OmO's item; nor can it mark the archived item's comment.
  expect((await f.call(`/api/v1/comments?recordId=${omoTask.id}`, "GET", undefined, bearer("codex"))).status).toBe(404);
  expect((await post("codex", { recordId: omoTask.id, body: "끼어들기" })).status).toBe(404);
  expect((await post("codex", { replyTo: ownerOnOmo.id, body: "끼어들기" })).status).toBe(404);
  expect((await mark("codex", ownerOnOmo.id, "done")).status).toBe(404);
  expect((await mark("omo", ownerOnArchived.id, "seen")).status).toBe(404);
  // And: once OmO's own item is archived, the owner's comment on it leaves OmO's queue and can no longer be marked.
  const shelved = await agentTask("omo", "보관될 OmO 작업");
  const ownerOnShelved = (await comment("owner", { recordId: shelved.id, body: "보관 전 지시" })).comment;
  expect((await f.call(`/api/v1/records/${shelved.id}`, "PATCH", { expectedVersion: 1, changes: { archived: true } }, login)).status).toBe(200);
  expect((await mark("omo", ownerOnShelved.id, "done")).status).toBe(403);
  // And: OmO cannot mark agent entries or claim done on its own report; the owner cannot mark at all.
  const agentMark = await mark("omo", omoReport.id, "done");
  expect(agentMark.status).toBe(403);
  expect(await errorCode(agentMark)).toBe("forbidden");
  expect((await post("omo", { replyTo: omoReport.id, body: "덧붙임", done: true })).status).toBe(403);
  expect((await mark("owner", ownerOnOmo.id, "seen")).status).toBe(403);
  // And: every agent reads the owner's tasks, comments only go on tasks and projects, and statuses are checked.
  const ownerItem = await ownerTask("오너 것");
  expect((await f.call(`/api/v1/records/${ownerItem.id}`, "GET", undefined, bearer("chatgpt"))).status).toBe(200);
  const note = await f.call("/api/v1/records", "POST", payload(agentRecord({ kind: "note", title: "메모" })), bearer("omo"));
  expect((await post("omo", { recordId: recordResult.parse(await note.json()).record.id, body: "메모에 코멘트" })).status).toBe(400);
  expect((await post("omo", { recordId: omoTask.id, status: "finished" })).status).toBe(400);
  expect((await post("omo", { recordId: omoTask.id })).status).toBe(400);
  // And: the public agent listener has no comment routes, and the owner's browser session needs the CSRF token.
  expect((await f.call("/api/v1/comments", "GET", undefined, bearer("omo"), true)).status).toBe(404);
  const { "X-CSRF-Token": _csrf, ...noCsrf } = await f.login();
  expect((await f.call("/api/v1/comments", "POST", { requestId: "x", recordId: omoTask.id, body: "csrf 없음" }, noCsrf)).status).toBe(403);
  // And: nothing above changed the queues.
  expect(queue.parse(await listed("omo")).items.map(item => [item.id, item.seenAt])).toEqual([[ownerOnOmo.id, null]]);
});

test("a resent comment returns the first one, a reused request id with other content is a conflict, and a trashed item keeps its timeline", async () => {
  // Given: an OmO report sent twice with the same request id.
  const task = await agentTask("omo");
  const body = { requestId: "report-1", recordId: task.id, body: "보고" };
  const first = await f.call("/api/v1/comments", "POST", body, bearer("omo"));
  const again = await f.call("/api/v1/comments", "POST", body, bearer("omo"));
  // Then: the retry is a replay of the same entry, and other content under that id is refused.
  expect(first.status).toBe(201);
  expect(again.status).toBe(200);
  const [one, two] = [created.parse(await first.json()), created.parse(await again.json())];
  expect(two).toMatchObject({ replayed: true, comment: { id: one.comment.id } });
  const conflict = await f.call("/api/v1/comments", "POST", { ...body, body: "다른 보고" }, bearer("omo"));
  expect(conflict.status).toBe(409);
  // When: the owner deletes the task and restores it.
  const login = await f.login();
  expect((await f.call(`/api/v1/records/${task.id}`, "DELETE", { expectedVersion: 1 }, login)).status).toBe(204);
  expect(timeline.parse(await listed("owner")).items).toEqual([]);
  expect((await f.call(`/api/v1/trash/${task.id}/restore`, "POST", undefined, login)).status).toBe(200);
  // Then: the timeline is back; purging the item for good removes it.
  expect(timeline.parse(await listed("owner", `?recordId=${task.id}`)).items.map(item => item.id)).toEqual([one.comment.id]);
  expect((await f.call(`/api/v1/records/${task.id}`, "DELETE", { expectedVersion: 2 }, login)).status).toBe(204);
  expect((await f.call(`/api/v1/trash/${task.id}`, "DELETE", undefined, login)).status).toBe(204);
  const rows = await f.call("/api/v1/comments", "GET", undefined, login);
  expect(timeline.parse(await rows.json()).items).toEqual([]);
});

test("an existing database gains the comments table without losing records", async () => {
  // Given: a record saved before the restart.
  const task = await ownerTask("재시작 전");
  // When: the server restarts on the same database file.
  f.restart();
  // Then: the record is intact and comments work.
  const got = await f.call(`/api/v1/records/${task.id}`, "GET", undefined, await f.login());
  expect(recordResult.parse(await got.json()).record).toMatchObject({ id: task.id, title: "재시작 전", version: 1 });
  expect((await comment("owner", { recordId: task.id, body: "재시작 후" })).comment.recordId).toBe(task.id);
});
