import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createApp } from "../server/app";
import { mockOidc } from "./helpers/mock-oidc";

const origin = "http://127.0.0.1:4390";
async function fixture(maxUsers = 50) {
  let now = Date.parse("2026-10-24T12:00:00Z");
  const issuer = await mockOidc(() => now);
  const directory = mkdtempSync(join(tmpdir(), "oidc-"));
  const app = await createApp({
    databasePath: ":memory:", credentialsPath: join(directory, "credentials.json"), privateOrigin: origin, port: 4390, pushEnabled: false,
    now: () => now, hosted: {
      sessionSigningKey: crypto.randomUUID() + crypto.randomUUID(), google: { clientId: "test-client", clientSecret: crypto.randomUUID() },
      maxUsers, endpoints: issuer.endpoints,
    },
  });
  const call = (path: string, headers: HeadersInit = {}) => app.fetch(new Request(`${origin}${path}`, { headers }));
  async function start() {
    const response = await call("/auth/google/start");
    expect(response.status).toBe(302);
    const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
    const authorize = await fetch(response.headers.get("location") ?? "", { redirect: "manual" });
    return { cookie, callback: new URL(authorize.headers.get("location") ?? "") };
  }
  const finish = (flow: Awaited<ReturnType<typeof start>>) => call(flow.callback.pathname + flow.callback.search, { Cookie: flow.cookie });
  return { app, issuer, call, start, finish, advance(ms: number) { now += ms; },
    async close() { await app.close(); issuer.close(); rmSync(directory, { recursive: true, force: true }); } };
}

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
