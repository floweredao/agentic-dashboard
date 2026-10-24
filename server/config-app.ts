import { join } from "node:path";
import type { Configuration } from "./config";
import type { AppOptions } from "./app";
import { geminiProvider, envKey, type KeySource } from "./gemini";
import { adcCredentials } from "./vertex";
import { commandRunner } from "./ai-fill";

export function appOptions(config: Configuration): AppOptions {
  const provider = (key: KeySource) => geminiProvider({
    key, ttsModel: config.NARRATION_TTS_MODEL, scriptModel: config.NARRATION_SCRIPT_MODEL,
    keyScriptModel: config.NARRATION_KEY_SCRIPT_MODEL, voice: config.NARRATION_VOICE, podcastVoice: config.NARRATION_PODCAST_VOICE,
    ...(config.NARRATION_TTS_PROVIDER === "vertex" && config.NARRATION_VERTEX_PROJECT ? {
      vertex: { project: config.NARRATION_VERTEX_PROJECT, location: config.NARRATION_VERTEX_LOCATION, credentials: adcCredentials() },
    } : {}),
  });
  return {
    ...(config.DATABASE_URL ? { databaseUrl: config.DATABASE_URL } : {}),
    ...(config.databaseToken ? { databaseAuthToken: config.databaseToken } : {}),
    databasePath: config.DATABASE_PATH ?? join(config.DATA_DIR, "dashboard.sqlite"),
    credentialsPath: config.CREDENTIALS_PATH ?? join(config.DATA_DIR, "credentials.json"),
    staticRoot: config.STATIC_DIR, port: config.PORT, agentPort: config.AGENT_PORT, trustedAuthProxy: config.trustedAuthProxy,
    privateOrigin: config.bindings.origin, appName: config.APP_NAME, timeZone: config.TIME_ZONE, locale: config.LOCALE,
    ...(config.hosted ? { hosted: config.hosted, geminiKeys: { kek: config.APP_SECRETS.kek, model: config.AI_FILL_MODEL,
      selectedModels: { script: config.NARRATION_KEY_SCRIPT_MODEL, speech: config.NARRATION_TTS_MODEL } }, personalProvider: provider } : {}),
    ...(config.AUDIO_BUCKET ? { audioBucket: config.AUDIO_BUCKET } : {}),
    ...(config.TRUSTED_USER_HEADER && config.OWNER_LOGIN ? { trustedIdentity: { header: config.TRUSTED_USER_HEADER, login: config.OWNER_LOGIN } } : {}),
    ...(config.PUBLIC_API_BASE_URL ? { publicApiBaseUrl: config.PUBLIC_API_BASE_URL } : {}),
    mcpPort: config.MCP_PORT,
    ...(config.mcpListener && config.MCP_AGENT ? { mcpAgent: config.MCP_AGENT } : {}),
    pushEnabled: config.PUSH && !config.DEMO, digestEnabled: config.DIGEST, demo: config.DEMO,
    narrationEnabled: config.NARRATION && !config.DEMO,
    ...(config.VAPID_PATH ? { vapidPath: config.VAPID_PATH } : {}),
    push: { subject: config.hosted ? config.bindings.vapidSubject : config.VAPID_SUBJECT ??
      (config.bindings.origin.startsWith("https:") ? config.bindings.origin : "mailto:admin@localhost"),
      ...(config.hosted && config.APP_SECRETS.vapid ? { vapid: config.APP_SECRETS.vapid } : {}) },
    ...(config.AI_FILL_COMMAND ? { aiFill: { run: commandRunner(config.AI_FILL_COMMAND.split(/\s+/)), model: config.AI_FILL_COMMAND, sources: config.AI_FILL_SOURCES } } : {}),
    ...(config.NARRATION && !config.DEMO ? { narration: {
      provider: config.hosted ? null : provider(envKey("GEMINI_API_KEY", { GEMINI_API_KEY: config.GEMINI_API_KEY })), globalDailyLimit: config.NARRATION_GLOBAL_DAILY_LIMIT,
      concurrency: config.NARRATION_CONCURRENCY, dailyLimit: config.NARRATION_DAILY_LIMIT,
      autoDefaults: { digests: config.NARRATION_DIGEST_AUTO, records: config.NARRATION_RECORD_AUTO },
      ...(config.AUDIO_DIR ? { audioDir: config.AUDIO_DIR } : {}),
    } } : {}),
  };
}
