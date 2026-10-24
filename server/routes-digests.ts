import { Hono } from "hono";
import { z } from "zod";
import { DIGEST_LIMITS, digestPartId, DigestInputSchema, DigestPartSchema, NarrationStyleSchema } from "../shared/contracts";
import { digestPayload } from "./push";
import { ApiError } from "./errors";
import { json } from "./json-body";
import type { TenantRuntime } from "./app-runtime";

export function registerDigests(app: Hono, runtime: TenantRuntime) {
  const { options, auth, pushOn, digests, narration, push, digestRoute, serveAudio, owner, cancelBody } = runtime;

      /** The owner and every registered agent read digests. */
      const digestReader = async (request: Request) => { digestRoute(); return (await auth.authenticate(request, false)); };

      app.post("/api/v1/digests", async c => {
        digestRoute();
        const principal = (await auth.authenticate(c.req.raw, false));
        if (principal.source === "manual") throw new ApiError(403, "forbidden", "Agents upload digests");
        const input = DigestInputSchema.parse(await json(c.req.raw, DIGEST_LIMITS.bodyBytes));
        const result = (await digests.upsert(principal, input));
        // Automatic digest audio: the audio of what changed is made in the background; the upload does not wait for it.
        const mode = (await narration.autoSettings()).digests;
        if (mode !== "off" && result.changed.length > 0) {
          const parts = mode === "all" ? ["all" as const]
            : [...new Set(result.digest.sections.filter(section => result.changed.includes(section.key)).map(section => section.kind))];
          for (const part of parts) narration.auto(principal, digestPartId(result.digest.id, part), "read");
        }
        const notified = pushOn && input.notify && result.added.length > 0
          && (await push.notify([{ kind: "digest", payload: digestPayload(result.digest, result.added, result.created, options.locale) }])) > 0;
        return c.json({ digest: result.digest, created: result.created, changed: result.changed, notified }, result.created ? 201 : 200);
      });

      app.get("/api/v1/digests", async c => { (await digestReader(c.req.raw)); return c.json((await digests.list(c.req.query()))); });

      app.get("/api/v1/digests/search", async c => { (await digestReader(c.req.raw)); return c.json((await digests.search(c.req.query()))); });

      app.get("/api/v1/digests/reactions", async c => { (await digestReader(c.req.raw)); return c.json((await digests.recentReactions(c.req.query()))); });

      app.get("/api/v1/digests/:id", async c => {
        (await digestReader(c.req.raw));
        const id = c.req.param("id");
        return c.json({ digest: (await digests.get(id)), reactions: (await digests.reactions(id)) });
      });

      /** Like · Not for me · Seen it on one article: owner only, with CSRF. */
      app.put("/api/v1/digests/:id/reactions", async c => {
        (await owner(c.req.raw, true));
        return c.json({ reactions: (await digests.react(c.req.param("id"), await json(c.req.raw))) });
      });

      app.post("/api/v1/digests/:id/read", async c => {
        (await owner(c.req.raw, true));
        const input = z.object({ read: z.boolean(), part: DigestPartSchema.optional() }).strict().parse(await json(c.req.raw));
        return c.json({ digest: (await digests.markRead(c.req.param("id"), input.read, input.part)) });
      });

      /** Narration of one part of a digest (`:id` is the part's id, `digestPartId`): owner only; the same jobs, limits and audio store as record narration. */
      const digestSource = async (request: Request, id: string, mutation: boolean) => {
        (await owner(request, mutation));
        digestRoute();
        const source = (await digests.narrationSource(id));
        if (!source) throw new ApiError(404, "not_found", "Digest not found");
        return source.record;
      };

      app.get("/api/v1/digests/:id/narration", async c => c.json(await narration.state((await digestSource(c.req.raw, c.req.param("id"), false)))));

      app.post("/api/v1/digests/:id/narration", async c => {
        const record = (await digestSource(c.req.raw, c.req.param("id"), true));
        const input = z.object({ force: z.boolean().optional(), style: NarrationStyleSchema.optional() }).strict().parse(await json(c.req.raw));
        if (input.style === "podcast") throw new ApiError(400, "narration_style_unsupported", "Digests are read aloud; the podcast style is for records");
        const result = await narration.request({ id: "owner", source: "manual" }, record, input.force === true, "read");
        return c.json(result.state, result.started ? 202 : 200);
      });

      app.delete("/api/v1/digests/:id/narration", async c => { (await narration.remove((await digestSource(c.req.raw, c.req.param("id"), true)).id)); return c.body(null, 204); });

      app.post("/api/v1/digests/:id/narration/cancel", async c => {
        const record = (await digestSource(c.req.raw, c.req.param("id"), true));
        await cancelBody(c.req.raw);
        return c.json(await narration.cancel(record));
      });

      app.get("/api/v1/digests/:id/narration/audio", async c => serveAudio(c, (await narration.audioFile((await digestSource(c.req.raw, c.req.param("id"), false)).id))));
}
