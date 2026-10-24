import { expect, test } from "bun:test";
import { SESSION_COOKIE } from "../server/auth";
import { fixture } from "./backend-helper";

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
