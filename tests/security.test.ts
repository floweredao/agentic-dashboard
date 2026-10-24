import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { fixture, tokens } from "./backend-helper";

test("a cookie that names no session shares the unknown bucket, not the signed-in owner's", async () => {
  // Given: a limit of three requests a minute and a signed-in owner.
  const at = Date.parse("2026-10-24T09:00:10Z");
  const f = fixture(3, () => at);
  try {
    const owner = await f.login();
    // When: a client without credentials sends a made-up session cookie until it is refused.
    const garbage = { Cookie: "agentic_session=not-a-session" };
    const statuses = [];
    for (let index = 0; index < 3; index++) statuses.push((await f.call("/api/v1/health", "GET", undefined, garbage)).status);
    expect(statuses).toEqual([200, 200, 429]);
    // Then: the owner's own session still has its whole allowance, and no more.
    const own = [];
    for (let index = 0; index < 4; index++) own.push((await f.call("/api/v1/auth/session", "GET", undefined, owner)).status);
    expect(own).toEqual([200, 200, 200, 429]);
  } finally { f.close(); }
});

test("replacing the owner key ends the sessions the old key opened", async () => {
  // Given: an owner session opened with the current key.
  const f = fixture();
  try {
    const old = await f.login();
    f.restart();
    expect((await f.call("/api/v1/auth/session", "GET", undefined, old)).status).toBe(200);
    // When: the owner puts a new key in credentials.json and restarts the server.
    writeFileSync(f.options.credentialsPath, JSON.stringify({ owner: "owner-rotated-test-secret" }), { mode: 0o600 });
    f.restart();
    // Then: the old session is refused, and the new key signs in.
    expect((await f.call("/api/v1/auth/session", "GET", undefined, old)).status).toBe(401);
    expect((await f.call("/api/v1/auth/session", "POST", { token: tokens.owner }, { Origin: old.Origin })).status).toBe(401);
    expect((await f.call("/api/v1/auth/session", "POST", { token: "owner-rotated-test-secret" }, { Origin: old.Origin })).status).toBe(200);
  } finally { f.close(); }
});
