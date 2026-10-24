import { dirname, join } from "node:path";
import { z } from "zod";
import type { Context } from "hono";
import { AUTO_NARRATED_KINDS } from "../shared/contracts";
import type { Comment, DashboardRecord, PushPayload } from "../shared/contracts";
import { createAiFill } from "./ai-fill";
import { systemTimeZone } from "../shared/time";
import { Agents } from "./agents";
import { Auth, hash, SESSION_COOKIE } from "./auth";
import { Digests } from "./digests";
import { Invites } from "./invites";
import { createPush, replyPayload, reviewPayload } from "./push";
import { Comments } from "./comments";
import { type CaptureEnrichment } from "./capture-enrichment";
import { ApiError } from "./errors";
import { json } from "./json-body";
import { createMcpHandler } from "./mcp";
import { createNarration, narrationSourceChanged } from "./narration";
import { Shares } from "./share";
import { agentCanRead, Store } from "./store";
import type { AppOptions } from "./app";
export async function createRuntime(options: AppOptions, store: Store) {

  const now = store.now;

  const demo = options.demo === true;

  const auth = new Auth(store, demo);

  const agents = new Agents(store);

  const invites = new Invites(store, agents);

  const timeZone = options.timeZone ?? systemTimeZone();

  const pushOn = options.pushEnabled !== false;

  const digestOn = options.digestEnabled !== false;

  const aiFillSources = new Set(options.aiFill?.sources ?? []);

  const comments = new Comments(store);

  const digests = new Digests(store, timeZone);

  const capturing = new Map<string, Promise<CaptureEnrichment>>();

  /** New records whose audio waits for their AI title fill, so it reads the filled title and summary. */
  const afterFill = new Set<string>();

  const aiFill = options.aiFill ? createAiFill({ store, ...options.aiFill, onSettled: async id => {
    if (!afterFill.delete(id)) return;
    try { (await autoNarrate((await store.get(id)))); }
    catch (error) { if (!(error instanceof ApiError) || error.status !== 404) throw error; }
  } }) : null;


  const narration = createNarration({ provider: null, ...options.narration, store,
    timeZone,
    audioDir: store.db.userId === "local"
      ? options.narration?.audioDir ?? join(dirname(options.databasePath ?? "data/dashboard.sqlite"), "audio")
      : join(options.narration?.audioDir ?? join(dirname(options.databasePath ?? "data/dashboard.sqlite"), "audio"), "users", hash(store.db.userId)),
    lookup: async id => {
      const source = (await digests.narrationSource(id));
      return source ? { ...source, audioBase: `/api/v1/digests/${id}` } : null;
    } });


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
   * The local owner signed in through the trusted proxy: right header value, over the configured HTTPS origin, without a key.
   * `strictHost` demands the Host header itself instead of falling back to the request URL (capture does).
   */
  const trustedOwner = (c: Context, strictHost = false) => {
    const trusted = options.trustedIdentity;
    const host = strictHost ? c.req.header("host") : c.req.header("host") ?? new URL(c.req.url).host;
    return store.db.userId === "local" && trusted !== undefined && trusted.login !== "" &&
      !c.req.raw.headers.has("authorization") && privateUrl.protocol === "https:" &&
      host === privateUrl.host && c.req.header(trusted.header) === trusted.login;
  };

  /** New and edited narratable records share the owner's automatic audio setting. */
  const autoNarrate = async (record: DashboardRecord, edited = false) => {
    const setting = (await narration.autoSettings()).records;
    if (setting === "off" || !AUTO_NARRATED_KINDS.some(kind => kind === record.kind)) return;
    const style = (edited ? (await narration.styleOf(record.id)) : null) ?? setting;
    narration.auto({ id: record.createdBy, source: record.source }, record.id, style);
  };

  const newRecord = async (record: DashboardRecord, fill: boolean) => {
    if (fill && aiFill) { afterFill.add(record.id); aiFill.enqueue(record.id); }
    else (await autoNarrate(record));
  };

  const editedRecord = async (before: DashboardRecord, after: DashboardRecord) => {
    if (narrationSourceChanged(before, after)) (await autoNarrate(after, true));
  };

  /** An agent's timeline entry: a reply to an owner comment notifies `reply`, moving its item to review notifies `review`. */
  const notifyEntry = async (comment: Comment, updated: DashboardRecord | null) => {
    const record = updated ?? (await store.get(comment.recordId));
    const parent = comment.replyTo ? z.object({ source: z.string() }).safeParse((await store.db.get("SELECT source FROM comments WHERE (id=?) AND user_id=?", [comment.replyTo]))) : null;
    const choices: { kind: "reply" | "review"; payload: PushPayload }[] = [];
    if (parent?.success && parent.data.source === "manual") choices.push({ kind: "reply", payload: replyPayload(record, comment, options.locale) });
    if (updated?.status === "review") choices.push({ kind: "review", payload: reviewPayload(record, comment.source, comment.body, options.locale) });
    if (choices.length && pushOn) (await push.notify(choices));
  };

  const notifyReview = async (before: DashboardRecord | null, after: DashboardRecord) => {
    if (pushOn && after.kind === "task" && after.status === "review" && before?.status !== "review") {
      (await push.notify([{ kind: "review", payload: reviewPayload(after, after.source, "", options.locale) }]));
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

  const rate = { buckets: new Map<string, number>(), window: Math.floor(now() / 60000) };

  const limit = options.rateLimit ?? 300;

  const cookie = (value: string, expiresAt: string, secure: boolean) =>
    `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Expires=${new Date(expiresAt).toUTCString()}${secure ? "; Secure" : ""}`;
      const owner = async (request: Request, mutation: boolean) => {
        if ((await auth.authenticate(request, false)).source !== "manual") throw new ApiError(403, "forbidden", "Owner session required");
        if (mutation) (await auth.csrf(request, origins));
      };

      /** The owner, or an agent for a record in its read scope (agentCanRead); others get 404 like the record itself. */
      const narratable = async (request: Request, id: string) => {
        const principal = (await auth.authenticate(request, false));
        const record = (await store.get(id));
        if (principal.source !== "manual" && !agentCanRead(principal, record)) throw new ApiError(404, "not_found", "Record not found");
        return { principal, record };
      };

      /** The owner's x: stops the job; only an optional empty object is accepted as the body. */
      const cancelBody = async (request: Request) => { if (request.body) z.object({}).strict().parse(await json(request)); };
  const mcpAgent = options.mcpAgent;

  const mcpDisabled = async () => Response.json({ error: { code: "feature_disabled", message: "MCP needs MCP_AGENT" } }, { status: 503 });

  const mcpFetch = mcpAgent === undefined ? mcpDisabled : createMcpHandler({ store, agent: { id: mcpAgent, source: mcpAgent },
    port: options.mcpPort ?? 4313, rateLimit: limit, now,
    resolveAgent: request => request.headers.has("authorization") ? auth.authenticate(request, true) : Promise.resolve({ id: mcpAgent, source: mcpAgent }),
    onCreate: async id => (await newRecord((await store.get(id)), aiFillSources.has(mcpAgent))), onUpdate: editedRecord });

  await store.purgeTrash();

  await narration.prune();

  await narration.resume();

  await aiFill?.sweep();
  return { options, store, now, demo, auth, agents, invites, timeZone, pushOn, digestOn, aiFillSources, comments, digests, aiFill, narration, port, privateOrigin, privateUrl, shares, push, pushRoute, digestRoute, trustedOwner, newRecord, editedRecord, notifyEntry, notifyReview, serveAudio, origins, hosts, limit, cookie, capturing, owner, narratable, cancelBody, rate, mcpFetch,
    async purgeTrash() { const purged = await store.purgeTrash(); await narration.prune(); return purged; },
    async close() { await aiFill?.idle(); await narration.idle(); await push.idle(); }
  };
}
export type TenantRuntime = Awaited<ReturnType<typeof createRuntime>>;
