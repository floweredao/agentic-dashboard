import { expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../server/app";
import { mockOidc } from "./mock-oidc";

export const oidcOrigin = "http://127.0.0.1:4390";
export async function oidcFixture(maxUsers = 50, appOrigin = oidcOrigin, trustedAuthProxy = false) {
  let now = Date.parse("2026-10-24T12:00:00Z");
  const issuer = await mockOidc(() => now);
  const directory = mkdtempSync(join(tmpdir(), "oidc-"));
  const app = await createApp({
    databasePath: ":memory:", credentialsPath: join(directory, "credentials.json"), privateOrigin: appOrigin, port: 4390, pushEnabled: false,
    trustedAuthProxy, now: () => now, hosted: {
      sessionSigningKey: crypto.randomUUID() + crypto.randomUUID(), google: { clientId: "test-client", clientSecret: crypto.randomUUID() },
      maxUsers, endpoints: issuer.endpoints,
    },
  });
  const call = (path: string, headers: HeadersInit = {}) => app.fetch(new Request(`${appOrigin}${path}`, { headers }));
  async function start(headers: HeadersInit = {}) {
    const response = await call("/auth/google/start", headers);
    expect(response.status).toBe(302);
    const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
    const authorize = await fetch(response.headers.get("location") ?? "", { redirect: "manual" });
    return { cookie, callback: new URL(authorize.headers.get("location") ?? "") };
  }
  const finish = (flow: Awaited<ReturnType<typeof start>>) => call(flow.callback.pathname + flow.callback.search, { Cookie: flow.cookie });
  return { app, issuer, call, start, finish, advance(ms: number) { now += ms; },
    async close() { await app.close(); issuer.close(); rmSync(directory, { recursive: true, force: true }); } };
}
