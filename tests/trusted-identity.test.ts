import { expect, test } from "bun:test";
import { z } from "zod";
import { createApp, type AppOptions } from "../server/app";
import { bearer, fixture, origin, payload, recordResult, tokens } from "./backend-helper";

const privateOrigin = "https://dashboard.example.test:9443";
const ownerLogin = "owner@example.test";
const sessionResult = z.object({
  principal: z.object({ id: z.literal("owner"), source: z.literal("manual") }),
  csrfToken: z.string().min(1), expiresAt: z.iso.datetime(),
});
const enabled = { privateOrigin, trustedIdentity: { header: "Tailscale-User-Login", login: ownerLogin } };
const identity = { "Tailscale-User-Login": ownerLogin };

test("bootstraps an owner session when trusted Serve identity reaches the private HTTPS host", async () => {
  // Given: the loopback backend sits behind the configured HTTPS Serve origin.
  const f = fixture();
  const options = { ...f.options, privateOrigin, trustedIdentity: { header: "Tailscale-User-Login", login: ownerLogin } };
  const app = createApp(options);
  try {
    // When: Serve forwards the owner identity without a token or cookie.
    const response = await app.fetch(new Request(`${privateOrigin}/api/v1/auth/session`, {
      headers: { "Tailscale-User-Login": ownerLogin },
    }));
    // Then: the existing owner session contract and secure cookie are returned.
    expect(response.status).toBe(200);
    sessionResult.parse(await response.json());
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("agentic_session=");
    expect(cookie).toContain("; HttpOnly");
    expect(cookie).toContain("; SameSite=Strict");
    expect(cookie).toContain("; Secure");
    expect(response.headers.get("cache-control")).toBe("no-store");
  } finally {
    app.close();
    f.close();
  }
});

const deniedCases: readonly {
  readonly name: string;
  readonly options?: AppOptions;
  readonly headers?: HeadersInit;
  readonly method?: string;
  readonly status: number;
}[] = [
  { name: "disabled by default", options: { privateOrigin }, headers: identity, status: 401 },
  { name: "empty configured login", options: { privateOrigin, trustedIdentity: { header: "Tailscale-User-Login", login: "" } }, headers: identity, status: 401 },
  { name: "HTTP private origin", options: { privateOrigin: origin, trustedIdentity: { header: "Tailscale-User-Login", login: ownerLogin } }, headers: { ...identity, Host: new URL(origin).host }, status: 401 },
  { name: "HEAD instead of GET", method: "HEAD", headers: identity, status: 401 },
  { name: "missing identity", status: 401 },
  { name: "wrong identity", headers: { "Tailscale-User-Login": "other@example.com" }, status: 401 },
  { name: "empty identity", headers: { "Tailscale-User-Login": "" }, status: 401 },
  { name: "combined identities", headers: { "Tailscale-User-Login": `${ownerLogin},other@example.com` }, status: 401 },
  { name: "display name only", headers: { "Tailscale-User-Name": ownerLogin }, status: 401 },
  { name: "local Host", headers: { ...identity, Host: "127.0.0.1:4310" }, status: 401 },
  { name: "forwarded Host only", headers: { ...identity, Host: "127.0.0.1:4310", "X-Forwarded-Host": new URL(privateOrigin).host, "X-Forwarded-Proto": "https" }, status: 401 },
  { name: "public Host", headers: { ...identity, Host: "agents.example.com" }, status: 401 },
  { name: "wrong port", headers: { ...identity, Host: new URL(privateOrigin).hostname }, status: 421 },
  { name: "disallowed Host", headers: { ...identity, Host: "evil.example.com" }, status: 421 },
  { name: "disallowed Origin", headers: { ...identity, Origin: "https://evil.example.com" }, status: 403 },
  { name: "empty Authorization", headers: { ...identity, Authorization: "" }, status: 401 },
  { name: "malformed Authorization", headers: { ...identity, Authorization: "Basic invalid" }, status: 401 },
  { name: "invalid Bearer", headers: { ...identity, Authorization: "Bearer invalid" }, status: 401 },
  { name: "agent Bearer", headers: { ...identity, ...bearer("omo") }, status: 403 },
  { name: "owner Bearer", headers: { ...identity, ...bearer("owner") }, status: 403 },
];

test.each([...deniedCases])("does not bootstrap when $name", async ({ options, headers, method, status }) => {
  // Given: one bootstrap condition is absent or explicitly disallowed.
  const f = fixture();
  const app = createApp({ ...f.options, publicApiBaseUrl: "https://agents.example.com", ...(options ?? enabled) });
  try {
    // When: the private session endpoint receives that request.
    const response = await app.fetch(new Request(`${privateOrigin}/api/v1/auth/session`, { method: method ?? "GET", headers: headers ?? {} }));
    // Then: it cannot issue an owner cookie.
    expect(response.status).toBe(status);
    expect(response.headers.get("set-cookie")).toBeNull();
  } finally { app.close(); f.close(); }
});

test.each([{}, identity, { "Tailscale-User-Login": "other@example.com" }])(
  "reuses a valid session without renewal regardless of identity headers %j", async headers => {
    // Given: an existing owner session created through the manual API.
    const f = fixture();
    const app = createApp({ ...f.options, ...enabled });
    try {
      const manual = await f.login();
      const before = await f.call("/api/v1/auth/session", "GET", undefined, manual);
      const expected = sessionResult.parse(await before.json());
      // When: the session is read on the Serve host.
      const response = await app.fetch(new Request(`${privateOrigin}/api/v1/auth/session`, {
        headers: { ...headers, Cookie: manual.Cookie },
      }));
      // Then: the session, CSRF token and expiry are unchanged, with no Set-Cookie.
      expect(response.status).toBe(200);
      expect(sessionResult.parse(await response.json())).toEqual(expected);
      expect(response.headers.get("set-cookie")).toBeNull();
    } finally { app.close(); f.close(); }
  },
);

test("does not fall back to an existing cookie when Authorization is explicit", async () => {
  // Given: both an owner cookie and the correct Serve identity.
  const f = fixture();
  const app = createApp({ ...f.options, ...enabled });
  try {
    const session = await f.login();
    // When: an invalid Bearer is explicitly provided as well.
    const response = await app.fetch(new Request(`${privateOrigin}/api/v1/auth/session`, {
      headers: { ...identity, Cookie: session.Cookie, Authorization: "Bearer invalid" },
    }));
    // Then: neither cookie nor identity rescues that request.
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
  } finally { app.close(); f.close(); }
});

test.each(["invalid", "expired"] as const)("replaces a %s cookie only for trusted identity", async state => {
  // Given: a cookie that cannot authenticate, with a deterministic clock.
  let now = Date.UTC(2026, 8, 21);
  const f = fixture(10000, () => now);
  const app = createApp({ ...f.options, ...enabled });
  try {
    const previous = await f.login();
    now += 8 * 24 * 60 * 60 * 1000;
    const Cookie = state === "invalid" ? "agentic_session=invalid" : previous.Cookie;
    expect((await app.fetch(new Request(`${privateOrigin}/api/v1/auth/session`, { headers: { Cookie } }))).status).toBe(401);
    // When: trusted identity accompanies the unusable cookie.
    const response = await app.fetch(new Request(`${privateOrigin}/api/v1/auth/session`, { headers: { ...identity, Cookie } }));
    // Then: a fresh seven-day session is issued.
    expect(response.status).toBe(200);
    const session = sessionResult.parse(await response.json());
    expect(Date.parse(session.expiresAt)).toBe(now + 7 * 24 * 60 * 60 * 1000);
    expect(session.csrfToken === previous["X-CSRF-Token"]).toBe(false);
    expect(response.headers.has("set-cookie")).toBe(true);
  } finally { app.close(); f.close(); }
});

test("real loopback HTTP preserves owner CSRF and public agent isolation after bootstrap", async () => {
  // Given: isolated databases and actual private/public loopback listeners.
  const f = fixture();
  const app = createApp({ ...f.options, ...enabled });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  const ingress = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.publicFetch });
  const call = (path: string, init: RequestInit = {}, publicOnly = false) => {
    const headers = new Headers(init.headers);
    headers.set("Host", new URL(privateOrigin).host);
    return fetch(`http://127.0.0.1:${publicOnly ? ingress.port : server.port}${path}`, {
      ...init, headers, signal: AbortSignal.timeout(5000),
    });
  };
  try {
    // When: Serve's HTTP backend hop carries the HTTPS Host and owner identity.
    const login = await call("/api/v1/auth/session", { headers: identity });
    expect(login.status).toBe(200);
    const session = sessionResult.parse(await login.json());
    expect(login.headers.get("set-cookie")).toContain("; Secure");
    const Cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    const owner = { Cookie, Origin: privateOrigin, "X-CSRF-Token": session.csrfToken, "Content-Type": "application/json" };
    // Then: the cookie works over the real API, without turning identity into general API auth.
    expect((await call("/api/v1/records", { headers: identity })).status).toBe(401);
    expect((await call("/api/v1/records", { headers: { Cookie } })).status).toBe(200);
    expect((await call("/api/v1/records", { method: "POST", headers: { Cookie, Origin: privateOrigin }, body: JSON.stringify(payload()) })).status).toBe(403);
    expect((await call("/api/v1/records", { method: "POST", headers: { ...owner, Origin: "https://evil.example.com" }, body: JSON.stringify(payload()) })).status).toBe(403);
    const created = await call("/api/v1/records", { method: "POST", headers: owner, body: JSON.stringify(payload()) });
    expect(created.status).toBe(201);
    const record = recordResult.parse(await created.json()).record;
    expect(record.createdBy).toBe("owner");
    expect(record.source).toBe("manual");
    expect((await call(`/api/v1/records/${record.id}`, { method: "PATCH", headers: { Cookie, Origin: privateOrigin }, body: JSON.stringify({ expectedVersion: 1, changes: { title: "No CSRF" } }) })).status).toBe(403);
    expect((await call(`/api/v1/records/${record.id}`, { method: "PATCH", headers: owner, body: JSON.stringify({ expectedVersion: 1, changes: { title: "Owner patch" } }) })).status).toBe(200);
    for (const path of ["/", "/projects", "/api/v1/auth/session", "/api/v1/records", "/api/v1/schema", "/api/v1/health"]) {
      const response = await call(path, { headers: { ...identity, ...owner } }, true);
      expect(response.status).toBe(404);
      expect(response.headers.get("set-cookie")).toBeNull();
    }
    for (const method of ["POST", "DELETE"]) {
      expect((await call("/api/v1/auth/session", { method, headers: { ...identity, ...owner } }, true)).status).toBe(404);
    }
    expect((await call("/api/v1/records", { method: "POST", headers: { ...identity, ...owner }, body: JSON.stringify(payload()) }, true)).status).toBe(401);
    expect((await call(`/api/v1/records/${record.id}`, { headers: { ...identity, ...owner } }, true)).status).toBe(401);
    const agentHeaders = { ...identity, ...bearer("omo"), "Content-Type": "application/json" };
    const agentCreate = await call("/api/v1/records", { method: "POST", headers: agentHeaders, body: JSON.stringify(payload()) }, true);
    expect(agentCreate.status).toBe(201);
    const agentRecord = recordResult.parse(await agentCreate.json()).record;
    expect(agentRecord.source).toBe("omo");
    expect((await call(`/api/v1/records/${agentRecord.id}`, { headers: agentHeaders }, true)).status).toBe(200);
    expect((await call("/api/v1/auth/session", { method: "DELETE", headers: { Cookie, Origin: privateOrigin } })).status).toBe(403);
    expect((await call("/api/v1/auth/session", { method: "DELETE", headers: owner })).status).toBe(204);
    expect((await call("/api/v1/auth/session", { headers: { Cookie } })).status).toBe(401);
    const manual = await call("/api/v1/auth/session", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ token: tokens.owner }) });
    expect(manual.status).toBe(200);
    expect(manual.headers.get("set-cookie")?.includes("; Secure")).toBe(false);
  } finally {
    await server.stop(true);
    await ingress.stop(true);
    app.close();
    f.close();
  }
});
