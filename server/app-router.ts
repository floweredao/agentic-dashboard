import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { z } from "zod";
import { hash } from "./auth";
import { ApiError } from "./errors";

import type { TenantRuntime } from "./app-runtime";
import { registerSession } from "./routes-session";
import { registerDigests } from "./routes-digests";
import { registerNarration } from "./routes-narration";
import { registerSharing } from "./routes-sharing";
import { registerRecords } from "./routes-records";
export function createRouter(runtime: TenantRuntime, publicOnly: boolean) {
  const { options, now, demo, auth, origins, hosts, limit, rate } = runtime;

    const app = new Hono();

    app.use("*", async (c, next) => {
      c.header("X-Content-Type-Options", "nosniff");
      c.header("X-Frame-Options", "DENY");
      c.header("Referrer-Policy", "no-referrer");
      // Digest thumbnails load from the publisher's https address (no referrer); the public surface serves no pictures.
      c.header("Content-Security-Policy", `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:${publicOnly ? "" : " https:"}; media-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
      c.header("Cache-Control", "no-store");
      const url = new URL(c.req.url);
      if (!hosts.has(c.req.header("host") ?? url.host)) throw new ApiError(421, "invalid_host", "Host is not allowed");
      if (publicOnly && !((c.req.method === "POST" && url.pathname === "/api/v1/records") ||
        (c.req.method === "GET" && /^\/api\/v1\/records\/[^/]+$/.test(url.pathname)))) {
        throw new ApiError(404, "not_found", "Route not found");
      }
      const origin = c.req.header("origin");
      if (origin !== undefined && !origins.has(origin)) throw new ApiError(403, "origin", "Origin is not allowed");
      const window = Math.floor(now() / 60000);
      if (window !== rate.window) { rate.buckets.clear(); rate.window = window; }
      // Unknown credentials share one bucket; clients cannot grow the map by rotating garbage tokens.
      let rateKey = "anonymous";
      const authorization = c.req.header("authorization");
      if (authorization?.startsWith("Bearer ")) {
        const credentialHash = hash(authorization.slice(7));
        if (await auth.control.principalByToken(credentialHash)) rateKey = credentialHash;
      } else {
        // An owner session counts on its own; a cookie that names no session is an unknown credential like any other.
        const session = await auth.findSession(c.req.raw);
        if (session) rateKey = `session:${session.hash}`;
      }
      const count = (rate.buckets.get(rateKey) ?? 0) + 1;
      rate.buckets.set(rateKey, count);
      if (count > limit) { c.header("Retry-After", "60"); throw new ApiError(429, "rate_limited", "Request limit exceeded"); }
      if (demo && c.req.method !== "GET" && c.req.method !== "HEAD") throw new ApiError(403, "demo_read_only", "This is a read-only demo; changes are turned off");
      await next();
    });

    app.onError((error, c) => {
      if (error instanceof ApiError) return c.json({ error: { code: error.code, message: error.message,
        ...(error.details ? { details: error.details } : {}) } }, error.status);
      if (error instanceof z.ZodError) return c.json({ error: { code: "invalid_input", message: "Input validation failed", details: error.issues } }, 400);
      // Never log request bodies, cookies or credentials at this boundary.
      return c.json({ error: { code: "internal_error", message: "Internal server error" } }, 500);
    });

    if (!publicOnly) { registerSession(app, runtime); registerDigests(app, runtime); registerNarration(app, runtime); registerSharing(app, runtime); }
    registerRecords(app, runtime, publicOnly);
    app.all("/api/*", c => c.json({ error: { code: "not_found", message: "Route not found" } }, 404));

    if (!publicOnly) {
      app.use("*", serveStatic({ root: options.staticRoot ?? "./dist", onFound: (_path, c) => {
        if (/^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.(?:js|css|woff2?|png|jpe?g|svg|webp|avif)$/.test(new URL(c.req.url).pathname))
          c.header("Cache-Control", "public, max-age=31536000, immutable");
      } }));
      app.get("*", serveStatic({ root: options.staticRoot ?? "./dist", path: "index.html" }));
    }

    app.notFound(c => c.json({ error: { code: "not_found", message: "Route not found" } }, 404));

    return app;
}
