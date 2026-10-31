import { afterAll, beforeAll, expect, test } from "bun:test";
import { config, configure } from "../config";
import { applyLocale } from "../i18n";
import { purgeLabel } from "./Trash";

// The dashboard is in Seoul while the machine runs in UTC; every instant below is pinned.
const machineZone = process.env["TZ"];
const dashboardZone = config.timeZone;
beforeAll(() => { process.env["TZ"] = "UTC"; configure({ timeZone: "Asia/Seoul" }); });
afterAll(() => {
  if (machineZone === undefined) delete process.env["TZ"]; else process.env["TZ"] = machineZone;
  configure({ timeZone: dashboardZone });
  applyLocale("ko");
});

test("the trash countdown counts calendar days in the dashboard's zone, so the purge day reads today from its midnight", () => {
  applyLocale("ko");
  // Purged at 09:00 on October 30 in Seoul: at 00:30 that day it is today, at 23:30 the day before it is one day away.
  expect(purgeLabel("2026-10-30T00:00:00Z", Date.parse("2026-10-29T15:30:00Z"))).toBe("오늘 영구 삭제");
  expect(purgeLabel("2026-10-30T00:00:00Z", Date.parse("2026-10-29T14:30:00Z"))).toBe("1일 뒤 영구 삭제");
  // Across the year end: 01:00 on December 31 to 23:00 on January 1 is one calendar day, not two.
  expect(purgeLabel("2027-01-01T14:00:00Z", Date.parse("2026-12-30T16:00:00Z"))).toBe("1일 뒤 영구 삭제");
  // A leap day: from 05:00 on February 28 to noon on February 29 is one day; from that midnight it is today.
  expect(purgeLabel("2028-02-29T03:00:00Z", Date.parse("2028-02-27T20:00:00Z"))).toBe("1일 뒤 영구 삭제");
  expect(purgeLabel("2028-02-29T03:00:00Z", Date.parse("2028-02-28T15:00:00Z"))).toBe("오늘 영구 삭제");
  applyLocale("en");
  expect(purgeLabel("2026-10-30T00:00:00Z", Date.parse("2026-10-29T15:30:00Z"))).toBe("Deleted permanently today");
});
