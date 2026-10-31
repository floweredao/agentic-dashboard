import { expect, test } from "bun:test";
import { startOfZonedDay, zonedDate, zonedInstant } from "../shared/time";

test("a day that starts in a daylight-saving gap starts when its clocks do, not in the day before", () => {
  // Given: Chile and Cuba move their clocks from 00:00 to 01:00, so these days have no midnight.
  for (const [zone, date, start] of [
    ["America/Santiago", "2026-09-06", "2026-09-06T04:00:00.000Z"],
    ["America/Havana", "2026-03-08", "2026-03-08T05:00:00.000Z"],
  ] as const) {
    // When: the day's start is asked for from noon that day.
    const at = startOfZonedDay(zonedInstant(date, "12:00", zone), zone);
    // Then: it is the first instant of that day (01:00 local), and the instant before it is the day before.
    expect(new Date(at).toISOString()).toBe(start);
    expect(zonedDate(new Date(at), zone)).toBe(date);
    expect(zonedDate(new Date(at - 1), zone)).not.toBe(date);
  }
});

test("a local time is placed on its own day around daylight-saving changes", () => {
  // A time the clocks skip reads as far past the change; a time they repeat is its first occurrence.
  expect(new Date(zonedInstant("2026-03-08", "02:30", "America/New_York")).toISOString()).toBe("2026-03-08T07:30:00.000Z");
  expect(new Date(zonedInstant("2026-11-01", "01:30", "America/New_York")).toISOString()).toBe("2026-11-01T05:30:00.000Z");
  expect(new Date(zonedInstant("2026-03-29", "00:00", "Asia/Beirut")).toISOString()).toBe("2026-03-28T22:00:00.000Z");
  // Ordinary days keep the zone's offset on either side of Greenwich.
  expect(new Date(zonedInstant("2026-10-01", "08:00", "America/New_York")).toISOString()).toBe("2026-10-01T12:00:00.000Z");
  expect(new Date(zonedInstant("2026-10-01", "08:00", "Asia/Seoul")).toISOString()).toBe("2026-09-30T23:00:00.000Z");
  expect(new Date(startOfZonedDay(Date.parse("2026-10-01T03:00:00Z"), "America/Los_Angeles")).toISOString()).toBe("2026-09-30T07:00:00.000Z");
});
