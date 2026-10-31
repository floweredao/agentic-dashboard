import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp, type AppOptions } from "../../server/app";
import { ControlDb } from "../../server/control-db";
import { secret } from "../../server/agents";

export const hostedOrigin = "http://127.0.0.1:4390";
export async function hostedFixture(extra: AppOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), "hosted-test-"));
  const app = await createApp({
    databasePath: ":memory:", privateOrigin: hostedOrigin, port: 4390, credentialsPath: join(directory, "credentials.json"),
    pushEnabled: false, rateLimit: 10000,
    hosted: { google: { clientId: "test-client", clientSecret: secret() }, sessionSigningKey: secret(), maxUsers: 50 },
    enrichCapture: async () => ({ title: "A captured article", fields: { summary: "A useful source",
      captureEnrichment: { status: "available", source: "page" } } }), ...extra,
    narration: { provider: null, audioDir: join(directory, "audio"), encode: async path => ({ path, mime: "audio/wav" }), ...extra.narration },
  });
  async function account(id: string) {
    await new ControlDb(app.sql).createUser(id, new Date().toISOString());
    const scope = await app.tenant(id);
    await app.sql.run("INSERT INTO principals(id,source,token_hash,user_id) VALUES('owner','manual',?,?)", [`owner:${crypto.randomUUID()}`, id]);
    const session = await scope.auth.createOwnerSession();
    const headers = { Cookie: `session=${session.value}`, Origin: hostedOrigin, "X-CSRF-Token": session.csrfToken };
    return { scope, headers };
  }
  const a = await account("a");
  const b = await account("b");
  const call = (path: string, options: { method?: string; body?: unknown; headers?: HeadersInit } = {}) =>
    app.fetch(new Request(`${hostedOrigin}${path}`, { method: options.method ?? "GET",
      headers: { "Content-Type": "application/json", ...Object.fromEntries(new Headers(options.headers ?? a.headers)) },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) }));
  return { app, a, b, call, async close() { await app.close(); rmSync(directory, { recursive: true, force: true }); } };
}
