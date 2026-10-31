import { afterAll, afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { CommentSchema, DigestHitSchema } from "../shared/contracts";
import { agentRecord, bearer, fixture, payload, recordResult } from "./backend-helper";

// Lists a client can grow without end answer a bounded number of rows, newest kept.

const start = Date.parse("2026-10-01T00:00:00.000Z");
let clock = start;
// Every call is a second after the one before, so newest first is one order.
const tick = () => clock += 1000;
let f = await fixture(10000, tick);
afterEach(async () => { await f.close(); clock = start; f = await fixture(10000, tick); });
afterAll(async () => await f.close());

test("one item's timeline answers its newest 2000 entries, oldest first, however many an agent posts", async () => {
  // Given: an owner task on which an agent posts 2001 reports.
  const owner = await f.login();
  const task = recordResult.parse(await (await f.call("/api/v1/records", "POST", payload({ kind: "task", title: "긴 타임라인" }), owner)).json()).record;
  for (let index = 0; index < 2001; index++) {
    const response = await f.call("/api/v1/comments", "POST", { requestId: `report-${index}`, recordId: task.id, body: `보고 ${index}` }, bearer("omo"));
    expect(response.status).toBe(201);
  }
  // When: the owner and the agent read that one timeline.
  for (const headers of [owner, bearer("omo")]) {
    const response = await f.call(`/api/v1/comments?recordId=${task.id}`, "GET", undefined, headers);
    expect(response.status).toBe(200);
    const items = z.object({ items: z.array(CommentSchema) }).parse(await response.json()).items;
    // Then: the oldest entry is left out, the newest is there, and the order stays oldest first.
    expect(items).toHaveLength(2000);
    expect(items[0]?.body).toBe("보고 1");
    expect(items.at(-1)?.body).toBe("보고 2000");
  }
});

test("the trash answers the 200 most recently deleted records, however many an agent moves there", async () => {
  // Given: an agent saves 201 records and moves each to the trash.
  const ids: string[] = [];
  for (let index = 0; index < 201; index++) {
    const created = await f.call("/api/v1/records", "POST", payload(agentRecord({ title: `버릴 기록 ${index}` })), bearer("omo"));
    expect(created.status).toBe(201);
    const record = recordResult.parse(await created.json()).record;
    expect((await f.call(`/api/v1/records/${record.id}`, "DELETE", { expectedVersion: record.version }, bearer("omo"))).status).toBe(204);
    ids.push(record.id);
  }
  // When: the owner opens the trash.
  const response = await f.call("/api/v1/trash", "GET", undefined, await f.login());
  expect(response.status).toBe(200);
  const items = z.object({ items: z.array(z.object({ record: z.object({ id: z.string() }).passthrough() }).passthrough()) }).parse(await response.json()).items;
  // Then: 200 records, the last one deleted first; the first one deleted is left out of the list but stays restorable.
  expect(items).toHaveLength(200);
  expect(items[0]?.record.id).toBe(ids.at(-1));
  expect(items.map(item => item.record.id)).not.toContain(ids[0]);
  expect((await f.call(`/api/v1/trash/${ids[0]}/restore`, "POST", undefined, await f.login())).status).toBe(200);
});

test("digest search reads the newest 500 digests, however many an agent uploads", async () => {
  // Given: 501 digests on 501 days; only the oldest and the newest have an article about 반도체.
  const day = (index: number) => new Date(Date.parse("2025-01-01T00:00:00Z") + index * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  for (let index = 0; index < 501; index++) {
    const title = index === 0 || index === 500 ? `반도체 소식 ${index}` : `날씨 소식 ${index}`;
    const response = await f.call("/api/v1/digests", "POST", { date: day(index), slot: "morning", notify: false,
      sections: [{ key: "world", title: "World", kind: "articles", items: [{ key: `a${index}`, title, source: "Newswire", summary: "요약.", url: `https://news.example.com/${index}` }] }] }, bearer("omo"));
    expect(response.status).toBe(201);
  }
  // When: an agent searches for it.
  const response = await f.call(`/api/v1/digests/search?q=${encodeURIComponent("반도체")}`, "GET", undefined, bearer("omo"));
  expect(response.status).toBe(200);
  // Then: only the hit among the newest 500 digests is found; the oldest digest is past the scan.
  const items = z.object({ items: z.array(DigestHitSchema) }).parse(await response.json()).items;
  expect(items.map(hit => hit.date)).toEqual([day(500)]);
});
