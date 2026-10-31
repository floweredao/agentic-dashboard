import { expect, test } from "bun:test";
import { parseConfig } from "../server/config";
import { secret } from "../server/agents";

test("public demo destinations never expose URL credentials", () => {
  expect(() => parseConfig({ DEMO_HOSTED_URL: "https://name:password@example.test" })).toThrow();
  expect(parseConfig({ DEMO_HOSTED_URL: "https://dashboard.example.test/auth/google/start" }).DEMO_HOSTED_URL)
    .toBe("https://dashboard.example.test/auth/google/start");
});

test("hosted startup requires an operator contact for public policies", () => {
  // Given: otherwise valid generated hosted settings.
  const env = { AUTH_MODE: "google", APP_ORIGIN: "https://dashboard.example.test", PUSH: "off",
    APP_SECRETS: JSON.stringify({ google: { clientId: "fixture", clientSecret: secret() }, sessionSigningKey: secret(),
      kek: { "1": Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64") } }) };
  // When/Then: missing contact is rejected before serving sign-in.
  expect(() => { parseConfig(env); }).toThrow("CONTACT_EMAIL");
  expect(parseConfig({ ...env, CONTACT_EMAIL: "operator@example.test" }).CONTACT_EMAIL).toBe("operator@example.test");
});
