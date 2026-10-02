import { z } from "zod";
import { systemTimeZone } from "../shared/time";

const ConfigSchema = z.object({
  appName: z.string().min(1),
  timeZone: z.string().min(1),
  locale: z.enum(["en", "ko"]).catch("en"),
  features: z.object({ narration: z.boolean(), push: z.boolean(), digest: z.boolean(), trustedLogin: z.boolean(), demo: z.boolean().default(false) }),
});
/** What GET /api/v1/config reports: the app's name, calendar zone, default language and optional features. */
export type AppConfig = z.infer<typeof ConfigSchema>;
export type ConfigOverrides = Partial<Omit<AppConfig, "features">> & { readonly features?: Partial<AppConfig["features"]> };

/** The loaded config. Until loadConfig resolves it holds defaults (this device's zone, English, no optional features). */
export const config: AppConfig = {
  appName: "Agentic Dashboard",
  timeZone: systemTimeZone(),
  locale: "en",
  features: { narration: false, push: false, digest: false, trustedLogin: false, demo: false },
};

/** Merge values into the config (main.tsx after loading it, and the test preload). */
export function configure(next: ConfigOverrides) {
  const { features, ...rest } = next;
  Object.assign(config, rest);
  config.features = { ...config.features, ...features };
}

/** Loads GET /api/v1/config (no auth) once, before the app renders. */
export async function loadConfig(): Promise<AppConfig> {
  const response = await fetch("/api/v1/config", { credentials: "same-origin" });
  if (!response.ok) throw new Error(`GET /api/v1/config failed with ${response.status}`);
  configure(ConfigSchema.parse(await response.json()));
  return config;
}
