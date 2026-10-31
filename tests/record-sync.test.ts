import { expect, test } from "bun:test";
import { z } from "zod";
import { RecordInputSchema } from "../shared/contracts";
import { RecordSyncSchema } from "../shared/record-sync";
import { hostedFixture } from "./helpers/hosted";

test("record changes use bounded pages and never include another account", async () => {
  // Given: enough A records to exceed one page, and an independent B record.
  const f = await hostedFixture();
  try {
    for (let index = 0; index < 51; index++) await f.a.scope.store.create({ id: "owner", source: "manual" }, `a-${index}`,
      RecordInputSchema.parse({ kind: "note", title: `A ${index}` }), {});
    await f.b.scope.store.create({ id: "owner", source: "manual" }, "b", RecordInputSchema.parse({ kind: "note", title: "B private" }), {});
    // When: A requests its first change page.
    const page = RecordSyncSchema.parse(await (await f.call("/api/v1/records/changes?after=0")).json());
    // Then: the page is bounded and its continuation contains only A.
    expect(page.items).toHaveLength(50);
    expect(page.hasMore).toBe(true);
    const tail = RecordSyncSchema.parse(await (await f.call(`/api/v1/records/changes?after=${page.cursor}`)).json());
    expect(tail.items).toHaveLength(1);
    expect(tail.items.every(record => record.title.startsWith("A "))).toBe(true);
    expect(tail.hasMore).toBe(false);
  } finally { await f.close(); }
});

test("deleting a record is observable after a previously issued sync cursor", async () => {
  // Given: an existing record and a saved high-water mark.
  const f = await hostedFixture();
  try {
    const created = await f.call("/api/v1/records", { method: "POST", body: { requestId: "one", record: { kind: "note", title: "One" } } });
    const record = z.object({ record: z.object({ id: z.string(), version: z.number() }) }).parse(await created.json()).record;
    const head = RecordSyncSchema.parse(await (await f.call("/api/v1/records/changes")).json());
    // When: the record is moved to trash.
    await f.call(`/api/v1/records/${record.id}`, { method: "DELETE", body: { expectedVersion: record.version } });
    // Then: an incremental refresh removes it without reloading the archive.
    const changes = RecordSyncSchema.parse(await (await f.call(`/api/v1/records/changes?after=${head.cursor}`)).json());
    expect(changes.deletedIds).toEqual([record.id]);
    expect(changes.items).toEqual([]);
  } finally { await f.close(); }
});
