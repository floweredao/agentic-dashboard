import { z } from "zod";
import { NARRATION_LIMITS } from "../shared/contracts";
import { systemTimeZone, validTimeZone } from "../shared/time";
import { GEMINI_KEY_SCRIPT_MODEL, GEMINI_PODCAST_VOICE, GEMINI_SCRIPT_MODEL, GEMINI_TTS_MODEL, GEMINI_VOICE } from "./gemini";
import { AI_FILL_MODEL } from "./gemini-runner";
import { VERTEX_LOCATION } from "./vertex";
import { originSettings } from "./origin";
import { ApiError } from "./errors";

const onOff = z.enum(["on", "off", "true", "false"]).transform(value => value === "on" || value === "true");
const text = z.string().trim().min(1);
const secretsSchema = z.object({
  kek: z.record(z.string().regex(/^[1-9]\d*$/), z.string().regex(/^[A-Za-z0-9+/]{43}=$/)).default({}),
  sessionSigningKey: z.string().min(32).max(512).optional(),
  google: z.object({ clientId: text, clientSecret: text }).optional(),
  vapid: z.object({ publicKey: text, privateKey: text }).optional(),
  turso: z.object({ authToken: text.optional(), platformToken: text.optional(), org: text.optional() }).optional(),
  resend: z.object({ apiKey: text }).optional(),
}).strict();
const secretJson = z.string().transform((value, context): unknown => {
  try { return JSON.parse(value); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    context.addIssue({ code: "custom", message: "APP_SECRETS must be JSON" });
    return z.NEVER;
  }
}).pipe(secretsSchema);
const envSchema = z.object({
  HOST: text.default("127.0.0.1"), PORT: z.coerce.number().int().min(0).max(65535).default(4310),
  AUTH_MODE: z.enum(["local", "google"]).default("local"), APP_SECRETS: secretJson.prefault("{}"),
  APP_ORIGIN: z.url().refine(value => {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && url.pathname === "/" && !url.search && !url.hash && !url.username && !url.password;
  }, "APP_ORIGIN must be an HTTP(S) origin, without path or credentials").transform(value => new URL(value).origin).optional(),
  APP_NAME: text.max(60).default("Agentic Dashboard"), DATA_DIR: text.default("data"),
  DATABASE_URL: text.optional(), DATABASE_AUTH_TOKEN: text.optional(), DATABASE_PATH: text.optional(), CREDENTIALS_PATH: text.optional(),
  STATIC_DIR: text.default("dist"), TIME_ZONE: text.default(systemTimeZone()).refine(validTimeZone, "Unknown IANA time zone"),
  LOCALE: z.enum(["en", "ko"]).default("en"), TRUSTED_USER_HEADER: text.optional(), OWNER_LOGIN: text.optional(),
  ENABLE_AGENT_INGRESS: onOff.default(false), AGENT_PORT: z.coerce.number().int().min(0).max(65535).default(4312),
  PUBLIC_API_BASE_URL: z.url().optional(), ENABLE_MCP: onOff.default(false), MCP_PORT: z.coerce.number().int().min(0).max(65535).default(4313),
  MCP_AGENT: text.optional(), PUSH: onOff.default(true), VAPID_PATH: text.optional(),
  VAPID_SUBJECT: text.regex(/^(?:mailto:|https:\/\/)/).optional(), DIGEST: onOff.default(true), NARRATION: onOff.default(true),
  NARRATION_TTS_MODEL: text.default(GEMINI_TTS_MODEL), NARRATION_KEY_SCRIPT_MODEL: text.default(GEMINI_KEY_SCRIPT_MODEL),
  NARRATION_RECORD_AUTO: z.enum(["off", "read", "podcast"]).default("read"),
  NARRATION_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(2),
  NARRATION_SCRIPT_MODEL: text.default(GEMINI_SCRIPT_MODEL), NARRATION_VOICE: text.default(GEMINI_VOICE),
  NARRATION_PODCAST_VOICE: text.default(GEMINI_PODCAST_VOICE), NARRATION_TTS_PROVIDER: z.enum(["gemini", "vertex"]).default("gemini"),
  NARRATION_VERTEX_PROJECT: text.optional(), NARRATION_VERTEX_LOCATION: text.default(VERTEX_LOCATION),
  NARRATION_DIGEST_AUTO: z.enum(["off", "parts", "all"]).default("off"),
  NARRATION_GLOBAL_DAILY_LIMIT: z.coerce.number().int().min(0).default(60),
  NARRATION_DAILY_LIMIT: z.coerce.number().int().min(0).max(200).default(NARRATION_LIMITS.dailyRuns),
  AUDIO_DIR: text.optional(), GEMINI_API_KEY: text.optional(), AI_FILL_COMMAND: text.optional(), AI_FILL_MODEL: text.default(AI_FILL_MODEL),
  AI_FILL_SOURCES: z.string().transform(value => value.split(",").map(item => item.trim()).filter(Boolean)).default([]),
  DEMO: onOff.default(false), MAX_USERS: z.coerce.number().int().min(0).default(50),
  OWNER_ALERT_EMAIL: z.email().optional(), CONTACT_EMAIL: z.email().optional(), AUDIO_BUCKET: text.optional(),
  TASKS_QUEUE: text.optional(), TASKS_SERVICE_ACCOUNT: text.optional(),
  OWNER_USER_LIMITS: z.string().transform((value, context): unknown => {
    try { return JSON.parse(value); }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; context.addIssue({ code: "custom", message: "Expected JSON account limits" }); return z.NEVER; }
  }).pipe(z.record(z.string().min(1), z.number().int().min(0).max(200))).prefault("{}"),
});
export function parseConfig(env: Readonly<Record<string, string | undefined>>) {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) throw new ApiError(500, "configuration", `Invalid configuration fields: ${parsed.error.issues.map(issue => issue.path.join(".")).join(", ")}`);
  const config = parsed.data;
  const fail = (message: string): never => { throw new ApiError(500, "configuration", message); };
  if ((config.TRUSTED_USER_HEADER === undefined) !== (config.OWNER_LOGIN === undefined)) fail("Set TRUSTED_USER_HEADER and OWNER_LOGIN together.");
  if (config.DEMO && (config.AUTH_MODE !== "local" || config.TRUSTED_USER_HEADER || config.ENABLE_MCP || config.ENABLE_AGENT_INGRESS || config.AI_FILL_COMMAND)) {
    fail("Demo must use local read-only mode without trusted login, integrations or AI fill.");
  }
  if (config.NARRATION_TTS_PROVIDER === "vertex" && !config.NARRATION_VERTEX_PROJECT) fail("Vertex narration requires NARRATION_VERTEX_PROJECT.");
  if (config.AUTH_MODE === "local" && config.ENABLE_MCP && !config.MCP_AGENT) fail("Local MCP requires MCP_AGENT.");
  if ((config.TASKS_QUEUE === undefined) !== (config.TASKS_SERVICE_ACCOUNT === undefined) ||
    (config.TASKS_QUEUE && !config.APP_ORIGIN)) fail("Cloud Tasks requires TASKS_QUEUE, TASKS_SERVICE_ACCOUNT and APP_ORIGIN.");
  const hosted = (() => {
    if (config.AUTH_MODE === "local") return undefined;
    const { google, sessionSigningKey, kek, vapid } = config.APP_SECRETS;
    if (!config.APP_ORIGIN || !google || !sessionSigningKey || !Object.keys(kek).length) return fail("Google mode requires APP_ORIGIN and Google, signing and encryption secrets.");
    const url = new URL(config.APP_ORIGIN);
    if (url.protocol !== "https:" && !["127.0.0.1", "localhost"].includes(url.hostname)) fail("Google mode requires HTTPS outside loopback tests.");
    if (config.PUSH && !vapid) fail("Hosted push requires APP_SECRETS.vapid.");
    if (config.TRUSTED_USER_HEADER || config.AI_FILL_COMMAND) fail("Trusted-header login and command AI fill are local-only.");
    return { google, sessionSigningKey, maxUsers: config.MAX_USERS };
  })();
  return { ...config, NARRATION_DAILY_LIMIT: env.NARRATION_DAILY_LIMIT === undefined && hosted ? 10 : config.NARRATION_DAILY_LIMIT, hosted,
    bindings: originSettings(config.APP_ORIGIN ?? `http://127.0.0.1:${config.PORT}`, config.AUTH_MODE === "local", config.PORT),
    databaseToken: config.DATABASE_AUTH_TOKEN ?? config.APP_SECRETS.turso?.authToken,
    agentIngress: config.AUTH_MODE === "local" && config.ENABLE_AGENT_INGRESS,
    mcpListener: config.AUTH_MODE === "local" && config.ENABLE_MCP,
  };
}
export type Configuration = ReturnType<typeof parseConfig>;
