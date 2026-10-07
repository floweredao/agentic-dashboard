import { dirname, join } from "node:path";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { z } from "zod";
import type { Context } from "hono";
import { CommentInputSchema, DIGEST_LIMITS, DigestInputSchema, DigestPartSchema, DOCUMENT_LIMITS, DocumentInputSchema, NARRATABLE_KINDS, NarrationStyleSchema, PushKindsSchema, RECORD_LIMITS, RecordInputSchema, RecordPatchSchema, schemaInfo } from "../shared/contracts";
import type { Comment, DashboardRecord, PushPayload } from "../shared/contracts";
import { createAiFill, type AiFillOptions } from "./ai-fill";
import { systemTimeZone } from "../shared/time";
import { Agents } from "./agents";
import { Auth, hash, SESSION_COOKIE } from "./auth";
import { Digests } from "./digests";
import { digestPayload, createPush, replyPayload, reviewPayload, type PushOptions } from "./push";
import { Comments } from "./comments";
import { enrichCapture, type CaptureEnrichment } from "./capture-enrichment";
import { ApiError } from "./errors";
import { json } from "./json-body";
import { createMcpHandler } from "./mcp";
import { createNarration, type NarrationOptions } from "./narration";
import { projectRecord, renderMarkdown, Shares } from "./share";
import { agentCanRead, agentView, Store } from "./store";
// Bundled at build time (bun build --compile, the Docker image and vite all read package.json), so it is the one version source.
import packageJson from "../package.json" with { type: "json" };

export interface AppOptions {
  readonly databasePath?: string;
  readonly credentialsPath?: string;
  /** The origin browsers open the dashboard at (APP_ORIGIN), for example https://dashboard.example.com. */
  readonly privateOrigin?: string;
  /** The private listener's port; its loopback origins are always allowed. */
  readonly port?: number;
  readonly agentPort?: number;
  /**
   * Optional single sign-on behind an identity-aware reverse proxy (for example Tailscale Serve's Tailscale-User-Login):
   * a request over the HTTPS APP_ORIGIN whose `header` equals `login` gets an owner session without a key. Only enable it
   * when the proxy strips that header from client requests and the listener is reachable through the proxy alone.
   */
  readonly trustedIdentity?: { readonly header: string; readonly login: string };
  readonly publicApiBaseUrl?: string;
  readonly appName?: string;
  /** IANA zone for calendar days (Today, digests, daily narration limit); defaults to the host's zone. */
  readonly timeZone?: string;
  /** UI language when the browser does not pick one. */
  readonly locale?: "en" | "ko";
  /** Web push on (default) or off. */
  readonly pushEnabled?: boolean;
  /** Digest collection on (default) or off. */
  readonly digestEnabled?: boolean;
  /** The registered agent every MCP call is attributed to; MCP stays unavailable without one. */
  readonly mcpAgent?: string;
  /**
   * Public read-only demo: every browser reads as the owner without a key, and every request other than GET or HEAD
   * answers 403 demo_read_only, whoever sends it. Never point it at real data.
   */
  readonly demo?: boolean;
  readonly rateLimit?: number;
  readonly now?: () => number;
  readonly staticRoot?: string;
  readonly enrichCapture?: (url: URL) => Promise<CaptureEnrichment>;
  readonly mcpPort?: number;
  /** Off unless supplied: fills placeholder titles and summaries of captured links (and of records from `sources`) in the background. */
  readonly aiFill?: Omit<AiFillOptions, "store">;
  /** Without it narration is unavailable (GET answers available:false, POST 503). audioDir defaults to `audio` beside the database. */
  readonly narration?: Omit<NarrationOptions, "store" | "audioDir" | "lookup"> & { readonly audioDir?: string };
  /** The VAPID key pair for Web Push (created on first need, mode 0600); defaults to `vapid.json` beside the credentials. */
  readonly vapidPath?: string;
  /** Test seams for Web Push; `subject` defaults to the private origin when it is HTTPS. */
  readonly push?: Partial<Omit<PushOptions, "vapidPath">>;
}

const createSchema = z.object({ requestId: z.string().trim().min(1).max(128), record: z.unknown() }).strict();
const captureSchema = z.object({
  url: z.string().trim().min(1).max(2048).refine(value =>
    /^https?:\/\//i.test(value) && !/[\s\u0000-\u001f\u007f-\u009f]/u.test(value) && URL.canParse(value),
  "Absolute HTTP(S) URL without embedded whitespace or controls required"),
}).strict();
export function createApp(options: AppOptions = {}) {
  const now = options.now ?? Date.now;
  const store = new Store(options.databasePath ?? "data/dashboard.sqlite", now);
  const demo = options.demo === true;
  const auth = new Auth(store, options.credentialsPath ?? "data/credentials.json", demo);
  const agents = new Agents(store);
  const timeZone = options.timeZone ?? systemTimeZone();
  const pushOn = options.pushEnabled !== false;
  const digestOn = options.digestEnabled !== false;
  const aiFillSources = new Set(options.aiFill?.sources ?? []);
  const comments = new Comments(store);
  const digests = new Digests(store, timeZone);
  const capturing = new Map<string, Promise<CaptureEnrichment>>();
  const aiFill = options.aiFill ? createAiFill({ store, ...options.aiFill }) : null;
  aiFill?.sweep();
  const narration = createNarration({ provider: null, ...options.narration, store,
    timeZone,
    audioDir: options.narration?.audioDir ?? join(dirname(options.databasePath ?? "data/dashboard.sqlite"), "audio"),
    lookup: id => {
      const source = digests.narrationSource(id);
      return source ? { ...source, audioBase: `/api/v1/digests/${id}` } : null;
    } });
  store.purgeTrash();
  narration.prune();
  narration.resume();
  const port = options.port ?? 4310;
  const privateOrigin = options.privateOrigin ?? `http://127.0.0.1:${port}`;
  const privateUrl = new URL(privateOrigin);
  const shares = new Shares(store, privateOrigin, timeZone);
  const push = createPush(store, {
    vapidPath: options.vapidPath ?? join(dirname(options.credentialsPath ?? "data/credentials.json"), "vapid.json"),
    subject: privateUrl.protocol === "https:" ? privateOrigin : "mailto:admin@localhost",
    locale: options.locale ?? "en",
    ...options.push,
  });
  const pushRoute = () => { if (!pushOn) throw new ApiError(404, "feature_disabled", "Web push is turned off on this dashboard"); };
  const digestRoute = () => { if (!digestOn) throw new ApiError(404, "feature_disabled", "Digests are turned off on this dashboard"); };
  /**
   * The owner signed in through the trusted proxy: right header value, over the configured HTTPS origin, without a key.
   * `strictHost` demands the Host header itself instead of falling back to the request URL (capture does).
   */
  const trustedOwner = (c: Context, strictHost = false) => {
    const trusted = options.trustedIdentity;
    const host = strictHost ? c.req.header("host") : c.req.header("host") ?? new URL(c.req.url).host;
    return trusted !== undefined && trusted.login !== "" && !c.req.raw.headers.has("authorization") && privateUrl.protocol === "https:" &&
      host === privateUrl.host && c.req.header(trusted.header) === trusted.login;
  };
  /** An agent's timeline entry: a reply to an owner comment notifies `reply`, moving its item to review notifies `review`. */
  const notifyEntry = (comment: Comment, updated: DashboardRecord | null) => {
    const record = updated ?? store.get(comment.recordId);
    const parent = comment.replyTo ? z.object({ source: z.string() }).safeParse(store.db.query("SELECT source FROM comments WHERE id=?").get(comment.replyTo)) : null;
    const choices: { kind: "reply" | "review"; payload: PushPayload }[] = [];
    if (parent?.success && parent.data.source === "manual") choices.push({ kind: "reply", payload: replyPayload(record, comment, options.locale) });
    if (updated?.status === "review") choices.push({ kind: "review", payload: reviewPayload(record, comment.source, comment.body, options.locale) });
    if (choices.length && pushOn) push.notify(choices);
  };
  const notifyReview = (before: DashboardRecord | null, after: DashboardRecord) => {
    if (pushOn && after.kind === "task" && after.status === "review" && before?.status !== "review") {
      push.notify([{ kind: "review", payload: reviewPayload(after, after.source, "", options.locale) }]);
    }
  };
  /** Byte-range audio of a narration (a record's or a digest part's). The URL carries the file's version, so caching never outlives it. */
  const serveAudio = (c: Context, audio: { path: string; mime: string }) => {
    const file = Bun.file(audio.path);
    const size = file.size;
    c.header("Cache-Control", "private, max-age=31536000, immutable");
    c.header("Accept-Ranges", "bytes");
    c.header("Content-Type", audio.mime);
    const range = c.req.header("range");
    if (!range) { c.header("Content-Length", String(size)); return c.body(file.stream(), 200); }
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    const suffix = match?.[1] === "" ? Number(match[2]) : null;
    const start = suffix === null ? Number(match?.[1] ?? NaN) : Math.max(0, size - suffix);
    const end = suffix !== null || match?.[2] === "" ? size - 1 : Math.min(Number(match?.[2]), size - 1);
    if (!match || (match[1] === "" && match[2] === "") || !Number.isInteger(start) || start >= size || start > end) {
      c.header("Content-Range", `bytes */${size}`);
      return c.body(null, 416);
    }
    c.header("Content-Range", `bytes ${start}-${end}/${size}`);
    c.header("Content-Length", String(end - start + 1));
    return c.body(file.slice(start, end + 1).stream(), 206);
  };
  // Loopback origins of the listener and of the Vite dev server (4311), plus the configured APP_ORIGIN.
  const origins = new Set([
    `http://127.0.0.1:${port}`, `http://localhost:${port}`, "http://127.0.0.1:4311", "http://localhost:4311", privateOrigin,
  ]);
  const hosts = new Set([...origins].map(origin => new URL(origin).host));
  hosts.add(`127.0.0.1:${options.agentPort ?? 4312}`);
  if (options.publicApiBaseUrl) hosts.add(new URL(options.publicApiBaseUrl).host);
  const buckets = new Map<string, number>();
  let bucketWindow = Math.floor(now() / 60000);
  const limit = options.rateLimit ?? 300;
  const cookie = (value: string, expiresAt: string, secure: boolean) =>
    `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Expires=${new Date(expiresAt).toUTCString()}${secure ? "; Secure" : ""}`;

  function router(publicOnly: boolean) {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.header("X-Content-Type-Options", "nosniff");
      c.header("X-Frame-Options", "DENY");
      c.header("Referrer-Policy", "no-referrer");
      c.header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
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
      if (window !== bucketWindow) { buckets.clear(); bucketWindow = window; }
      // Unknown credentials share one bucket; clients cannot grow the map by rotating garbage tokens.
      let rateKey = "anonymous";
      const authorization = c.req.header("authorization");
      if (authorization?.startsWith("Bearer ")) {
        const credentialHash = hash(authorization.slice(7));
        if (store.db.query("SELECT id FROM principals WHERE token_hash=?").get(credentialHash)) rateKey = credentialHash;
      } else if (c.req.header("cookie")) rateKey = "browser";
      const count = (buckets.get(rateKey) ?? 0) + 1;
      buckets.set(rateKey, count);
      if (count > limit) { c.header("Retry-After", "60"); throw new ApiError(429, "rate_limited", "Request limit exceeded"); }
      if (demo && c.req.method !== "GET" && c.req.method !== "HEAD") throw new ApiError(403, "demo_read_only", "This is a read-only demo; changes are turned off");
      await next();
    });
    app.onError((error, c) => {
      if (error instanceof ApiError) return c.json({ error: { code: error.code, message: error.message } }, error.status);
      if (error instanceof z.ZodError) return c.json({ error: { code: "invalid_input", message: "Input validation failed", details: error.issues } }, 400);
      // Never log request bodies, cookies or credentials at this boundary.
      return c.json({ error: { code: "internal_error", message: "Internal server error" } }, 500);
    });
    if (!publicOnly) {
      app.post("/api/v1/capture", async c => {
        // Only the trusted proxy identity grants capture; cookies and other forwarded headers are not authority.
        if (!trustedOwner(c, true)) throw new ApiError(401, "unauthenticated", "Trusted owner identity required");
        if (c.req.header("X-Capture") !== "v1") throw new ApiError(403, "forbidden", "Capture marker required");
        const origin = c.req.header("origin");
        if (origin !== undefined && origin !== privateOrigin) throw new ApiError(403, "origin", "Private Origin required");
        const input = captureSchema.parse(await json(c.req.raw));
        const url = new URL(input.url);
        if (url.username || url.password || url.href.length > 2048) throw new ApiError(400, "invalid_input", "Invalid capture URL");
        const requestId = `capture:v1:${new Bun.CryptoHasher("sha512").update(url.href).digest("hex")}`;
        const previous = store.replay({ id: "owner", source: "manual" }, requestId, { url: url.href });
        if (previous) return c.json(previous, 200);
        let pending = capturing.get(requestId);
        if (!pending) {
          pending = (options.enrichCapture ?? enrichCapture)(url).finally(() => capturing.delete(requestId));
          capturing.set(requestId, pending);
        }
        const enrichment = await pending;
        const matches = (domain: string) => url.hostname === domain || url.hostname.endsWith(`.${domain}`);
        const record = RecordInputSchema.parse({
          kind: "social", title: enrichment.title,
          fields: { ...enrichment.fields, origin: ["x.com", "twitter.com"].some(matches) ? "x" : ["threads.net", "threads.com"].some(matches) ? "threads" : "other" },
          links: [{ label: "Source", url: url.href }],
        });
        const result = store.create({ id: "owner", source: "manual" }, requestId, record, { url: url.href }, "pending");
        if (!result.replayed) aiFill?.enqueue(result.record.id);
        return c.json(result, result.replayed ? 200 : 201);
      });
      app.get("/api/health", c => c.json({ status: "ok" }));
      app.get("/api/v1/health", c => c.json({ status: "ok" }));
      app.get("/api/v1/schema", c => c.json({ ...schemaInfo, timeZone }));
      /** What the UI needs before sign-in: name, version, calendar zone, default language and which optional features are on. */
      app.get("/api/v1/config", async c => c.json({
        appName: options.appName ?? "Agentic Dashboard", version: packageJson.version, timeZone, locale: options.locale ?? "en",
        features: { narration: await narration.available(), push: pushOn, digest: digestOn, trustedLogin: options.trustedIdentity !== undefined, demo },
      }));
      app.get("/api/v1/agents", c => {
        if (auth.authenticate(c.req.raw, false).source !== "manual") throw new ApiError(403, "forbidden", "Owner session required");
        return c.json({ items: agents.list() });
      });
      app.post("/api/v1/auth/session", async c => {
        if (!origins.has(c.req.header("origin") ?? "")) throw new ApiError(403, "origin", "Allowed Origin required");
        const input = z.object({ token: z.string().min(1).max(512) }).strict().parse(await json(c.req.raw));
        const session = auth.createSession(input.token);
        const secure = (c.req.header("origin") ?? "").startsWith("https:");
        c.header("Set-Cookie", cookie(session.value, session.expiresAt, secure));
        return c.json({ csrfToken: session.csrfToken, expiresAt: session.expiresAt });
      });
      app.get("/api/v1/auth/session", c => {
        // The trusted proxy terminates HTTPS and strips client copies of its identity header before the hop to this listener.
        if (c.req.method === "GET" && trustedOwner(c) && !auth.findSession(c.req.raw)) {
          const session = auth.createOwnerSession();
          c.header("Set-Cookie", cookie(session.value, session.expiresAt, true));
          return c.json({ principal: { id: "owner", source: "manual" },
            csrfToken: session.csrfToken, expiresAt: session.expiresAt });
        }
        const principal = auth.authenticate(c.req.raw, false);
        if (principal.source !== "manual") throw new ApiError(403, "forbidden", "Owner session required");
        const session = auth.session(c.req.raw);
        return c.json({ principal, csrfToken: session.csrf, expiresAt: new Date(session.expires_at).toISOString() });
      });
      app.delete("/api/v1/auth/session", c => {
        const principal = auth.authenticate(c.req.raw, false);
        if (principal.source !== "manual") throw new ApiError(403, "forbidden", "Owner session required");
        const session = auth.csrf(c.req.raw, origins);
        store.db.query("DELETE FROM sessions WHERE hash=?").run(session.hash);
        c.header("Set-Cookie", cookie("", new Date(0).toISOString(), (c.req.header("origin") ?? "").startsWith("https:")));
        return c.body(null, 204);
      });
      app.get("/api/v1/records", c => {
        const principal = auth.authenticate(c.req.raw, false);
        return c.json(principal.source === "manual" ? store.list(c.req.query()) : store.list(c.req.query(), principal));
      });
      app.patch("/api/v1/records/:id", async c => {
        const principal = auth.authenticate(c.req.raw, false);
        if (principal.source === "manual") auth.csrf(c.req.raw, origins);
        const patch = RecordPatchSchema.parse(await json(c.req.raw, RECORD_LIMITS.requestBytes));
        if (principal.source === "manual") return c.json({ record: store.patch(c.req.param("id"), patch) });
        const before = store.get(c.req.param("id"));
        const record = store.agentPatch(principal, c.req.param("id"), patch);
        notifyReview(before, record);
        return c.json({ record });
      });
      app.delete("/api/v1/records/:id", async c => {
        if (auth.authenticate(c.req.raw, false).source !== "manual") throw new ApiError(403, "forbidden", "Owner session required");
        auth.csrf(c.req.raw, origins);
        const input = z.object({ expectedVersion: z.number().int().positive() }).strict().parse(await json(c.req.raw));
        store.delete(c.req.param("id"), input.expectedVersion);
        return c.body(null, 204);
      });
      const owner = (request: Request, mutation: boolean) => {
        if (auth.authenticate(request, false).source !== "manual") throw new ApiError(403, "forbidden", "Owner session required");
        if (mutation) auth.csrf(request, origins);
      };
      app.get("/api/v1/comments", c => c.json(comments.list(auth.authenticate(c.req.raw, false), c.req.query())));
      app.post("/api/v1/comments", async c => {
        const principal = auth.authenticate(c.req.raw, false);
        if (principal.source === "manual") auth.csrf(c.req.raw, origins);
        const result = comments.create(principal, CommentInputSchema.parse(await json(c.req.raw)));
        if (principal.source !== "manual" && !result.replayed) notifyEntry(result.comment, result.record);
        return c.json(result, result.replayed ? 200 : 201);
      });
      app.post("/api/v1/comments/:id/seen", c => c.json(comments.mark(auth.authenticate(c.req.raw, false), c.req.param("id"), "seen")));
      app.post("/api/v1/comments/:id/done", c => c.json(comments.mark(auth.authenticate(c.req.raw, false), c.req.param("id"), "done")));
      app.get("/api/v1/trash", c => { owner(c.req.raw, false); const items = store.trashList(); narration.prune(); return c.json({ items }); });
      app.post("/api/v1/trash/:id/restore", c => { owner(c.req.raw, true); return c.json({ record: store.restore(c.req.param("id")) }); });
      app.delete("/api/v1/trash/:id", c => { owner(c.req.raw, true); store.destroy(c.req.param("id")); narration.prune(); return c.body(null, 204); });
      app.delete("/api/v1/trash", c => { owner(c.req.raw, true); store.emptyTrash(); narration.prune(); return c.body(null, 204); });
      /** Settings › Narration voices: the owner reads and saves the voices and speaking styles of the next narrations, and hears a voice first. */
      app.get("/api/v1/narration/voices", c => { owner(c.req.raw, false); return c.json(narration.voices()); });
      app.put("/api/v1/narration/voices", async c => { owner(c.req.raw, true); return c.json(narration.saveVoices(await json(c.req.raw))); });
      app.get("/api/v1/narration/voices/:voice/preview", async c => { owner(c.req.raw, false); return serveAudio(c, await narration.preview(c.req.param("voice"))); });
      /** The owner, or an agent for a record in its read scope (agentCanRead); others get 404 like the record itself. */
      const narratable = (request: Request, id: string) => {
        const principal = auth.authenticate(request, false);
        const record = store.get(id);
        if (principal.source !== "manual" && !agentCanRead(principal, record)) throw new ApiError(404, "not_found", "Record not found");
        return { principal, record };
      };
      app.get("/api/v1/records/:id/narration", async c => c.json(await narration.state(narratable(c.req.raw, c.req.param("id")).record)));
      app.post("/api/v1/records/:id/narration", async c => {
        const { principal, record } = narratable(c.req.raw, c.req.param("id"));
        if (principal.source === "manual") auth.csrf(c.req.raw, origins);
        const input = z.object({ force: z.boolean().optional(), style: NarrationStyleSchema.optional() }).strict().parse(await json(c.req.raw));
        const result = await narration.request(principal, record, input.force === true, input.style);
        return c.json(result.state, result.started ? 202 : 200);
      });
      app.delete("/api/v1/records/:id/narration", c => {
        const { principal, record } = narratable(c.req.raw, c.req.param("id"));
        if (principal.source !== "manual") throw new ApiError(403, "forbidden", "Owner session required");
        auth.csrf(c.req.raw, origins);
        narration.remove(record.id);
        return c.body(null, 204);
      });
      /** The owner's x: stops the job; only an optional empty object is accepted as the body. */
      const cancelBody = async (request: Request) => { if (request.body) z.object({}).strict().parse(await json(request)); };
      app.post("/api/v1/records/:id/narration/cancel", async c => {
        const { principal, record } = narratable(c.req.raw, c.req.param("id"));
        if (principal.source !== "manual") throw new ApiError(403, "forbidden", "Owner session required");
        auth.csrf(c.req.raw, origins);
        await cancelBody(c.req.raw);
        return c.json(await narration.cancel(record));
      });
      app.get("/api/v1/records/:id/narration/audio", c => serveAudio(c, narration.audioFile(narratable(c.req.raw, c.req.param("id")).record.id)));
      /** Full document: read like the record; replaced or removed by the owner (CSRF) or the agent that created the record. */
      app.get("/api/v1/records/:id/document", c => c.json({ document: store.document(narratable(c.req.raw, c.req.param("id")).record.id) }));
      const documentWriter = (request: Request, id: string) => {
        const { principal, record } = narratable(request, id);
        if (principal.source === "manual") auth.csrf(request, origins);
        else if (record.createdBy !== principal.id) throw new ApiError(403, "forbidden", "Agents attach documents only to records they created");
        if (!NARRATABLE_KINDS.some(kind => kind === record.kind)) {
          throw new ApiError(400, "document_unsupported", "Only research, work-report, note and social records take a document");
        }
        return { principal, record };
      };
      app.put("/api/v1/records/:id/document", async c => {
        const { principal, record } = documentWriter(c.req.raw, c.req.param("id"));
        const input = DocumentInputSchema.parse(await json(c.req.raw, DOCUMENT_LIMITS.requestBytes));
        return c.json({ document: store.putDocument(record.id, input.html, principal) });
      });
      app.delete("/api/v1/records/:id/document", c => {
        store.deleteDocument(documentWriter(c.req.raw, c.req.param("id")).record.id);
        return c.body(null, 204);
      });
      /** The owner and every registered agent read digests. */
      const digestReader = (request: Request) => { digestRoute(); return auth.authenticate(request, false); };
      app.post("/api/v1/digests", async c => {
        digestRoute();
        const principal = auth.authenticate(c.req.raw, false);
        if (principal.source === "manual") throw new ApiError(403, "forbidden", "Agents upload digests");
        const input = DigestInputSchema.parse(await json(c.req.raw, DIGEST_LIMITS.bodyBytes));
        const result = digests.upsert(principal, input);
        const notified = pushOn && input.notify && result.added.length > 0
          && push.notify([{ kind: "digest", payload: digestPayload(result.digest, result.added, result.created, options.locale) }]) > 0;
        return c.json({ digest: result.digest, created: result.created, changed: result.changed, notified }, result.created ? 201 : 200);
      });
      app.get("/api/v1/digests", c => { digestReader(c.req.raw); return c.json(digests.list(c.req.query())); });
      app.get("/api/v1/digests/search", c => { digestReader(c.req.raw); return c.json(digests.search(c.req.query())); });
      app.get("/api/v1/digests/:id", c => { digestReader(c.req.raw); return c.json({ digest: digests.get(c.req.param("id")) }); });
      app.post("/api/v1/digests/:id/read", async c => {
        owner(c.req.raw, true);
        const input = z.object({ read: z.boolean(), part: DigestPartSchema.optional() }).strict().parse(await json(c.req.raw));
        return c.json({ digest: digests.markRead(c.req.param("id"), input.read, input.part) });
      });
      /** Narration of one part of a digest (`:id` is the part's id, `digestPartId`): owner only; the same jobs, limits and audio store as record narration. */
      const digestSource = (request: Request, id: string, mutation: boolean) => {
        owner(request, mutation);
        digestRoute();
        const source = digests.narrationSource(id);
        if (!source) throw new ApiError(404, "not_found", "Digest not found");
        return source.record;
      };
      app.get("/api/v1/digests/:id/narration", async c => c.json(await narration.state(digestSource(c.req.raw, c.req.param("id"), false))));
      app.post("/api/v1/digests/:id/narration", async c => {
        const record = digestSource(c.req.raw, c.req.param("id"), true);
        const input = z.object({ force: z.boolean().optional(), style: NarrationStyleSchema.optional() }).strict().parse(await json(c.req.raw));
        if (input.style === "podcast") throw new ApiError(400, "narration_style_unsupported", "Digests are read aloud; the podcast style is for records");
        const result = await narration.request({ id: "owner", source: "manual" }, record, input.force === true, "read");
        return c.json(result.state, result.started ? 202 : 200);
      });
      app.delete("/api/v1/digests/:id/narration", c => { narration.remove(digestSource(c.req.raw, c.req.param("id"), true).id); return c.body(null, 204); });
      app.post("/api/v1/digests/:id/narration/cancel", async c => {
        const record = digestSource(c.req.raw, c.req.param("id"), true);
        await cancelBody(c.req.raw);
        return c.json(await narration.cancel(record));
      });
      app.get("/api/v1/digests/:id/narration/audio", c => serveAudio(c, narration.audioFile(digestSource(c.req.raw, c.req.param("id"), false).id)));
      app.get("/api/v1/push", c => {
        pushRoute();
        owner(c.req.raw, false);
        const endpoint = z.string().max(2048).optional().parse(c.req.query("endpoint"));
        return c.json({ publicKey: push.publicKey(), device: endpoint ? push.device(endpoint) : null, devices: push.count() });
      });
      app.put("/api/v1/push/subscription", async c => {
        pushRoute();
        owner(c.req.raw, true);
        const input = z.object({ subscription: z.unknown(), kinds: PushKindsSchema.optional() }).strict().parse(await json(c.req.raw));
        return c.json({ device: push.subscribe(input.subscription, input.kinds) });
      });
      app.delete("/api/v1/push/subscription", async c => {
        owner(c.req.raw, true);
        push.unsubscribe(z.object({ endpoint: z.string().max(2048) }).strict().parse(await json(c.req.raw)).endpoint);
        return c.body(null, 204);
      });
      app.post("/api/v1/push/test", async c => {
        pushRoute();
        owner(c.req.raw, true);
        return c.json(await push.test(z.object({ endpoint: z.string().max(2048) }).strict().parse(await json(c.req.raw)).endpoint));
      });
      app.get("/api/v1/records/:id/share", c => {
        if (auth.authenticate(c.req.raw, false).source !== "manual") throw new ApiError(403, "forbidden", "Owner session required");
        const record = store.get(c.req.param("id"));
        return c.json({ share: shares.get(record.id) });
      });
      app.post("/api/v1/records/:id/share", c => {
        if (auth.authenticate(c.req.raw, false).source !== "manual") throw new ApiError(403, "forbidden", "Owner session required");
        auth.csrf(c.req.raw, origins);
        const record = store.get(c.req.param("id"));
        const result = shares.create(record.id);
        return c.json({ share: result.share }, result.created ? 201 : 200);
      });
      app.delete("/api/v1/records/:id/share", c => {
        if (auth.authenticate(c.req.raw, false).source !== "manual") throw new ApiError(403, "forbidden", "Owner session required");
        auth.csrf(c.req.raw, origins);
        shares.revoke(store.get(c.req.param("id")).id);
        return c.body(null, 204);
      });
      // Possession of the code inside the tailnet is the capability; the private listener is never public.
      app.get("/api/v1/shared/:code", c => {
        const found = shares.find(c.req.param("code"));
        if (!found) throw new ApiError(404, "not_found", "Share not found");
        return c.json({ share: found.share, record: projectRecord(found.record) });
      });
      app.get("/s/:code", c => {
        const found = shares.find(c.req.param("code"));
        c.header("Content-Type", "text/plain; charset=utf-8");
        c.header("X-Robots-Tag", "noindex");
        return found ? c.body(renderMarkdown(found.record, found.share, shares.titleOf, timeZone), 200) : c.body("Share link not found.", 404);
      });
    }
    app.post("/api/v1/records", async c => {
      const principal = auth.authenticate(c.req.raw, publicOnly);
      if (principal.source === "manual") auth.csrf(c.req.raw, origins);
      const input = createSchema.parse(await json(c.req.raw, RECORD_LIMITS.requestBytes));
      const result = store.create(principal, input.requestId, RecordInputSchema.parse(input.record), input.record);
      if (!result.replayed && aiFillSources.has(principal.source)) aiFill?.enqueue(result.record.id);
      if (!result.replayed && principal.source !== "manual") notifyReview(null, result.record);
      return c.json(result, result.replayed ? 200 : 201);
    });
    app.get("/api/v1/records/:id", c => {
      const principal = auth.authenticate(c.req.raw, publicOnly);
      const record = store.get(c.req.param("id"));
      if (principal.source === "manual") return c.json({ record });
      // The public agent listener keeps reading to the agent's own records; the wider read scope stays on the private listener.
      const visible = publicOnly ? record.createdBy === principal.id : agentCanRead(principal, record);
      if (!visible) throw new ApiError(404, "not_found", "Record not found");
      return c.json({ record: agentView(principal, record) });
    });
    app.all("/api/*", c => c.json({ error: { code: "not_found", message: "Route not found" } }, 404));
    if (!publicOnly) {
      app.use("*", serveStatic({ root: options.staticRoot ?? "./dist" }));
      app.get("*", serveStatic({ root: options.staticRoot ?? "./dist", path: "index.html" }));
    }
    app.notFound(c => c.json({ error: { code: "not_found", message: "Route not found" } }, 404));
    return app;
  }
  const privateApp = router(false);
  const publicApp = router(true);
  const mcpAgent = options.mcpAgent;
  const mcpDisabled = async () => Response.json({ error: { code: "feature_disabled", message: "MCP needs MCP_AGENT" } }, { status: 503 });
  const mcpFetch = mcpAgent === undefined ? mcpDisabled : createMcpHandler({ store, agent: { id: mcpAgent, source: mcpAgent },
    port: options.mcpPort ?? 4313, rateLimit: limit, now,
    onCreate: id => { if (aiFillSources.has(mcpAgent)) aiFill?.enqueue(id); } });
  return { fetch: (request: Request) => privateApp.fetch(request), publicFetch: (request: Request) => publicApp.fetch(request),
    mcpFetch, aiFill, narration, push, agents, timeZone, purgeTrash: () => { const purged = store.purgeTrash(); narration.prune(); return purged; },
    close: () => store.close() };
}
