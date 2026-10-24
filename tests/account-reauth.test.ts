import { expect, test } from "bun:test";
import { oidcFixture } from "./helpers/oidc-app";

test("signed deletion intent returns to confirmation without deleting the account", async () => {
  // Given: a legitimate sign-in transaction initiated by the deletion UI.
  const f = await oidcFixture();
  try {
    const started = await f.call("/auth/google/start?intent=delete");
    const authorization = await fetch(started.headers.get("location") ?? "", { redirect: "manual" });
    const callback = new URL(authorization.headers.get("location") ?? "");
    // When: the exact signed transaction completes.
    const response = await f.call(callback.pathname + callback.search, { Cookie: started.headers.get("set-cookie")?.split(";")[0] ?? "" });
    // Then: only the confirmation surface is selected, with active data untouched.
    expect(response.headers.get("location")).toBe("/delete-confirm");
    expect((await f.app.sql.all("SELECT id FROM users WHERE deleted_at IS NULL AND id<>'local'")).length).toBe(1);
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
