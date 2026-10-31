import type { DashboardRecord } from "../shared/contracts";
import type { RecordSync } from "../shared/record-sync";

let epoch = 0;
export function clearRecordCache() { epoch++; }
export function createRecordFeed(source: {
  readonly all: () => Promise<DashboardRecord[]>; readonly changes: (cursor?: number) => Promise<RecordSync>;
}) {
  let cached: { cursor: number; records: readonly DashboardRecord[]; epoch: number } | null = null;
  let serial: Promise<unknown> = Promise.resolve();
  async function refresh(): Promise<DashboardRecord[]> {
    const started = epoch;
    if (cached?.epoch !== started) cached = null;
    const snapshot = cached ?? { cursor: (await source.changes()).cursor, records: await source.all(), epoch: started };
    const draft = new Map(snapshot.records.map(record => [record.id, record]));
    let cursor = snapshot.cursor;
    let page: RecordSync;
    do {
      page = await source.changes(cursor);
      if (page.reset) { cached = null; return refresh(); }
      for (const id of page.deletedIds) draft.delete(id);
      for (const record of page.items) draft.set(record.id, record);
      cursor = page.cursor;
    } while (page.hasMore);
    // A sign-out or account switch invalidates an in-flight snapshot as well as the cached one.
    if (started !== epoch) return [];
    const records = [...draft.values()];
    cached = { cursor, records, epoch: started };
    return records;
  }
  return {
    load() {
      const result = serial.then(refresh);
      serial = result.catch(() => undefined);
      return result;
    },
  };
}
