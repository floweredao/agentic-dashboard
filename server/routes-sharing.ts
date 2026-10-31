import { Hono } from "hono";
import { z } from "zod";
import { PushKindsSchema } from "../shared/contracts";
import { ApiError } from "./errors";
import { json } from "./json-body";
import { projectRecord, renderMarkdown, Shares } from "./share";
import { Store } from "./store";
import { TenantDb } from "./tenant-db";
import type { TenantRuntime } from "./app-runtime";

export function registerSharing(app: Hono, runtime: TenantRuntime) {
  const { options, store, now, auth, timeZone, privateOrigin, shares, push, pushRoute, origins, owner } = runtime;

      app.get("/api/v1/push", async c => {
        pushRoute();
        (await owner(c.req.raw, false));
        const endpoint = z.string().max(2048).optional().parse(c.req.query("endpoint"));
        return c.json({ publicKey: push.publicKey(), device: endpoint ? (await push.device(endpoint)) : null, devices: (await push.count()) });
      });

      app.put("/api/v1/push/subscription", async c => {
        pushRoute();
        (await owner(c.req.raw, true));
        const input = z.object({ subscription: z.unknown(), kinds: PushKindsSchema.optional() }).strict().parse(await json(c.req.raw));
        return c.json({ device: (await push.subscribe(input.subscription, input.kinds)) });
      });

      app.delete("/api/v1/push/subscription", async c => {
        (await owner(c.req.raw, true));
        (await push.unsubscribe(z.object({ endpoint: z.string().max(2048) }).strict().parse(await json(c.req.raw)).endpoint));
        return c.body(null, 204);
      });

      app.post("/api/v1/push/test", async c => {
        pushRoute();
        (await owner(c.req.raw, true));
        return c.json(await push.test(z.object({ endpoint: z.string().max(2048) }).strict().parse(await json(c.req.raw)).endpoint));
      });

      app.get("/api/v1/records/:id/share", async c => {
        if ((await auth.authenticate(c.req.raw, false)).source !== "manual") throw new ApiError(403, "forbidden", "Owner session required");
        const record = (await store.get(c.req.param("id")));
        return c.json({ share: (await shares.get(record.id)) });
      });

      app.post("/api/v1/records/:id/share", async c => {
        if ((await auth.authenticate(c.req.raw, false)).source !== "manual") throw new ApiError(403, "forbidden", "Owner session required");
        (await auth.csrf(c.req.raw, origins));
        const record = (await store.get(c.req.param("id")));
        const result = (await shares.create(record.id));
        return c.json({ share: result.share }, result.created ? 201 : 200);
      });

      app.delete("/api/v1/records/:id/share", async c => {
        if ((await auth.authenticate(c.req.raw, false)).source !== "manual") throw new ApiError(403, "forbidden", "Owner session required");
        (await auth.csrf(c.req.raw, origins));
        (await shares.revoke((await store.get(c.req.param("id"))).id));
        return c.body(null, 204);
      });

      // Possession of the code grants read access to anyone who can reach this listener.
      app.get("/api/v1/shared/:code", async c => {
        const found = (await shares.find(c.req.param("code")));
        if (!found) throw new ApiError(404, "not_found", "Share not found");
        return c.json({ share: found.share, record: projectRecord(found.record) });
      });

      app.get("/s/:code", async c => {
        const found = (await shares.find(c.req.param("code")));
        const previousId = found?.record.fields.previousId;
        const previousTitle = found && typeof previousId === "string"
          ? await new Shares(new Store(new TenantDb(store.db.sql, found.userId), now, store.control), privateOrigin).titleOf(previousId) : null;
        c.header("Content-Type", "text/plain; charset=utf-8");
        c.header("X-Robots-Tag", "noindex");
        return found ? c.body(renderMarkdown(found.record, found.share, () => previousTitle, timeZone, options.locale ?? "en"), 200) : c.body("Share link not found.", 404);
      });
}
