import { z } from "zod";
import { validTimeZone } from "./time";

export const AccountLocaleSchema = z.enum(["system", "en", "ko"]);
export const AccountFeaturesSchema = z.object({ digest: z.boolean(), push: z.boolean() }).strict();
export const AccountSchema = z.object({
  id: z.string(), email: z.email().nullable(), locale: AccountLocaleSchema, timeZone: z.string(),
  timeZoneSaved: z.boolean().optional(),
  onboardedAt: z.string().nullable(), agentSaveVerified: z.boolean(), features: AccountFeaturesSchema,
  agentSaveRecordId: z.string().nullable().default(null),
});
export type Account = z.infer<typeof AccountSchema>;
export const AccountPreferencesSchema = z.object({
  locale: AccountLocaleSchema.optional(),
  timeZone: z.string().max(100).refine(validTimeZone, "Unknown IANA time zone").optional(),
  features: AccountFeaturesSchema.optional(),
}).strict();
export type AccountPreferences = z.infer<typeof AccountPreferencesSchema>;
