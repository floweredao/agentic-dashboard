import { expect, test } from "bun:test";
import { z } from "zod";
import { oidcFixture, oidcOrigin } from "./helpers/oidc-app";

test("signed deletion intent returns to confirmation without deleting the account", async () => {
  // Given: a legitimate sign-in transaction initiated by the deletion UI.
  const f = await oidcFixture();
  try {
    const started = await f.call("/auth/google/start?intent=delete");
    const request = new URL(started.headers.get("location") ?? "");
    expect(request.searchParams.get("prompt")).toBe("login");
    expect(request.searchParams.get("max_age")).toBe("0");
    expect(JSON.parse(request.searchParams.get("claims") ?? "{}")).toEqual({ id_token: { auth_time: { essential: true } } });
    const authorization = await fetch(started.headers.get("location") ?? "", { redirect: "manual" });
    const callback = new URL(authorization.headers.get("location") ?? "");
    // When: the exact signed transaction completes.
    const response = await f.call(callback.pathname + callback.search, { Cookie: started.headers.get("set-cookie")?.split(";")[0] ?? "" });
    // Then: only the confirmation surface is selected, with active data untouched.
    expect(response.headers.get("location")).toBe("/delete-confirm");
    expect((await f.app.sql.all("SELECT id FROM users WHERE deleted_at IS NULL AND id<>'local'")).length).toBe(1);
    expect(z.array(z.object({ authenticated_at: z.number() })).parse(
      await f.app.sql.all("SELECT authenticated_at FROM sessions WHERE user_id<>'local'")))
      .toEqual([{ authenticated_at: Date.parse("2026-10-24T12:00:00Z") }]);
  } finally { await f.close(); }
});

test.each([
  ["missing", undefined],
  ["older than the deletion window", Date.parse("2026-10-24T11:49:59Z") / 1000],
  ["before the requested login", Date.parse("2026-10-24T11:58:59Z") / 1000],
  ["in the future", Date.parse("2026-10-24T12:01:01Z") / 1000],
] as const)("deletion reauthentication refuses an auth_time %s", async (_label, authTime) => {
  const f = await oidcFixture();
  try {
    f.issuer.state.claims = { auth_time: authTime };
    const started = await f.call("/auth/google/start?intent=delete");
    const authorization = await fetch(started.headers.get("location") ?? "", { redirect: "manual" });
    const callback = new URL(authorization.headers.get("location") ?? "");
    const response = await f.call(callback.pathname + callback.search,
      { Cookie: started.headers.get("set-cookie")?.split(";")[0] ?? "" });
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await f.app.sql.all("SELECT id FROM users WHERE id<>'local'")).toEqual([]);
  } finally { await f.close(); }
});

test("a newly issued ordinary SSO session does not bypass deletion reauthentication", async () => {
  const f = await oidcFixture();
  try {
    const response = await f.finish(await f.start());
    const cookie = response.headers.getSetCookie().filter(value => !value.startsWith("oidc_tx="))
      .map(value => value.split(";")[0]).join("; ");
    const session = z.object({ csrfToken: z.string() }).parse(
      await (await f.call("/api/v1/auth/session", { Cookie: cookie })).json());
    const deleted = await f.app.fetch(new Request(`${oidcOrigin}/api/v1/account`, {
      method: "DELETE", headers: { Cookie: cookie, Origin: oidcOrigin, "X-CSRF-Token": session.csrfToken, "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "reader@example.test" }),
    }));
    expect(deleted.status).toBe(403);
    expect(await deleted.json()).toMatchObject({ error: { code: "reauth_required" } });
  } finally { await f.close(); }
});

test("an untrusted callback query cannot introduce a deletion destination", async () => {
  // Given: an ordinary signed transaction.
  const f = await oidcFixture();
  try {
    const flow = await f.start();
    flow.callback.searchParams.set("intent", "delete");
    // When: an extra callback parameter is supplied.
    const response = await f.finish(flow);
    // Then: it cannot replace the state-bound destination.
    expect(response.headers.get("location")).toBe("/welcome");
  } finally { await f.close(); }
});
