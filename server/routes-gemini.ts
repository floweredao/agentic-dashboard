import type { Hono } from "hono";
import { z } from "zod";
import type { TenantRuntime } from "./app-runtime";
import { ApiError } from "./errors";
import { json } from "./json-body";

export function registerGemini(app: Hono, runtime: TenantRuntime) {
  const keys = () => {
    if (!runtime.options.keyStore) throw new ApiError(404, "feature_disabled", "Personal keys are available in hosted mode.");
    return runtime.options.keyStore;
  };
  app.get("/api/v1/settings/gemini", async c => {
    await runtime.owner(c.req.raw, false);
    return c.json(await keys().status(runtime.store.db.userId));
  });
  app.put("/api/v1/settings/gemini", async c => {
    await runtime.owner(c.req.raw, true);
    const input = z.object({ key: z.string().trim().min(1).max(512) }).strict().parse(await json(c.req.raw));
    return c.json(await keys().save(runtime.store.db.userId, input.key));
  });
  app.delete("/api/v1/settings/gemini", async c => {
    await runtime.owner(c.req.raw, true);
    await keys().remove(runtime.store.db.userId);
    return c.body(null, 204);
  });
}
