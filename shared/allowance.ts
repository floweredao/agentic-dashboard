import { z } from "zod";

export const AllowanceSchema = z.object({
  limit: z.number().int().nonnegative(), used: z.number().int().nonnegative(), remaining: z.number().int().nonnegative(),
  resetsAt: z.iso.datetime(), timeZone: z.string(), failedStartsCount: z.literal(true),
});
export type Allowance = z.infer<typeof AllowanceSchema>;
