import { expect, test } from "bun:test";
import { parseConfig } from "../server/config";
import { appOptions } from "../server/config-app";
import { createApp } from "../server/app";
import { z } from "zod";

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

test("auth limits parse operator overrides independently of defaults", () => {
  // Given explicit operator settings distinct from the defaults.
  const env = { TRUSTED_PROXY_HOPS: "2", PENDING_SIGN_IN_LIMIT: "7", AUTH_START_LIMIT: "3" };
  // When configuration is parsed.
  const config = parseConfig(env);
  // Then both settings survive boundary parsing.
  expect(config.TRUSTED_PROXY_HOPS).toBe(2);
  expect(config.PENDING_SIGN_IN_LIMIT).toBe(7);
  expect(config.AUTH_START_LIMIT).toBe(3);
});

test("auth limits default to one trusted hop and ten thousand pending starts", () => {
  // Given no overrides.
  const env = {};
  // When configuration is parsed.
  const config = parseConfig(env);
  // Then bounded defaults are available.
  expect(config.TRUSTED_PROXY_HOPS).toBe(1);
  expect(config.PENDING_SIGN_IN_LIMIT).toBe(10000);
  expect(config.AUTH_START_LIMIT).toBe(300);
});

test.each(["0", "-1", "1.5", "invalid", ""])("auth settings reject invalid positive integers: %s", value => {
  // Given an invalid operator value.
  for (const field of ["TRUSTED_PROXY_HOPS", "PENDING_SIGN_IN_LIMIT", "AUTH_START_LIMIT"]) {
    // When the boundary parses it, then startup fails.
    expect(() => parseConfig({ [field]: value })).toThrow();
  }
});

const configuredAuthApp = (overrides: Readonly<Record<string, string>>) => createApp(appOptions(parseConfig({
  AUTH_MODE: "google", APP_ORIGIN: "https://example.test", APP_SECRETS: secrets(),
  PUSH: "off", DIGEST: "off", NARRATION: "off", DATABASE_PATH: ":memory:", AUTH_TRUST_PROXY: "on",
  ...overrides,
})));

test("configured pending capacity reaches the real sign-in route", async () => {
  // Given production configuration with a two-row global cap.
  const app = await configuredAuthApp({ PENDING_SIGN_IN_LIMIT: "2" });
  try {
    // When three independent clients start sign-in.
    const responses = [];
    for (let i = 1; i <= 3; i++) responses.push(await app.fetch(new Request("https://example.test/auth/google/start", {
      headers: { "X-Forwarded-For": `198.51.100.${i}` },
    })));
    // Then new clients are admitted while total pending storage stays bounded.
    expect(responses.map(response => response.status)).toEqual([302, 302, 302]);
    const row = z.object({ count: z.number() }).parse(await app.sql.get("SELECT count(*) AS count FROM oauth_transactions"));
    expect(row.count).toBe(2);
  } finally { await app.close(); }
});

test("configured trusted hops reach the real sign-in limiter", async () => {
  // Given production configuration with an external load balancer.
  const app = await configuredAuthApp({ TRUSTED_PROXY_HOPS: "2" });
  try {
    const start = (client: string) => app.fetch(new Request("https://example.test/auth/google/start", {
      headers: { "X-Forwarded-For": `192.0.2.1, ${client}, 203.0.113.1` },
    }));
    for (let i = 0; i < 20; i++) await start("198.51.100.1");
    // When a new client arrives through that same balancer.
    const response = await start("198.51.100.2");
    // Then the balancer does not impose a shared rate budget.
    expect(response.status).toBe(302);
  } finally { await app.close(); }
});

test("configured global start ceiling reaches the real sign-in route", async () => {
  // Given production configuration allowing two starts per minute.
  const app = await configuredAuthApp({ AUTH_START_LIMIT: "2" });
  try {
    // When three independent IPv4 clients start.
    const statuses = [];
    for (let i = 1; i <= 3; i++) statuses.push((await app.fetch(new Request("https://example.test/auth/google/start", {
      headers: { "X-Forwarded-For": `198.51.100.${i}` },
    }))).status);
    // Then the configured ceiling rejects the third before storing another transaction.
    expect(statuses).toEqual([302, 302, 429]);
    expect(z.object({ count: z.number() }).parse(await app.sql.get("SELECT count(*) AS count FROM oauth_transactions")).count).toBe(2);
  } finally { await app.close(); }
});
