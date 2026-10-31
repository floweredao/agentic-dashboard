import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { SESSION_COOKIE } from "../server/auth";
import { captureFallback } from "../server/capture-enrichment";
import { fixture } from "./backend-helper";

test.each(["local", "b"])("trusted capture identity only authorizes local, with %s cookie", async userId => {
  // Given: the real HTTP surface, valid owner cookies, and an explicit trusted proxy.
  const privateOrigin = "https://capture.example.test";
  let enrichments = 0;
  const f = await fixture(10000, Date.now, {
    privateOrigin, trustedIdentity: { header: "X-Owner", login: "owner@example.test" },
    enrichCapture: async url => { enrichments++; return captureFallback(url); },
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: f.app.fetch });
  try {
    const scope = await f.app.tenant(userId);
    if (userId !== "local") await scope.auth.initialize(join(f.dir, "other-credentials.json"));
    const session = await scope.auth.createOwnerSession();
    // When: the trusted local-owner header accompanies the selected account's cookie.
    const response = await fetch(`http://127.0.0.1:${server.port}/api/v1/capture`, {
      method: "POST", headers: { Host: "capture.example.test", "X-Owner": "owner@example.test", "X-Capture": "v1",
        Cookie: `${SESSION_COOKIE}=${session.value}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.test/capture" }), signal: AbortSignal.timeout(5000),
    });
    // Then: only local capture reaches enrichment and persistence.
    expect(response.status).toBe(userId === "local" ? 201 : 401);
    expect(enrichments).toBe(userId === "local" ? 1 : 0);
    expect((await scope.store.list({})).items.length).toBe(userId === "local" ? 1 : 0);
  } finally { await server.stop(true); await f.close(); }
});

test("retries tenant construction after a real initialization failure", async () => {
  // Given: a tenant whose startup purge fails, with concurrent callers sharing that attempt.
  const f = await fixture();
  try {
    await f.app.sql.run("INSERT INTO principals(id,source,token_hash,user_id) VALUES('owner','manual','b-test-hash','b')");
    await f.app.sql.run("INSERT INTO trash(id,data,created_by,deleted_at,user_id) VALUES('old','{}','owner','2000-01-01','b')");
    await f.app.sql.run("CREATE TRIGGER fail_tenant BEFORE DELETE ON trash WHEN OLD.user_id='b' BEGIN SELECT RAISE(ABORT,'tenant init failure'); END");
    const first = f.app.tenant("b");
    const concurrent = f.app.tenant("b");
    expect(concurrent).toBe(first);
    await expect(first).rejects.toThrow("tenant init failure");
    await expect(concurrent).rejects.toThrow("tenant init failure");
    await f.app.sql.run("DROP TRIGGER fail_tenant");
    // When: the underlying failure is gone and another request asks for the same tenant.
    const recovered = await f.app.tenant("b");
    // Then: the new graph is usable and becomes the cached graph.
    expect((await recovered.store.list({})).items).toEqual([]);
    expect(await f.app.tenant("b")).toBe(recovered);
  } finally {
    try { await f.close(); }
    catch (error) { await f.app.sql.close(); rmSync(f.dir, { recursive: true, force: true }); throw error; }
  }
});
