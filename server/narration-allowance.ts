import { z } from "zod";
import { NARRATION_LIMITS } from "../shared/contracts";
import { startOfZonedDay, zonedDate, zonedInstant } from "../shared/time";
import type { Allowance } from "../shared/allowance";
import { RetryError } from "./errors";
import { ControlDb } from "./control-db";
import type { NarrationOptions } from "./narration-types";
import type { createNarrationSettings } from "./narration-settings";

export function narrationAllowance(options: NarrationOptions, settings: ReturnType<typeof createNarrationSettings>) {
  const { store } = options;
  const timeZone = options.timeZone ?? "UTC";
  const dailyLimit = options.dailyLimit ?? NARRATION_LIMITS.dailyRuns;
  async function allowance(): Promise<Allowance> {
    const started = new Date(startOfZonedDay(store.now(), timeZone)).toISOString();
    const used = z.object({ count: z.number() }).parse(await store.db.get(
      "SELECT count(*) AS count FROM narration_runs WHERE (started_at>=?) AND user_id=?", [started])).count;
    const limit = options.strictDailyLimit || (await settings.autoSettings()).records === "off"
      ? dailyLimit : Math.max(dailyLimit, NARRATION_LIMITS.autoDailyRuns);
    const tomorrow = new Date(Date.parse(`${zonedDate(new Date(store.now()), timeZone)}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
    return { limit, used, remaining: Math.max(0, limit - used), timeZone, failedStartsCount: true,
      resetsAt: new Date(zonedInstant(tomorrow, "00:00", timeZone)).toISOString() };
  }
  return {
    allowance,
    async assertAllowance() {
      const value = await allowance();
      if (!value.remaining) throw new RetryError({ code: "narration_daily_limit",
        message: `Daily limit of ${value.limit} starts reached; failed starts count (${timeZone})`, retryAt: value.resetsAt });
      const dayStart = new Date(startOfZonedDay(store.now(), timeZone)).toISOString();
      if (await new ControlDb(store.db.sql).narrationCount(dayStart) >= (options.globalDailyLimit ?? 60)) {
        throw new RetryError({ code: "narration_global_daily_limit",
          message: "The service daily narration limit has been reached", retryAt: value.resetsAt });
      }
    },
  };
}
