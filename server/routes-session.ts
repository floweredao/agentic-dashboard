import { Hono } from "hono";
import { z } from "zod";
import { RecordInputSchema, schemaInfo, titleWidth, TITLE_MAX_WIDTH } from "../shared/contracts";

import { enrichCapture } from "./capture-enrichment";
import { ApiError } from "./errors";
import { json } from "./json-body";
import packageJson from "../package.json" with { type: "json" };
import type { TenantRuntime } from "./app-runtime";

const captureSchema = z.object({
  url: z.string().trim().min(1).max(2048).refine(value =>
    /^https?:\/\//i.test(value) && !/[\s\u0000-\u001f\u007f-\u009f]/u.test(value) && URL.canParse(value),
  "Absolute HTTP(S) URL without embedded whitespace or controls required"),
}).strict();
export function registerSession(app: Hono, runtime: TenantRuntime) {
  const { options, store, demo, auth, agents, invites, timeZone, pushOn, digestOn, narration, privateOrigin, trustedOwner, newRecord, origins, cookie, capturing } = runtime;

      app.post("/api/v1/capture", async c => {
        const principal = options.hosted ? await auth.authenticate(c.req.raw, true) : { id: "owner", source: "manual" };
        if (options.hosted) {
          if (!(await agents.get(principal.id))?.capture) throw new ApiError(403, "capture_forbidden", "This agent cannot capture links");
        } else if (!trustedOwner(c, true)) throw new ApiError(401, "unauthenticated", "Trusted owner identity required");
        const marker = c.req.header("X-Capture") ?? c.req.header("X-Floweredao-Capture");
        if (marker !== "shortcut-v1" && !(marker === "v1" && !options.hosted)) throw new ApiError(403, "forbidden", "Capture marker required");
        const origin = c.req.header("origin");
        if (origin !== undefined && origin !== privateOrigin) throw new ApiError(403, "origin", "Private Origin required");
        const input = captureSchema.parse(await json(c.req.raw));
        const url = new URL(input.url);
        if (url.username || url.password || url.href.length > 2048) throw new ApiError(400, "invalid_input", "Invalid capture URL");
        const requestId = `capture:v1:${new Bun.CryptoHasher("sha512").update(url.href).digest("hex")}`;
        const previous = (await store.replay(principal, requestId, { url: url.href }));
        if (previous) return c.json(previous, 200);
        let pending = capturing.get(requestId);
        if (!pending) {
          pending = (options.enrichCapture ?? enrichCapture)(url).finally(() => capturing.delete(requestId));
          capturing.set(requestId, pending);
        }
        const enrichment = await pending;
        let title = enrichment.title;
        if (options.hosted) {
          const characters = [...title];
          while (titleWidth(characters.join("")) > TITLE_MAX_WIDTH) characters.pop();
          title = characters.join("");
        }
        const matches = (domain: string) => url.hostname === domain || url.hostname.endsWith(`.${domain}`);
        const record = RecordInputSchema.parse({
          kind: "social", title,
          ...(options.hosted ? { tags: ["capture"] } : {}),
          fields: options.hosted ? { summary: enrichment.fields.summary || url.href.slice(0, 500) }
            : { ...enrichment.fields, origin: ["x.com", "twitter.com"].some(matches) ? "x" : ["threads.net", "threads.com"].some(matches) ? "threads" : "other" },
          links: [{ label: "Source", url: url.href }],
        });
        const result = (await store.create(principal, requestId, record, { url: url.href }, "pending"));
        if (!result.replayed) (await newRecord(result.record, true));
        return c.json(result, result.replayed ? 200 : 201);
      });

      app.get("/api/health", c => c.json({ status: "ok" }));

      app.get("/api/v1/health", c => c.json({ status: "ok" }));

      app.get("/api/v1/schema", c => c.json({ ...schemaInfo, timeZone }));

      /** What the UI needs before sign-in: name, version, calendar zone, default language and which optional features are on. */
      app.get("/api/v1/config", async c => c.json({
        appName: options.appName ?? "Agentic Dashboard", version: packageJson.version, timeZone, locale: options.locale ?? "en",
        authMode: options.hosted ? "google" : "local",
        features: { narration: options.hosted ? options.narration !== undefined : await narration.available(), push: pushOn, digest: digestOn, trustedLogin: !options.hosted && options.trustedIdentity !== undefined, demo },
      }));

      app.get("/api/v1/agents", async c => {
        if ((await auth.authenticate(c.req.raw, false)).source !== "manual") throw new ApiError(403, "forbidden", "Owner session required");
        return c.json({ items: (await agents.list()) });
      });

      // A one-time connection code issued on the host (agentic-dashboard invite) is the capability; it registers its agent once.
      app.post("/api/v1/agents/connect", async c => {
        const input = z.object({ code: z.string().trim().min(1).max(64) }).strict().parse(await json(c.req.raw));
        return c.json((await invites.redeem(input.code)), 201);
      });

      app.post("/api/v1/auth/session", async c => {
        if (!origins.has(c.req.header("origin") ?? "")) throw new ApiError(403, "origin", "Allowed Origin required");
        const input = z.object({ token: z.string().min(1).max(512) }).strict().parse(await json(c.req.raw));
        const session = (await auth.createSession(input.token));
        const secure = (c.req.header("origin") ?? "").startsWith("https:");
        c.header("Set-Cookie", cookie(session.value, session.expiresAt, secure));
        return c.json({ csrfToken: session.csrfToken, expiresAt: session.expiresAt });
      });

      app.get("/api/v1/auth/session", async c => {
        // The trusted proxy terminates HTTPS and strips client copies of its identity header before the hop to this listener.
        if (c.req.method === "GET" && trustedOwner(c) && !(await auth.findSession(c.req.raw))) {
          const session = (await auth.createOwnerSession());
          c.header("Set-Cookie", cookie(session.value, session.expiresAt, true));
          return c.json({ principal: { id: "owner", source: "manual" },
            csrfToken: session.csrfToken, expiresAt: session.expiresAt });
        }
        const principal = (await auth.authenticate(c.req.raw, false));
        if (principal.source !== "manual") throw new ApiError(403, "forbidden", "Owner session required");
        const session = (await auth.session(c.req.raw));
        return c.json({ principal, csrfToken: session.csrf, expiresAt: new Date(session.expires_at).toISOString() });
      });

      app.delete("/api/v1/auth/session", async c => {
        const principal = (await auth.authenticate(c.req.raw, false));
        if (principal.source !== "manual") throw new ApiError(403, "forbidden", "Owner session required");
        const session = (await auth.csrf(c.req.raw, origins));
        (await store.db.run("DELETE FROM sessions WHERE (hash=?) AND user_id=?", [session.hash]));
        c.header("Set-Cookie", cookie("", new Date(0).toISOString(), (c.req.header("origin") ?? "").startsWith("https:")));
        return c.body(null, 204);
      });
}
