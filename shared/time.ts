export const systemTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export function validTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

const dayFormats = new Map<string, Intl.DateTimeFormat>();
export function zonedDate(date: Date, zone: string): string {
  let format = dayFormats.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
    dayFormats.set(zone, format);
  }
  return format.format(date);
}

/** Milliseconds `zone` is ahead of UTC at instant `at` (negative west of Greenwich). */
export function zoneOffsetMs(at: number, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(at));
  const value = (type: string) => Number(parts.find(part => part.type === type)?.value ?? 0);
  const local = Date.UTC(value("year"), value("month") - 1, value("day"), value("hour"), value("minute"), value("second"));
  return local - Math.floor(at / 1000) * 1000;
}

/** The UTC instant at which local `time` (HH:MM) on `date` (YYYY-MM-DD) happens in `zone`. */
export function zonedInstant(date: string, time: string, zone: string): number {
  const guess = Date.parse(`${date}T${time}:00Z`);
  // Two passes settle the offset even when the guess falls on the other side of a DST change.
  const first = guess - zoneOffsetMs(guess, zone);
  return guess - zoneOffsetMs(first, zone);
}

export const startOfZonedDay = (at: number, zone: string): number => zonedInstant(zonedDate(new Date(at), zone), "00:00", zone);
