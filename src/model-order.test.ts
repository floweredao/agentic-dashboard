import { afterAll, beforeAll, expect, test } from "bun:test";
import { DashboardRecordSchema } from "../shared/contracts";
import { config, configure } from "./config";
import { inboxItems, libraryView, listedFor } from "./model";

// The dashboard is in Seoul while the machine runs in UTC; `today` is passed in, never read from the clock.
const machineZone = process.env["TZ"];
const dashboardZone = config.timeZone;
beforeAll(() => { process.env["TZ"] = "UTC"; configure({ timeZone: "Asia/Seoul" }); });
afterAll(() => {
  if (machineZone === undefined) delete process.env["TZ"]; else process.env["TZ"] = machineZone;
  configure({ timeZone: dashboardZone });
});

// Two records saved in the same millisecond, one before midnight in Seoul. The server lists them by createdAt, then id, descending.
const at = "2026-10-23T14:59:59.999Z";
const make = (id: string) => DashboardRecordSchema.parse({
  id, kind: "research", title: id.slice(-1), source: "omo", createdBy: "omo", reviewState: "pending", archivedAt: null,
  createdAt: at, updatedAt: at, version: 1, fields: {},
});
const low = make("00000000-0000-4000-8000-000000000001");
const high = make("00000000-0000-4000-8000-000000000002");
const today = "2026-10-24";

test("records saved in the same millisecond list in the server's order whatever order the app holds them in", () => {
  // A record the app has just saved goes to the front of its array; the lists must not keep that order for a tie.
  expect(libraryView([low, high], "all", today).map(record => record.id)).toEqual([high.id, low.id]);
  expect(inboxItems([low, high], today).map(record => record.id)).toEqual([high.id, low.id]);
});

test("under To review the open record keeps its row after it is confirmed, even beside a record saved in the same millisecond", () => {
  const confirmed = { ...high, reviewState: "approved" as const };
  const route = { view: "library" as const, id: high.id, params: { state: "pending" } };
  expect(listedFor(route, [high, low], today).map(record => record.id)).toEqual([high.id, low.id]);
  expect(listedFor(route, [confirmed, low], today).map(record => record.id)).toEqual([high.id, low.id]);
});
