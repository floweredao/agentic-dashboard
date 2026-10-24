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

export interface AppOptions {
  readonly hosted?: HostedAuth;
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
  const localStore = new Store(new TenantDb(sql, "local"), now);
  const localAuth = new Auth(localStore, options.demo === true, options.hosted ? options.privateOrigin : undefined);
  if (!options.hosted) await localAuth.initialize(options.credentialsPath ?? "data/credentials.json");
  if (options.hosted && !options.privateOrigin) throw new Error("Hosted mode requires privateOrigin");
  const effective = options.hosted && options.privateOrigin ? { ...options, oidc: createOidc({
    hosted: options.hosted, origin: options.privateOrigin, control: localAuth.control, now,
  }) } : options;
  const scopes = new Map<string, Promise<Awaited<ReturnType<typeof createTenantApp>>>>();
  const tenant = (userId: string) => {
    let scope = scopes.get(userId);
    if (!scope) {
      scope = createTenantApp(effective, new Store(new TenantDb(sql, userId), now));
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
  return { ...local, sql, tenant,
    fetch: (request: Request) => dispatch(request, "fetch"),
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
