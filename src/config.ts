import { z } from "zod";
import ky from "ky";
import { systemTimeZone } from "../shared/time";

const ConfigSchema = z.object({
  appName: z.string().min(1),
  // An older server sends no version; the UI then shows none.
  version: z.string().default(""),
  timeZone: z.string().min(1),
  locale: z.enum(["en", "ko"]).catch("en"),
  authMode: z.enum(["local", "google"]).default("local"),
  features: z.object({ narration: z.boolean(), push: z.boolean(), digest: z.boolean(), trustedLogin: z.boolean(), demo: z.boolean().default(false) }),
});
/** What GET /api/v1/config reports: the app's name and version, calendar zone, default language and optional features. */
export type AppConfig = z.infer<typeof ConfigSchema>;
export type ConfigOverrides = Partial<Omit<AppConfig, "features">> & { readonly features?: Partial<AppConfig["features"]> };

/** The loaded config. Until loadConfig resolves it holds defaults (this device's zone, English, no optional features). */
export const config: AppConfig = {
  appName: "Agentic Dashboard",
  version: "",
  timeZone: systemTimeZone(),
  locale: "en",
  authMode: "local",
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
  const response = await ky.get("/api/v1/config", { credentials: "same-origin", retry: 0 });
  configure(ConfigSchema.parse(await response.json()));
  return config;
}
