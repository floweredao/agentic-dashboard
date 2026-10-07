import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createAiFill } from "../server/ai-fill";
import { Store } from "../server/store";
import { bearer, fixture, payload, recordResult } from "./backend-helper";

let f = fixture();
afterEach(() => { f.close(); f = fixture(); });
afterAll(() => f.close());

async function create(session: HeadersInit, record: unknown, requestId = crypto.randomUUID()) {
  const response = await f.call("/api/v1/records", "POST", payload(record, requestId), session);
  expect(response.status).toBe(201);
  return recordResult.parse(await response.json()).record;
}
const get = async (id: string, session: HeadersInit) => f.call(`/api/v1/records/${id}`, "GET", undefined, session);
const remove = (id: string, body: unknown, headers: HeadersInit, publicOnly = false) =>
  f.call(`/api/v1/records/${id}`, "DELETE", body, headers, publicOnly);

test("owner deletes a record, which disappears from read and list", async () => {
  const session = await f.login();
  const record = await create(session, { kind: "note", title: "Delete me" });
  const response = await remove(record.id, { expectedVersion: 1 }, session);
  expect(response.status).toBe(204);
  expect(await response.text()).toBe("");
  expect((await get(record.id, session)).status).toBe(404);
  const list = z.object({ items: z.array(z.object({ id: z.string() })) }).parse(await (await f.call("/api/v1/records?archived=all", "GET", undefined, session)).json());
  expect(list.items.map(item => item.id)).not.toContain(record.id);
  expect((await remove(record.id, { expectedVersion: 1 }, session)).status).toBe(404);
});

test("stale version, missing CSRF, agents, anonymous callers and the public listener cannot delete", async () => {
  const session = await f.login();
  const record = await create(session, { kind: "note", title: "Keep me" });
  const stale = await remove(record.id, { expectedVersion: 2 }, session);
  expect(stale.status).toBe(409);
  expect(z.object({ error: z.object({ code: z.string() }) }).parse(await stale.json()).error.code).toBe("version_conflict");
  const { "X-CSRF-Token": _csrf, ...withoutCsrf } = session;
  expect((await remove(record.id, { expectedVersion: 1 }, withoutCsrf)).status).toBe(403);
  expect((await remove(record.id, { expectedVersion: 1 }, bearer("codex"))).status).toBe(403);
  expect((await remove(record.id, { expectedVersion: 1 }, bearer("owner"))).status).toBe(403);
  expect((await remove(record.id, { expectedVersion: 1 }, {})).status).toBe(401);
  expect((await remove(record.id, { expectedVersion: 1 }, bearer("omo"), true)).status).toBe(404);
  expect((await remove(record.id, { expectedVersion: 1, extra: true }, session)).status).toBe(400);
  expect((await get(record.id, session)).status).toBe(200);
});

test("an agent moves only the records it created to the trash, on the private listener, and the owner restores them", async () => {
  const session = await f.login();
  // Given: a note OmO saved and a note the owner saved.
  const own = await create(bearer("omo"), { kind: "note", title: "OmO note", body: "Body", tags: ["test"] });
  const owners = await create(session, { kind: "note", title: "Owner note" });
  // When: another agent or OmO on the public listener tries OmO's note, or OmO tries the owner's note, nothing moves.
  expect((await remove(own.id, { expectedVersion: 1 }, bearer("codex"))).status).toBe(403);
  expect((await remove(own.id, { expectedVersion: 1 }, bearer("omo"), true)).status).toBe(404);
  expect((await remove(owners.id, { expectedVersion: 1 }, bearer("omo"))).status).toBe(403);
  expect((await remove(own.id, { expectedVersion: 2 }, bearer("omo"))).status).toBe(409);
  // When: OmO moves its own note to the trash.
  expect((await remove(own.id, { expectedVersion: 1 }, bearer("omo"))).status).toBe(204);
  // Then: it is gone from reads and sits in the owner's trash, from where the owner restores it.
  expect((await get(own.id, session)).status).toBe(404);
  const trash = z.object({ items: z.array(z.object({ record: z.object({ id: z.string() }) })) })
    .parse(await (await f.call("/api/v1/trash", "GET", undefined, session)).json());
  expect(trash.items.map(item => item.record.id)).toEqual([own.id]);
  expect((await f.call(`/api/v1/trash/${own.id}/restore`, "POST", undefined, session)).status).toBe(200);
  expect((await get(own.id, session)).status).toBe(200);
  expect((await get(owners.id, session)).status).toBe(200);
});

test("deleting detaches project, task and evidence references and bumps their versions", async () => {
  const session = await f.login();
  const project = await create(session, { kind: "project", title: "Project" });
  const evidence = await create(session, { kind: "research", title: "Evidence", projectId: project.id });
  const task = await create(session, { kind: "task", title: "Task", projectId: project.id, fields: { evidenceIds: [evidence.id] } });
  const note = await create(session, { kind: "note", title: "Note", taskId: task.id });
  expect((await remove(evidence.id, { expectedVersion: 1 }, session)).status).toBe(204);
  const read = async (id: string) => recordResult.parse(await (await get(id, session)).json()).record;
  const detachedTask = await read(task.id);
  expect(detachedTask.fields.evidenceIds).toEqual([]);
  expect(detachedTask.version).toBe(2);
  expect((await f.call(`/api/v1/records/${task.id}`, "PATCH", { expectedVersion: 1, changes: { title: "Stale" } }, session)).status).toBe(409);
  expect((await remove(project.id, { expectedVersion: 1 }, session)).status).toBe(204);
  const orphanTask = await read(task.id);
  expect(orphanTask.projectId).toBeNull();
  expect(orphanTask.version).toBe(3);
  expect((await remove(task.id, { expectedVersion: 3 }, session)).status).toBe(204);
  const orphanNote = await read(note.id);
  expect(orphanNote.taskId).toBeNull();
  expect(orphanNote.version).toBe(2);
});

test("deleting a record removes previousId from the records that continue it", async () => {
  const session = await f.login();
  const earlier = await create(session, { kind: "research", title: "앞 기록" });
  const later = await create(session, { kind: "note", title: "뒤 기록", fields: { previousId: earlier.id, starred: true } });
  expect((await remove(earlier.id, { expectedVersion: 1 }, session)).status).toBe(204);
  const detached = recordResult.parse(await (await get(later.id, session)).json()).record;
  expect(detached.fields).toEqual({ starred: true });
  expect(detached.version).toBe(2);
});

test("the same requestId creates a new record after the original is deleted", async () => {
  const session = await f.login();
  const requestId = crypto.randomUUID();
  const original = await create(session, { kind: "note", title: "Again" }, requestId);
  expect((await remove(original.id, { expectedVersion: 1 }, session)).status).toBe(204);
  const again = await f.call("/api/v1/records", "POST", payload({ kind: "note", title: "Again" }, requestId), session);
  expect(again.status).toBe(201);
  expect(recordResult.parse(await again.json()).record.id).not.toBe(original.id);
});

test("an AI fill queued for a record deleted before it runs stops silently", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentic-delete-"));
  const store = new Store(join(dir, "db.sqlite"), () => Date.parse("2026-09-28T12:00:00Z"));
  const errors = spyOn(console, "error");
  try {
    store.db.query("INSERT INTO principals(id,source,token_hash) VALUES('owner','manual','x')").run();
    const input = { kind: "social" as const, title: "jack (@jack) on X", body: "", status: "new", projectId: null, taskId: null, dueDate: null,
      tags: [], links: [{ label: "원문", url: "https://x.com/jack/status/20" }], fields: { origin: "x" } };
    const make = () => store.create({ id: "owner", source: "manual" }, crypto.randomUUID(), input, input).record;
    const before = make();
    const during = make();
    let runs = 0;
    const fill = createAiFill({ store, read: async () => "page", run: async () => {
      runs++;
      store.delete(during.id, 1);
      return JSON.stringify({ title: "새 제목", summary: "" });
    } });
    store.delete(before.id, 1);
    fill.enqueue(before.id);
    fill.enqueue(during.id);
    await fill.idle();
    expect(runs).toBe(1);
    expect(errors).not.toHaveBeenCalled();
  } finally {
    errors.mockRestore();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
