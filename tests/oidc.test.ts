import { expect, test } from "bun:test";
import { z } from "zod";
import { oidcFixture as fixture, oidcOrigin as origin } from "./helpers/oidc-app";

test("Google callback creates a personal user and a thirty-day session when PKCE and claims agree", async () => {
  const f = await fixture();
  try {
    // Given a fresh transaction against the real local issuer.
    const flow = await f.start();
    // When the browser returns with the bound authorization code.
    const response = await f.finish(flow);
    // Then it receives an account session and never a provider token.
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/welcome");
    const cookie = response.headers.getSetCookie().find(value => value.startsWith("session=")) ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    const session = await f.call("/api/v1/auth/session", { Cookie: cookie.split(";")[0] ?? "" });
    expect(session.status).toBe(200);
    expect(z.object({ email: z.string() }).parse(await f.app.sql.get("SELECT email FROM users WHERE google_sub=?", ["mock-subject"]))).toEqual({ email: "reader@example.test" });
  } finally { await f.close(); }
});

for (const [name, claims, status] of [
  ["wrong nonce", { nonce: "wrong" }, 400],
  ["wrong audience", { aud: "other" }, 400],
  ["wrong authorized party", { azp: "other" }, 400],
  ["expired token", { exp: 0 }, 400],
  ["future issued token", { iat: 9999999999 }, 400],
  ["wrong issuer", { iss: "https://evil.example" }, 400],
  ["unverified email", { email_verified: false }, 403],
  ["string verification flag", { email_verified: "true" }, 400],
] as const) {
  test(`callback refuses ${name} without creating a session`, async () => {
    const f = await fixture();
    try {
      const flow = await f.start();
      f.issuer.state.claims = claims;
      const response = await f.finish(flow);
      expect(response.status).toBe(status);
      expect(await f.app.sql.all("SELECT hash FROM sessions")).toEqual([]);
    } finally { await f.close(); }
  });
}

test("callback rejects forged state, duplicate parameters, and absent transactions", async () => {
  const f = await fixture();
  try {
    const flow = await f.start();
    flow.callback.searchParams.set("state", "forged");
    expect((await f.finish(flow)).status).toBe(400);
    expect((await f.call("/auth/google/callback?code=x&state=y&state=z", { Cookie: flow.cookie })).status).toBe(400);
    expect((await f.call("/auth/google/callback?code=x&state=y")).status).toBe(400);
  } finally { await f.close(); }
});

test("callback refuses a bad signature and consumes the transaction once", async () => {
  const f = await fixture();
  try {
    const flow = await f.start();
    f.issuer.state.badSignature = true;
    expect((await f.finish(flow)).status).toBe(400);
    f.issuer.state.badSignature = false;
    expect((await f.finish(flow)).status).toBe(400);
    expect(await f.app.sql.all("SELECT hash FROM sessions")).toEqual([]);
  } finally { await f.close(); }
});

test("replaying a valid callback cannot mint a second session", async () => {
  const f = await fixture();
  try {
    const flow = await f.start();
    expect((await f.finish(flow)).status).toBe(302);
    expect((await f.finish(flow)).status).toBe(400);
    expect(await f.app.sql.all("SELECT hash FROM sessions")).toHaveLength(1);
  } finally { await f.close(); }
});

test("capacity includes active hosted users but not local owner and still permits returning users", async () => {
  const f = await fixture(1);
  try {
    expect((await f.finish(await f.start())).status).toBe(302);
    expect((await f.finish(await f.start())).status).toBe(302);
    f.issuer.state.claims = { sub: "another-subject" };
    const full = await f.finish(await f.start());
    expect(full.status).toBe(403);
    expect(full.headers.get("content-type")).toContain("text/html");
    expect(await f.app.sql.all("SELECT id FROM users WHERE id<>'local'")).toHaveLength(1);
  } finally { await f.close(); }
});

test("equal emails never merge subjects and deleted users never regain old identity", async () => {
  const f = await fixture();
  try {
    await f.finish(await f.start());
    const old = z.object({ id: z.string() }).parse(await f.app.sql.get("SELECT id FROM users WHERE google_sub=?", ["mock-subject"]));
    await f.app.sql.run("UPDATE users SET deleted_at=? WHERE id=?", ["2026-10-24", old.id]);
    await f.finish(await f.start());
    const fresh = z.object({ id: z.string() }).parse(await f.app.sql.get("SELECT id FROM users WHERE google_sub=?", ["mock-subject"]));
    expect(fresh.id).not.toBe(old.id);
    f.issuer.state.claims = { sub: "other-subject" };
    await f.finish(await f.start());
    expect(await f.app.sql.all("SELECT id FROM users WHERE email=? AND deleted_at IS NULL", ["reader@example.test"])).toHaveLength(2);
  } finally { await f.close(); }
});

test("hosted mode refuses owner-key and trusted-header bootstrap", async () => {
  const f = await fixture();
  try {
    const response = await f.app.fetch(new Request(`${origin}/api/v1/auth/session`, { method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ token: "not-a-hosted-credential" }) }));
    expect(response.status).toBe(403);
    expect((await f.call("/api/v1/auth/session", { "Tailscale-User-Login": "owner@example.test" })).status).toBe(401);
  } finally { await f.close(); }
});

test("auth attempts share the last trusted hop despite spoofed leading values", async () => {
  const f = await fixture(50, origin, true);
  try {
    // Given an exhausted minute for one client behind the proxy.
    for (let i = 0; i < 20; i++) await f.call("/auth/google/start", { "X-Forwarded-For": `192.0.2.${i}, 198.51.100.1` });
    // When the same client spoofs a different leading hop.
    const rejected = await f.call("/auth/google/start", { "X-Forwarded-For": "192.0.2.99, 198.51.100.1" });
    // Then it is limited while another client can sign in.
    expect(rejected.status).toBe(429);
    expect((await f.call("/auth/google/start", { "X-Forwarded-For": "192.0.2.4, 198.51.100.2" })).status).toBe(302);
    f.advance(60000);
    expect((await f.call("/auth/google/start", { "X-Forwarded-For": "192.0.2.1, 198.51.100.1" })).status).toBe(302);
  } finally { await f.close(); }
});

test("expired transactions never reach token exchange", async () => {
  const f = await fixture();
  try {
    const flow = await f.start();
    f.advance(600001);
    expect((await f.finish(flow)).status).toBe(400);
    expect(await f.app.sql.all("SELECT hash FROM sessions")).toEqual([]);
  } finally { await f.close(); }
});

test("reauthentication rotates browser credentials and logout requires CSRF", async () => {
  const f = await fixture();
  try {
    const first = await f.finish(await f.start());
    const old = first.headers.getSetCookie().find(value => value.startsWith("session="))?.split(";")[0] ?? "";
    const flow = await f.start();
    const second = await f.finish({ ...flow, cookie: `${flow.cookie}; ${old}` });
    const current = second.headers.getSetCookie().find(value => value.startsWith("session="))?.split(";")[0] ?? "";
    expect((await f.call("/api/v1/auth/session", { Cookie: old })).status).toBe(401);
    const session = z.object({ csrfToken: z.string() }).parse(await (await f.call("/api/v1/auth/session", { Cookie: current })).json());
    const logout = (csrf: string) => f.app.fetch(new Request(`${origin}/auth/logout`, { method: "POST",
      headers: { Cookie: current, Origin: origin, "X-CSRF-Token": csrf } }));
    expect((await logout("forged")).status).toBe(403);
    expect((await logout(session.csrfToken)).status).toBe(204);
    expect((await f.call("/api/v1/auth/session", { Cookie: current })).status).toBe(401);
  } finally { await f.close(); }
});

test("JWKS rotation refreshes an unknown key and known keys survive a provider outage", async () => {
  const f = await fixture();
  try {
    await f.finish(await f.start());
    f.advance(30001);
    await f.issuer.rotate();
    expect((await f.finish(await f.start())).status).toBe(302);
    f.advance(300001);
    f.issuer.state.jwksStatus = 503;
    expect((await f.finish(await f.start())).status).toBe(302);
    await f.issuer.rotate();
    expect((await f.finish(await f.start())).status).toBe(503);
  } finally { await f.close(); }
});

for (const header of [{ alg: "none" }, { jku: "https://evil.example/jwks" }, { x5u: "https://evil.example/cert" }, { jwk: {} }]) {
  test(`token headers cannot choose their own verification mechanism: ${Object.keys(header)[0]}`, async () => {
    const f = await fixture();
    try {
      f.issuer.state.header = header;
      expect((await f.finish(await f.start())).status).toBe(400);
      expect(await f.app.sql.all("SELECT hash FROM sessions")).toEqual([]);
    } finally { await f.close(); }
  });
}

test("unknown signing keys cannot force repeated refreshes during an expired-cache outage", async () => {
  const f = await fixture();
  try {
    await f.finish(await f.start());
    f.advance(300001);
    f.issuer.state.jwksStatus = 503;
    f.issuer.state.header = { kid: "unknown" };
    expect((await f.finish(await f.start())).status).toBe(503);
    const fetched = f.issuer.state.jwksCalls;
    expect((await f.finish(await f.start())).status).toBe(400);
    expect(f.issuer.state.jwksCalls).toBe(fetched);
  } finally { await f.close(); }
});

test("configured HTTPS alone selects a secure host session cookie", async () => {
  const f = await fixture(50, "https://dashboard.example.test");
  try {
    const flow = await f.start();
    const response = await f.call(flow.callback.pathname + flow.callback.search, { Cookie: flow.cookie, "X-Forwarded-Proto": "http" });
    const cookie = response.headers.getSetCookie().find(value => value.startsWith("__Host-session="));
    expect(cookie).toBeDefined();
    expect(cookie).toContain("; Secure");
    expect(cookie).toContain("; Path=/");
    expect(cookie).not.toContain("Domain=");
  } finally { await f.close(); }
});
