import { expect, test } from "bun:test";
import { DashboardRecordSchema } from "../shared/contracts";
import { createRecordFeed } from "./record-feed";

test("an unchanged refresh reads only changes and preserves the full cached snapshot", async () => {
  // Given: a source with one full snapshot and a stable high-water mark.
  const row = DashboardRecordSchema.parse({ id: "00000000-0000-4000-8000-000000000001", kind: "note", title: "One",
    source: "manual", createdBy: "owner", reviewState: "approved", archivedAt: null,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", version: 1 });
  let snapshots = 0;
  const cursors: (number | undefined)[] = [];
  const feed = createRecordFeed({
    all: async () => { snapshots++; return [row]; },
    changes: async cursor => { cursors.push(cursor); return { cursor: 1, items: [], deletedIds: [], hasMore: false, reset: false }; },
  });
  await feed.load();
  // When: refreshing the unchanged account.
  const records = await feed.load();
  // Then: no second full snapshot is transferred.
  expect(records).toEqual([row]);
  expect(snapshots).toBe(1);
  expect(cursors).toEqual([undefined, 1, 1]);
});
