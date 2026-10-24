import { expect, test } from "bun:test";
import { parseConfig } from "../server/config";
import { appOptions } from "../server/config-app";

const secrets = () => JSON.stringify({
  kek: { "1": Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64") },
  sessionSigningKey: crypto.randomUUID() + crypto.randomUUID(), google: { clientId: "test-client", clientSecret: crypto.randomUUID() },
});

test("hosted configuration refuses absent origin or incomplete secrets", () => {
  expect(() => parseConfig({ AUTH_MODE: "google", PUSH: "off" })).toThrow();
  expect(() => parseConfig({ AUTH_MODE: "google", PUSH: "off", APP_ORIGIN: "https://example.test" })).toThrow();
});

test("changing APP_ORIGIN changes every origin-bound value together", () => {
  for (const origin of ["https://first.example.test", "https://second.example.test"]) {
    // Given one explicit hosted origin and generated secrets.
    const parsed = parseConfig({ AUTH_MODE: "google", APP_ORIGIN: origin, APP_SECRETS: secrets(), PUSH: "off",
      ENABLE_MCP: "on", ENABLE_AGENT_INGRESS: "on" });
    // When the same production configuration builder wires the app.
    const options = appOptions(parsed);
    // Then no loopback or old origin remains in any origin-bound value.
    expect({
      redirect: parsed.bindings.redirectUri, push: options.push?.subject, share: options.privateOrigin,
      origins: [...parsed.bindings.origins], hosts: [...parsed.bindings.hosts],
      ingress: parsed.agentIngress, mcpListener: parsed.mcpListener,
    }).toEqual({
      redirect: `${origin}/auth/google/callback`, push: origin, share: origin,
      origins: [origin], hosts: [new URL(origin).host], ingress: false, mcpListener: false,
    });
  }
});

test("local configuration preserves optional owner login and environment-key narration", () => {
  const parsed = parseConfig({ PUSH: "off" });
  expect(parsed.AUTH_MODE).toBe("local");
  expect(parsed.hosted).toBeUndefined();
  expect(parsed.bindings.origins.has("http://127.0.0.1:4311")).toBe(true);
  expect(appOptions(parsed).geminiKeys).toBeUndefined();
});

test("forwarded auth addresses are trusted only for hosted proxy ingress", () => {
  const hosted = { AUTH_MODE: "google", APP_ORIGIN: "https://example.test", APP_SECRETS: secrets(), PUSH: "off" };
  expect(appOptions(parseConfig({ ...hosted, K_SERVICE: "fixture-service" })).trustedAuthProxy).toBe(true);
  expect(appOptions(parseConfig({ ...hosted, AUTH_TRUST_PROXY: "on" })).trustedAuthProxy).toBe(true);
  expect(appOptions(parseConfig(hosted)).trustedAuthProxy).toBe(false);
  expect(appOptions(parseConfig({ ...hosted, K_SERVICE: "fixture-service", AUTH_TRUST_PROXY: "off" })).trustedAuthProxy).toBe(false);
  expect(appOptions(parseConfig({ AUTH_MODE: "local", K_SERVICE: "fixture-service", AUTH_TRUST_PROXY: "on" })).trustedAuthProxy).toBe(false);
});
