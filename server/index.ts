import { join } from "node:path";
import { z } from "zod";
import { NARRATION_LIMITS } from "../shared/contracts";
import { systemTimeZone, validTimeZone } from "../shared/time";
import { commandRunner } from "./ai-fill";
import { createApp } from "./app";
import { envKey, GEMINI_PODCAST_VOICE, GEMINI_SCRIPT_FALLBACK_MODEL, GEMINI_SCRIPT_MODEL, GEMINI_TTS_MODEL, GEMINI_VOICE, geminiProvider } from "./gemini";

const onOff = z.enum(["on", "off", "true", "false"]).transform(value => value === "on" || value === "true");
const list = z.string().transform(value => value.split(",").map(item => item.trim()).filter(Boolean));
const parsed = z.object({
  HOST: z.string().trim().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(0).max(65535).default(4310),
  APP_ORIGIN: z.url().optional(),
  APP_NAME: z.string().trim().min(1).max(60).default("Agentic Dashboard"),
  DATA_DIR: z.string().trim().min(1).default("data"),
  DATABASE_PATH: z.string().trim().min(1).optional(),
  CREDENTIALS_PATH: z.string().trim().min(1).optional(),
  STATIC_DIR: z.string().trim().min(1).default("dist"),
  TIME_ZONE: z.string().trim().min(1).default(systemTimeZone()).refine(validTimeZone, "Unknown IANA time zone"),
  LOCALE: z.enum(["en", "ko"]).default("en"),
  TRUSTED_USER_HEADER: z.string().trim().min(1).optional(),
  OWNER_LOGIN: z.string().trim().min(1).optional(),
  ENABLE_AGENT_INGRESS: onOff.default(false),
  AGENT_PORT: z.coerce.number().int().min(0).max(65535).default(4312),
  PUBLIC_API_BASE_URL: z.url().optional(),
  ENABLE_MCP: onOff.default(false),
  MCP_PORT: z.coerce.number().int().min(0).max(65535).default(4313),
  MCP_AGENT: z.string().trim().min(1).optional(),
  PUSH: onOff.default(true),
  VAPID_PATH: z.string().trim().min(1).optional(),
  VAPID_SUBJECT: z.string().trim().regex(/^(?:mailto:|https:\/\/)/, "mailto: or https:// address").optional(),
  DIGEST: onOff.default(true),
  NARRATION: onOff.default(true),
  NARRATION_TTS_MODEL: z.string().trim().min(1).default(GEMINI_TTS_MODEL),
  NARRATION_SCRIPT_MODEL: z.string().trim().min(1).default(GEMINI_SCRIPT_MODEL),
  NARRATION_SCRIPT_FALLBACK_MODEL: z.string().trim().min(1).default(GEMINI_SCRIPT_FALLBACK_MODEL),
  NARRATION_VOICE: z.string().trim().min(1).default(GEMINI_VOICE),
  NARRATION_PODCAST_VOICE: z.string().trim().min(1).default(GEMINI_PODCAST_VOICE),
  NARRATION_DAILY_LIMIT: z.coerce.number().int().min(0).max(200).default(NARRATION_LIMITS.dailyRuns),
  AUDIO_DIR: z.string().trim().min(1).optional(),
  AI_FILL_COMMAND: z.string().trim().min(1).optional(),
  AI_FILL_SOURCES: list.default([]),
  DEMO: onOff.default(false),
}).safeParse(process.env);
if (!parsed.success) {
  console.error(`Invalid configuration:\n${parsed.error.issues.map(issue => `  ${issue.path.join(".")}: ${issue.message}`).join("\n")}`);
  process.exit(1);
}
const config = parsed.data;
if ((config.TRUSTED_USER_HEADER === undefined) !== (config.OWNER_LOGIN === undefined)) {
  console.error("Invalid configuration: set TRUSTED_USER_HEADER and OWNER_LOGIN together, or neither.");
  process.exit(1);
}
if (config.DEMO && (config.TRUSTED_USER_HEADER || config.ENABLE_MCP || config.ENABLE_AGENT_INGRESS || config.AI_FILL_COMMAND)) {
  console.error("Invalid configuration: DEMO=on is a public read-only demo; turn off TRUSTED_USER_HEADER, ENABLE_MCP, ENABLE_AGENT_INGRESS and AI_FILL_COMMAND.");
  process.exit(1);
}
if (config.ENABLE_MCP && !config.MCP_AGENT) {
  console.error("Invalid configuration: ENABLE_MCP needs MCP_AGENT, the registered agent MCP calls are saved as.");
  process.exit(1);
}

const app = createApp({
  databasePath: config.DATABASE_PATH ?? join(config.DATA_DIR, "dashboard.sqlite"),
  credentialsPath: config.CREDENTIALS_PATH ?? join(config.DATA_DIR, "credentials.json"),
  staticRoot: config.STATIC_DIR,
  port: config.PORT, agentPort: config.AGENT_PORT,
  privateOrigin: config.APP_ORIGIN ?? `http://127.0.0.1:${config.PORT}`,
  appName: config.APP_NAME, timeZone: config.TIME_ZONE, locale: config.LOCALE,
  ...(config.TRUSTED_USER_HEADER && config.OWNER_LOGIN ? { trustedIdentity: { header: config.TRUSTED_USER_HEADER, login: config.OWNER_LOGIN } } : {}),
  ...(config.PUBLIC_API_BASE_URL ? { publicApiBaseUrl: config.PUBLIC_API_BASE_URL } : {}),
  mcpPort: config.MCP_PORT,
  ...(config.ENABLE_MCP && config.MCP_AGENT ? { mcpAgent: config.MCP_AGENT } : {}),
  // A demo never sends push or calls a speech provider, whatever else is set.
  pushEnabled: config.PUSH && !config.DEMO, digestEnabled: config.DIGEST, demo: config.DEMO,
  ...(config.VAPID_PATH ? { vapidPath: config.VAPID_PATH } : {}),
  ...(config.VAPID_SUBJECT ? { push: { subject: config.VAPID_SUBJECT } } : {}),
  ...(config.AI_FILL_COMMAND ? { aiFill: { run: commandRunner(config.AI_FILL_COMMAND.split(/\s+/)), model: config.AI_FILL_COMMAND, sources: config.AI_FILL_SOURCES } } : {}),
  ...(config.NARRATION && !config.DEMO ? { narration: {
    provider: geminiProvider({ key: envKey(), ttsModel: config.NARRATION_TTS_MODEL, scriptModel: config.NARRATION_SCRIPT_MODEL,
      fallbackScriptModel: config.NARRATION_SCRIPT_FALLBACK_MODEL, voice: config.NARRATION_VOICE,
      podcastVoice: config.NARRATION_PODCAST_VOICE }),
    dailyLimit: config.NARRATION_DAILY_LIMIT, ...(config.AUDIO_DIR ? { audioDir: config.AUDIO_DIR } : {}),
  } } : {}),
});
if (config.ENABLE_MCP && config.MCP_AGENT) {
  const agent = app.agents.get(config.MCP_AGENT);
  if (!agent || agent.revokedAt !== null) {
    console.error(`Invalid configuration: MCP_AGENT ${config.MCP_AGENT} is not an active registered agent; run bun run agents add ${config.MCP_AGENT}.`);
    app.close();
    process.exit(1);
  }
}
const privateServer = Bun.serve({ hostname: config.HOST, port: config.PORT, fetch: app.fetch });
const publicServer = config.ENABLE_AGENT_INGRESS
  ? Bun.serve({ hostname: "127.0.0.1", port: config.AGENT_PORT, fetch: app.publicFetch }) : null;
const mcpServer = config.ENABLE_MCP ? Bun.serve({ hostname: "127.0.0.1", port: config.MCP_PORT, fetch: app.mcpFetch }) : null;
const narrationOn = config.NARRATION && !config.DEMO && await app.narration.available();
console.log([
  `${config.APP_NAME} listening on http://${config.HOST}:${privateServer.port}`,
  `agent ingress ${publicServer ? `127.0.0.1:${publicServer.port}` : "disabled"}`,
  `mcp ${mcpServer ? `http://127.0.0.1:${mcpServer.port}/mcp` : "disabled"}`,
  ...(config.DEMO ? ["read-only demo"] : []),
  `push ${config.PUSH && !config.DEMO ? "on" : "off"}`, `digest ${config.DIGEST ? "on" : "off"}`,
  `narration ${narrationOn ? "on" : "off"}`, `ai fill ${config.AI_FILL_COMMAND ? "on" : "off"}`, `time zone ${config.TIME_ZONE}`,
].join("; "));
const purgeTimer = setInterval(() => app.purgeTrash(), 60 * 60 * 1000);
function stop() {
  clearInterval(purgeTimer);
  privateServer.stop(true);
  publicServer?.stop(true);
  mcpServer?.stop(true);
  app.close();
  process.exit(0);
}
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
