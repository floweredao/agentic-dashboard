import { z } from "zod";
import { DashboardRecordSchema } from "./contracts";

export const RecordSyncSchema = z.object({
  cursor: z.number().int().nonnegative(), items: z.array(DashboardRecordSchema),
  deletedIds: z.array(z.string()), hasMore: z.boolean(), reset: z.boolean(),
});
export type RecordSync = z.infer<typeof RecordSyncSchema>;
