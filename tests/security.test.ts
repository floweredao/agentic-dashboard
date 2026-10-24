import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SESSION_COOKIE } from "../server/auth";
import { fixture, tokens } from "./backend-helper";

test("a cookie that names no session shares the unknown bucket, not the signed-in owner's", async () => {
  // Given: a limit of three requests a minute and a signed-in owner.
  const at = Date.parse("2026-10-24T09:00:10Z");
  const f = await fixture(3, () => at);
  try {
    const owner = await f.login();
    // When: a client without credentials sends a made-up session cookie until it is refused.
    const garbage = { Cookie: `${SESSION_COOKIE}=not-a-session` };
    const statuses = [];
    for (let index = 0; index < 3; index++) statuses.push((await f.call("/api/v1/health", "GET", undefined, garbage)).status);
    expect(statuses).toEqual([200, 200, 429]);
    // Then: the owner's own session still has its whole allowance, and no more.
    const own = [];
    for (let index = 0; index < 4; index++) own.push((await f.call("/api/v1/auth/session", "GET", undefined, owner)).status);
    expect(own).toEqual([200, 200, 200, 429]);
  } finally { await f.close(); }
});

test("replacing the owner key ends the sessions the old key opened", async () => {
  // Given: an owner session opened with the current key, and another account's owner session.
  const f = await fixture();
  try {
    const old = await f.login();
    const other = await f.app.tenant("b");
    await other.auth.initialize(join(f.dir, "other-credentials.json"));
    const otherCookie = { Cookie: `${SESSION_COOKIE}=${(await other.auth.createOwnerSession()).value}` };
    await f.restart();
    expect((await f.call("/api/v1/auth/session", "GET", undefined, old)).status).toBe(200);
    // When: the owner puts a new key in credentials.json and restarts the server.
    writeFileSync(f.options.credentialsPath, JSON.stringify({ owner: "owner-rotated-test-secret" }), { mode: 0o600 });
    await f.restart();
    // Then: the old session is refused, the new key signs in, and the other account keeps its session.
    expect((await f.call("/api/v1/auth/session", "GET", undefined, old)).status).toBe(401);
    expect((await f.call("/api/v1/auth/session", "POST", { token: tokens.owner }, { Origin: old.Origin })).status).toBe(401);
    expect((await f.call("/api/v1/auth/session", "POST", { token: "owner-rotated-test-secret" }, { Origin: old.Origin })).status).toBe(200);
    expect((await f.call("/api/v1/auth/session", "GET", undefined, otherCookie)).status).toBe(200);
  } finally { await f.close(); }
});
