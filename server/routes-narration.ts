import { Hono } from "hono";
import { z } from "zod";
import { NarrationStyleSchema } from "../shared/contracts";
import { ApiError } from "./errors";
import { json } from "./json-body";
import type { TenantRuntime } from "./app-runtime";

export function registerNarration(app: Hono, runtime: TenantRuntime) {
  const { auth, narration, serveAudio, origins, owner, narratable, cancelBody } = runtime;

      /** Settings › Narration voices: the owner reads and saves the voices and speaking styles of the next narrations, and hears a voice first. */
      /** Settings › Automatic audio: the owner reads and saves which audio is made without asking and what a record's audio reads. */
      app.get("/api/v1/narration/auto", async c => { (await owner(c.req.raw, false)); return c.json((await narration.autoSettings())); });

      app.put("/api/v1/narration/auto", async c => { (await owner(c.req.raw, true)); return c.json((await narration.saveAuto(await json(c.req.raw)))); });

      app.get("/api/v1/narration/voices", async c => { (await owner(c.req.raw, false)); return c.json((await narration.voices())); });

      app.put("/api/v1/narration/voices", async c => { (await owner(c.req.raw, true)); return c.json((await narration.saveVoices(await json(c.req.raw)))); });

      app.get("/api/v1/narration/voices/:voice/preview", async c => { (await owner(c.req.raw, false)); return serveAudio(c, await narration.preview(c.req.param("voice"))); });

      app.get("/api/v1/records/:id/narration", async c => c.json(await narration.state((await narratable(c.req.raw, c.req.param("id"))).record)));

      app.post("/api/v1/records/:id/narration", async c => {
        const { principal, record } = (await narratable(c.req.raw, c.req.param("id")));
        if (principal.source === "manual") (await auth.csrf(c.req.raw, origins));
        const input = z.object({ force: z.boolean().optional(), style: NarrationStyleSchema.optional() }).strict().parse(await json(c.req.raw));
        const result = await narration.request(principal, record, input.force === true, input.style);
        return c.json(result.state, result.started ? 202 : 200);
      });

      app.delete("/api/v1/records/:id/narration", async c => {
        const { principal, record } = (await narratable(c.req.raw, c.req.param("id")));
        if (principal.source !== "manual") throw new ApiError(403, "forbidden", "Owner session required");
        (await auth.csrf(c.req.raw, origins));
        (await narration.remove(record.id));
        return c.body(null, 204);
      });

      app.post("/api/v1/records/:id/narration/cancel", async c => {
        const { principal, record } = (await narratable(c.req.raw, c.req.param("id")));
        if (principal.source !== "manual") throw new ApiError(403, "forbidden", "Owner session required");
        (await auth.csrf(c.req.raw, origins));
        await cancelBody(c.req.raw);
        return c.json(await narration.cancel(record));
      });

      app.get("/api/v1/records/:id/narration/audio", async c => serveAudio(c, (await narration.audioFile((await narratable(c.req.raw, c.req.param("id"))).record.id))));
}
