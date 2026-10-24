import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { mockOidc } from "../tests/helpers/mock-oidc";
import { createApp } from "../server/app";
import { appOptions } from "../server/config-app";
import { parseConfig } from "../server/config";
import { ProviderError } from "../server/narration";
import { secret } from "../server/agents";

/** Isolated manual QA only: generated OIDC/KEK secrets, fake Google key validation, and no real speech calls. */
const port = z.coerce.number().int().min(1).max(65535).parse(process.env.PORT ?? "4390");
const directory = mkdtempSync(join(tmpdir(), "hosted-qa-"));
const issuer = await mockOidc();
const config = parseConfig({
  AUTH_MODE: "google", APP_ORIGIN: `http://127.0.0.1:${port}`, PORT: String(port), PUSH: "off", APP_NAME: "floweredao",
  DATA_DIR: directory, TIME_ZONE: "UTC", LOCALE: "en", NARRATION_RECORD_AUTO: "off",
  CONTACT_EMAIL: "operator@example.test", DATABASE_REGION: "local QA database",
  APP_SECRETS: JSON.stringify({ google: { clientId: "mock-client", clientSecret: secret() }, sessionSigningKey: secret(),
    kek: { "1": Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64") } }),
});
if (!config.hosted) throw new TypeError("The QA harness requires hosted mode");
const app = await createApp({
  ...appOptions(config),
  hosted: { ...config.hosted, endpoints: issuer.endpoints },
  geminiKeys: { kek: config.APP_SECRETS.kek, selectedModels: { script: config.NARRATION_KEY_SCRIPT_MODEL, speech: config.NARRATION_TTS_MODEL },
    validate: async key => ({ accepted: key.startsWith("test-"), models: [config.NARRATION_KEY_SCRIPT_MODEL, config.NARRATION_TTS_MODEL] }) },
  personalProvider: key => ({
    voice: "Kore", hosts: ["Kore", "Puck"], scriptModel: "mock-script", ttsModel: "mock-speech",
    available: async () => await key() !== null,
    script: async () => { throw new ProviderError("vertex_auth", false); },
    speak: async () => { throw new ProviderError("vertex_auth", false); },
    converse: async () => { throw new ProviderError("vertex_auth", false); },
  }),
});
const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: app.fetch });
console.log(`MOCK_HOSTED_READY http://127.0.0.1:${server.port}`);
console.log(`MOCK_OIDC_DISCOVERY ${issuer.origin}/.well-known/openid-configuration`);
console.log("QA only: key validation accepts test-prefixed strings; audio fails without making provider calls.");
async function stop() {
  server.stop(true);
  issuer.close();
  await app.close();
  rmSync(directory, { recursive: true, force: true });
  process.exit(0);
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
