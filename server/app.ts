import { type AiFillOptions } from "./ai-fill";
import { Auth } from "./auth";
import { type PushOptions } from "./push";
import { type CaptureEnrichment } from "./capture-enrichment";
import { type NarrationOptions } from "./narration";
import { Store } from "./store";
import { openSql, type Sql } from "./db";
import { TenantDb } from "./tenant-db";
import { migrate } from "./migrations";
import { ControlDb } from "./control-db";
import { createRuntime } from "./app-runtime";
import { createRouter } from "./app-router";
import { createOidc, type HostedAuth } from "./oidc";
import { authLimiter } from "./auth-rate";
import { ApiError } from "./errors";
import { createGeminiKeys, type GeminiKeys, type GeminiKeyOptions } from "./gemini-settings";
import type { KeySource } from "./gemini";
import type { NarrationProvider } from "./narration";
import { cloudClient } from "./cloud-client";
import { gcsAudioStore, localAudioStore, type AudioStore } from "./audio-store";
import { dirname, join } from "node:path";
import { cloudJobs, taskVerifier, JobKindSchema, JobPayloadSchema, type Jobs, type TasksOptions } from "./jobs";
import { json } from "./json-body";
import { createAlerts } from "./alerts";
import { createMaintenance, type OperationsOptions } from "./maintenance";
import { Hono } from "hono";

export interface AppOptions {
  readonly hosted?: HostedAuth;
  readonly geminiKeys?: GeminiKeyOptions;
  readonly keyStore?: GeminiKeys;
  readonly personalProvider?: (key: KeySource) => NarrationProvider;
  readonly narrationEnabled?: boolean;
  readonly audioBucket?: string;
  readonly audioStore?: AudioStore;
  readonly tasks?: TasksOptions;
  readonly jobs?: Jobs;
  readonly operations?: OperationsOptions;
  /** Shared protocol cache, initialized by createApp for all tenants. */
  readonly oidc?: ReturnType<typeof createOidc>;
  readonly databasePath?: string;
  readonly databaseUrl?: string;
  readonly databaseAuthToken?: string;
  readonly sql?: Sql;
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
async function createTenantApp(options: AppOptions, store: Store) {
  const runtime = await createRuntime(options, store);
  const privateApp = createRouter(runtime, false);
  const publicApp = createRouter(runtime, true);
  return { ...runtime, routes: privateApp.routes, publicRoutes: publicApp.routes,
    fetch: (request: Request) => privateApp.fetch(request), publicFetch: (request: Request) => publicApp.fetch(request) };
}

/** One fixed service graph per tenant: no mutable request-global identity or shared job queues. */
export async function createApp(options: AppOptions = {}) {
  const sql = options.sql ?? await openSql(options.databaseUrl ?? options.databasePath ?? "data/dashboard.sqlite", options.databaseAuthToken);
  await migrate(sql);
  const now = options.now ?? Date.now;
  const alerts = options.operations?.alerts ? createAlerts(sql, { ...options.operations.alerts, now }) : undefined;
  const cloud = cloudClient();
  const localStore = new Store(new TenantDb(sql, "local"), now);
  const localAuth = new Auth(localStore, options.demo === true, options.hosted ? options.privateOrigin : undefined);
  if (!options.hosted) await localAuth.initialize(options.credentialsPath ?? "data/credentials.json");
  if (options.hosted && !options.privateOrigin) throw new ApiError(500, "configuration", "Hosted mode requires privateOrigin");
  const effective: AppOptions = { ...options,
    ...(options.tasks && options.privateOrigin ? { jobs: options.jobs ?? cloudJobs({
      ...options.tasks, origin: options.privateOrigin, client: cloud,
    }) } : {}),
    audioStore: options.audioStore ?? (options.audioBucket
      ? gcsAudioStore({ bucket: options.audioBucket, client: cloud, now })
      : localAudioStore(options.narration?.audioDir ?? join(dirname(options.databasePath ?? "data/dashboard.sqlite"), "audio"))),
    ...(options.geminiKeys ? { keyStore: createGeminiKeys(sql, options.geminiKeys) } : {}),
    ...(options.hosted && options.privateOrigin ? { oidc: createOidc({
    hosted: { ...options.hosted, onSignup: async () => { await alerts?.send("signup"); },
      onCapacity: async () => { await options.hosted?.onCapacity?.(); await alerts?.send("capacity"); } },
    origin: options.privateOrigin, control: localAuth.control, now,
  }) } : {}),
  };
  const scopes = new Map<string, Promise<Awaited<ReturnType<typeof createTenantApp>>>>();
  const tenant = (userId: string) => {
    let scope = scopes.get(userId);
    if (!scope) {
      scope = createTenantApp(effective, new Store(new TenantDb(sql, userId), now)).catch((error: unknown) => {
        scopes.delete(userId);
        throw error;
      });
      scopes.set(userId, scope);
    }
    return scope;
  };
  const local = await tenant("local");
  // Resume pending audio and AI fills for every existing account, including accounts without a current browser session.
  for (const userId of await new ControlDb(sql).users()) await tenant(userId);
  const dispatch = async (request: Request, surface: "fetch" | "publicFetch" | "mcpFetch") => {
    const scope = await tenant(await localAuth.resolveUser(request));
    return scope[surface](request);
  };
  const limitAuth = authLimiter(now);
  const maintenance = createMaintenance({ sql, tenant, audio: effective.audioStore ?? localAudioStore("data/audio"), cloud, now,
    directory: join(dirname(options.databasePath ?? "data/dashboard.sqlite"), "backups"),
    ...(options.audioBucket ? { bucket: options.audioBucket } : {}), ...(alerts ? { alerts } : {}),
    ...(options.operations?.turso ? { turso: options.operations.turso } : {}) });
  const verifyTask = options.tasks && options.privateOrigin ? taskVerifier({ ...options.tasks, origin: options.privateOrigin, now }) : null;
  const internal = async (request: Request) => {
    try {
      if (!verifyTask || request.method !== "POST") throw new ApiError(401, "task_unauthenticated", "Service account authentication required");
      await verifyTask(request);
      const name = new URL(request.url).pathname.slice("/internal/tasks/".length);
      if (name === "maintenance") { await maintenance(); return new Response(null, { status: 204 }); }
      const kind = JobKindSchema.parse(name);
      const payload = JobPayloadSchema.parse(await json(request));
      const scope = await tenant(payload.userId);
      switch (kind) {
        case "narration": await scope.narration.deliver(payload); break;
        case "ai-fill": await scope.aiFill?.deliver(payload); break;
        default: { const unreachable: never = kind; throw unreachable; }
      }
      await scope.push.idle();
      return new Response(null, { status: 204 });
    } catch (error) {
      if (error instanceof ApiError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
      return Response.json({ error: { code: "task_failed", message: "Background work failed" } }, { status: 500 });
    }
  };
  const internalApp = new Hono();
  internalApp.post("/internal/tasks/:kind", c => internal(c.req.raw));
  return { ...local, sql, tenant, maintenance, routes: [...local.routes, ...internalApp.routes],
    fetch: (request: Request, server?: { requestIP(request: Request): { address: string } | null }) =>
      new URL(request.url).pathname.startsWith("/internal/tasks/") ? internalApp.fetch(request)
        : limitAuth(request, server?.requestIP(request)?.address) ?? dispatch(request, "fetch"),
    publicFetch: (request: Request) => dispatch(request, "publicFetch"),
    mcpFetch: (request: Request) => dispatch(request, "mcpFetch"),
    async purgeTrash() { let count = 0; for (const scope of scopes.values()) count += await (await scope).purgeTrash(); return count; },
    async retryDeferred() { for (const scope of scopes.values()) await (await scope).narration.retryDeferred(); },
    async close() {
      for (const scope of scopes.values()) await (await scope).close();
      await sql.close();
    },
  };
}
