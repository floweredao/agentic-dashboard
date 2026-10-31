import type { Hono } from "hono";
import { z } from "zod";
import { AccountPreferencesSchema } from "../shared/account";
import type { TenantRuntime } from "./app-runtime";
import { json } from "./json-body";
import { ApiError } from "./errors";

export function registerAccount(app: Hono, runtime: TenantRuntime) {
  const { owner, account, auth, privateUrl, options } = runtime;
  app.get("/api/v1/account", async c => { await owner(c.req.raw, false); return c.json({ account: await account.profile() }); });
  app.patch("/api/v1/account/preferences", async c => {
    await owner(c.req.raw, true);
    return c.json({ account: await account.preferences(AccountPreferencesSchema.parse(await json(c.req.raw))) });
  });
  app.post("/api/v1/onboarding/done", async c => {
    await owner(c.req.raw, true);
    return c.json({ account: await account.complete() });
  });
  app.get("/api/v1/account/export", async c => {
    await owner(c.req.raw, false);
    c.header("X-RateLimit-Scope", "export");
    try { return await account.export(c.req.raw.signal); }
    catch (error) {
      if (error instanceof ApiError && error.status === 429) c.header("Retry-After", "60");
      throw error;
    }
  });
  app.delete("/api/v1/account", async c => {
    await owner(c.req.raw, true);
    if (!options.hosted) throw new ApiError(404, "account_deletion_unavailable", "Account deletion requires hosted mode");
    const input = z.object({ confirm: z.string().max(320) }).strict().parse(await json(c.req.raw));
    const session = await auth.session(c.req.raw);
    await account.remove(input.confirm, session.authenticated_at);
    c.header("Set-Cookie", auth.cookie("", new Date(0).toISOString(), privateUrl.protocol === "https:"));
    return c.body(null, 204);
  });
}
