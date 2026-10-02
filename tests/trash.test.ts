import { afterAll, afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { bearer, fixture, payload, recordResult } from "./backend-helper";

const DAY = 24 * 60 * 60 * 1000;
const start = Date.parse("2026-09-01T00:00:00.000Z");
let clock = start;
let f = fixture(10000, () => clock);
afterEach(() => { f.close(); clock = start; f = fixture(10000, () => clock); });
afterAll(() => f.close());

const trashList = z.object({ items: z.array(z.object({
  record: z.object({ id: z.string(), title: z.string(), version: z.number() }).passthrough(),
  deletedAt: z.string(), purgeAt: z.string(),
}).strict()) }).strict();
const idList = z.object({ items: z.array(z.object({ id: z.string() })) });

async function create(session: HeadersInit, record: unknown) {
  const response = await f.call("/api/v1/records", "POST", payload(record), session);
  expect(response.status).toBe(201);
  return recordResult.parse(await response.json()).record;
}
async function remove(id: string, version: number, session: HeadersInit) {
  expect((await f.call(`/api/v1/records/${id}`, "DELETE", { expectedVersion: version }, session)).status).toBe(204);
}
async function trash(session: HeadersInit) {
  const response = await f.call("/api/v1/trash", "GET", undefined, session);
  expect(response.status).toBe(200);
  return trashList.parse(await response.json()).items;
}
const restore = (id: string, headers: HeadersInit) => f.call(`/api/v1/trash/${id}/restore`, "POST", undefined, headers);
const listed = async (session: HeadersInit) =>
  idList.parse(await (await f.call("/api/v1/records?archived=all", "GET", undefined, session)).json()).items.map(item => item.id);

test("a deleted record moves into the trash with a purge date 30 days later", async () => {
  const session = await f.login();
  const record = await create(session, { kind: "note", title: "버릴 메모" });
  await remove(record.id, 1, session);
  expect((await f.call(`/api/v1/records/${record.id}`, "GET", undefined, session)).status).toBe(404);
  expect(await listed(session)).not.toContain(record.id);
  const items = await trash(session);
  expect(items).toHaveLength(1);
  expect(items[0]?.record.id).toBe(record.id);
  expect(items[0]?.record.title).toBe("버릴 메모");
  expect(items[0]?.deletedAt).toBe(new Date(start).toISOString());
  expect(items[0]?.purgeAt).toBe(new Date(start + 30 * DAY).toISOString());
});

test("the trash lists newest deletions first", async () => {
  const session = await f.login();
  const first = await create(session, { kind: "note", title: "먼저" });
  const second = await create(session, { kind: "note", title: "나중" });
  await remove(first.id, 1, session);
  clock += 1000;
  await remove(second.id, 1, session);
  expect((await trash(session)).map(item => item.record.id)).toEqual([second.id, first.id]);
});

test("restoring puts the record back with a new version and empties its trash entry", async () => {
  const session = await f.login();
  const record = await create(session, { kind: "note", title: "되살릴 메모" });
  await remove(record.id, 1, session);
  clock += DAY;
  const response = await restore(record.id, session);
  expect(response.status).toBe(200);
  const restored = recordResult.parse(await response.json()).record;
  expect(restored.id).toBe(record.id);
  expect(restored.version).toBe(2);
  const read = recordResult.parse(await (await f.call(`/api/v1/records/${record.id}`, "GET", undefined, session)).json()).record;
  expect(read.version).toBe(2);
  expect(read.title).toBe("되살릴 메모");
  expect(await trash(session)).toEqual([]);
  expect(await listed(session)).toContain(record.id);
  expect((await restore(record.id, session)).status).toBe(404);
});

test("restoring drops a project and previousId that were deleted meanwhile", async () => {
  const session = await f.login();
  const project = await create(session, { kind: "project", title: "프로젝트" });
  const earlier = await create(session, { kind: "research", title: "앞 기록" });
  const note = await create(session, { kind: "note", title: "뒤 기록", projectId: project.id, fields: { previousId: earlier.id, starred: true } });
  await remove(note.id, 1, session);
  await remove(project.id, 1, session);
  await remove(earlier.id, 1, session);
  const response = await restore(note.id, session);
  expect(response.status).toBe(200);
  const restored = recordResult.parse(await response.json()).record;
  expect(restored.projectId).toBeNull();
  expect(restored.fields).toEqual({ starred: true });
});

test("restoring keeps relations whose targets still exist", async () => {
  const session = await f.login();
  const project = await create(session, { kind: "project", title: "프로젝트" });
  const earlier = await create(session, { kind: "research", title: "앞 기록" });
  const note = await create(session, { kind: "note", title: "뒤 기록", projectId: project.id, fields: { previousId: earlier.id } });
  await remove(note.id, 1, session);
  const restored = recordResult.parse(await (await restore(note.id, session)).json()).record;
  expect(restored.projectId).toBe(project.id);
  expect(restored.fields).toEqual({ previousId: earlier.id });
});

test("permanent delete removes one item and emptying removes all", async () => {
  const session = await f.login();
  const one = await create(session, { kind: "note", title: "하나" });
  const two = await create(session, { kind: "note", title: "둘" });
  const three = await create(session, { kind: "note", title: "셋" });
  for (const record of [one, two, three]) await remove(record.id, 1, session);
  const destroyed = await f.call(`/api/v1/trash/${one.id}`, "DELETE", undefined, session);
  expect(destroyed.status).toBe(204);
  expect(await destroyed.text()).toBe("");
  expect((await restore(one.id, session)).status).toBe(404);
  expect((await f.call(`/api/v1/trash/${one.id}`, "DELETE", undefined, session)).status).toBe(404);
  expect((await trash(session)).map(item => item.record.id).sort()).toEqual([two.id, three.id].sort());
  expect((await f.call("/api/v1/trash", "DELETE", undefined, session)).status).toBe(204);
  expect(await trash(session)).toEqual([]);
  expect((await restore(two.id, session)).status).toBe(404);
});

test("only the owner session on the private listener can use the trash", async () => {
  const session = await f.login();
  const record = await create(session, { kind: "note", title: "권한" });
  await remove(record.id, 1, session);
  const { "X-CSRF-Token": _csrf, ...withoutCsrf } = session;
  expect((await f.call("/api/v1/trash", "GET", undefined, bearer("codex"))).status).toBe(403);
  expect((await f.call("/api/v1/trash", "GET", undefined, {})).status).toBe(401);
  expect((await restore(record.id, withoutCsrf)).status).toBe(403);
  expect((await restore(record.id, bearer("omo"))).status).toBe(403);
  expect((await f.call(`/api/v1/trash/${record.id}`, "DELETE", undefined, withoutCsrf)).status).toBe(403);
  expect((await f.call("/api/v1/trash", "DELETE", undefined, withoutCsrf)).status).toBe(403);
  expect((await f.call("/api/v1/trash", "GET", undefined, bearer("omo"), true)).status).toBe(404);
  expect((await f.call(`/api/v1/trash/${record.id}/restore`, "POST", undefined, bearer("omo"), true)).status).toBe(404);
  expect((await trash(session)).map(item => item.record.id)).toEqual([record.id]);
});

test("items older than 30 days are purged while newer ones remain", async () => {
  let session = await f.login();
  const old = await create(session, { kind: "note", title: "오래된 것" });
  const recent = await create(session, { kind: "note", title: "최근 것" });
  await remove(old.id, 1, session);
  clock = start + DAY;
  await remove(recent.id, 1, session);
  clock = start + 30 * DAY - 1;
  expect(f.app.purgeTrash()).toBe(0);
  clock = start + 30 * DAY;
  expect(f.app.purgeTrash()).toBe(1);
  session = await f.login();
  expect((await trash(session)).map(item => item.record.id)).toEqual([recent.id]);
  expect((await restore(old.id, session)).status).toBe(404);
  clock = start + 31 * DAY;
  f.restart();
  session = await f.login();
  expect(f.app.purgeTrash()).toBe(0);
  expect(await trash(session)).toEqual([]);
});
