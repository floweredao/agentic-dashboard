import { z } from "zod";
import { AGENT_RECORD_GUIDE, RecordInputSchema, RecordPatchSchema, type DashboardRecord } from "../shared/contracts";
import { ApiError } from "./errors";
import { json } from "./json-body";
import { AGENT_READABLE_KINDS, agentCanRead, type Principal, type Store } from "./store";

const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const STATELESS_VERSION = "2026-07-28";
const SUPPORTED_VERSIONS = [STATELESS_VERSION, ...LEGACY_VERSIONS];
const VERSION_META = "io.modelcontextprotocol/protocolVersion";
const SERVER_INFO = { name: "agentic-dashboard", version: "0.1.0" };
const CAPABILITIES = { tools: { listChanged: false } };
const SEARCHABLE = AGENT_READABLE_KINDS;

const INSTRUCTIONS = "This is the owner's private dashboard. When the user asks to save something to the dashboard, " +
  "call save_record once with a new unique requestId and reuse that requestId only to retry the same save. " +
  "Report success only with the returned id. Use search_records to find research reports, work reports, notes and saved social links, " +
  "and get_record for one record's details. To correct or complete a record you saved, read it with get_record and call update_record " +
  "with its version and only the changed parts; on version_conflict read it again. Saved and edited records stay pending until the owner confirms them.";

const optional = <T extends z.ZodType>(schema: T) => schema.nullish().transform(value => value ?? undefined);
const saveArgs = z.object({ requestId: z.string().trim().min(1).max(128), record: z.unknown() }).strict();
const getArgs = z.object({ id: z.string().uuid() }).strict();
const updateArgs = z.object({
  id: z.string().uuid(), expectedVersion: RecordPatchSchema.shape.expectedVersion,
  changes: RecordPatchSchema.shape.changes.omit({ reviewState: true, archived: true }),
}).strict();
const { $schema: _unusedUpdate, ...updateJsonSchema } = z.toJSONSchema(updateArgs, { io: "input", unrepresentable: "any" });
const searchArgs = z.object({
  query: optional(z.string().trim().max(200)), kind: optional(z.enum(SEARCHABLE)),
  limit: optional(z.number().int().min(1).max(20)),
}).strict();
const { $schema: _unused, ...recordJsonSchema } = z.toJSONSchema(RecordInputSchema, { io: "input", unrepresentable: "any" });

const TOOLS = [
  {
    name: "save_record",
    title: "Save to the dashboard",
    description: "Use this when the user asks to save a result, research report, note, link or task to the dashboard. " +
      "kind: research, work-report, note, social (a saved link), task, project. " +
      "Put the full content in body and source URLs in links. " + AGENT_RECORD_GUIDE + " " +
      "title must be one line of at most 40 columns where Hangul and CJK count 2 (about 18 Korean characters): subject plus key point, no dates, details in fields.summary. " +
      "Creates a new record only; it cannot edit, archive or delete.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["requestId", "record"],
      properties: {
        requestId: { type: "string", minLength: 1, maxLength: 128,
          description: "Unique ID for this save, e.g. <date>-<topic>. Reuse it only when retrying the same save." },
        record: { ...recordJsonSchema, description: "Record content in the agent record format described above: kind, title, body, tags, links and the fields its kind requires." },
      },
    },
    annotations: { title: "Save to the dashboard", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "update_record",
    title: "Edit a dashboard record",
    description: "Use this to correct or complete a record you saved earlier, when the user asks or when it contains a mistake. " +
      "Read it with get_record first and send its version as expectedVersion with only the parts to change in changes; " +
      "changes.fields replaces the fields, and owner marks such as starred stay as they are. The result must still follow the agent record format " +
      "and the 40-column title rule. For a follow-up question or later research, save a new record with fields.previousId instead. " +
      "Edited records return to pending for the owner to confirm; it cannot confirm, archive or delete. On version_conflict read the record again and reapply.",
    inputSchema: { ...updateJsonSchema, properties: {
      ...updateJsonSchema.properties,
      id: { type: "string", format: "uuid", description: "Id of a record you saved." },
      expectedVersion: { type: "integer", minimum: 1, description: "The version returned by get_record." },
    } },
    annotations: { title: "Edit a dashboard record", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "get_record",
    title: "Read a dashboard record",
    description: "Use this to read one record by id: any record you saved, or any unarchived research, work-report, note or social record.",
    inputSchema: { type: "object", additionalProperties: false, required: ["id"],
      properties: { id: { type: "string", format: "uuid", description: "Record id returned by save_record or search_records." } } },
    annotations: { title: "Read a dashboard record", readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "search_records",
    title: "Search the dashboard",
    description: "Use this to find saved research reports, work reports, notes and social links in the dashboard by words in the title or body. " +
      "Returns newest first with id, title, summary, conclusion and links; call get_record for the full body.",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      query: { type: "string", maxLength: 200, description: "Words to match in title or body. Omit to list the newest records." },
      kind: { type: "string", enum: [...SEARCHABLE], description: "Limit to one kind. Omit to search all four." },
      limit: { type: "integer", minimum: 1, maximum: 20, default: 10 },
    } },
    annotations: { title: "Search the dashboard", readOnlyHint: true, openWorldHint: false },
  },
];

class RpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) { super(message); }
}
const messageSchema = z.object({
  jsonrpc: z.literal("2.0"), id: z.union([z.string(), z.number().int()]).optional(),
  method: z.string().optional(), params: z.record(z.string(), z.unknown()).optional(),
}).passthrough();
const toolCallSchema = z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).default({}) }).passthrough();
const headers = { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const reply = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...headers, ...extra } });
const rpcFailure = (id: string | number | null, code: number, message: string, status = 200, data?: unknown) =>
  reply({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } }, status);

const text = (value: unknown, max: number) => typeof value === "string" ? value.slice(0, max) : "";
function summary(record: DashboardRecord) {
  return { id: record.id, kind: record.kind, title: record.title, source: record.source, reviewState: record.reviewState,
    createdAt: record.createdAt, summary: text(record.fields.summary, 500), conclusion: text(record.fields.conclusion, 300),
    tags: record.tags, links: record.links.slice(0, 3) };
}
function detail(record: DashboardRecord, agent: Principal) {
  const { personalNotes: _private, ...fields } = record.fields;
  return { id: record.id, kind: record.kind, title: record.title, body: record.body, status: record.status,
    source: record.source, reviewState: record.reviewState, tags: record.tags, links: record.links,
    fields: record.createdBy === agent.id ? record.fields : fields,
    projectId: record.projectId, taskId: record.taskId, dueDate: record.dueDate,
    archived: record.archivedAt !== null, createdAt: record.createdAt, updatedAt: record.updatedAt, version: record.version };
}

/** Chat assistants sometimes repeat a save in a new run with a fresh requestId; identical content inside this window is one save. */
const SAME_SAVE_WINDOW_MS = 10 * 60000;

export interface McpOptions {
  readonly store: Store;
  /** Attribution is fixed by the listener: every MCP caller is this registered agent, never the owner. */
  readonly agent: Principal;
  readonly port: number;
  readonly rateLimit: number;
  readonly now: () => number;
  readonly onCreate?: (id: string) => void;
}

export function createMcpHandler({ store, agent, port, rateLimit, now, onCreate }: McpOptions) {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  let bucketWindow = Math.floor(now() / 60000);
  let count = 0;

  function runTool(name: string, args: Record<string, unknown>) {
    if (name === "save_record") {
      const input = saveArgs.parse(args);
      const { record, replayed } = store.create(agent, input.requestId, RecordInputSchema.parse(input.record), input.record, undefined, SAME_SAVE_WINDOW_MS);
      if (!replayed) onCreate?.(record.id);
      return { id: record.id, replayed, kind: record.kind, title: record.title, source: record.source,
        reviewState: record.reviewState, createdAt: record.createdAt };
    }
    if (name === "update_record") {
      const { id, ...patch } = updateArgs.parse(args);
      const record = store.agentPatch(agent, id, patch);
      return { id: record.id, kind: record.kind, title: record.title, source: record.source,
        reviewState: record.reviewState, version: record.version, updatedAt: record.updatedAt };
    }
    if (name === "get_record") {
      const record = store.get(getArgs.parse(args).id);
      if (!agentCanRead(agent, record)) throw new ApiError(404, "not_found", "Record not found");
      return detail(record, agent);
    }
    const input = searchArgs.parse(args);
    const limit = input.limit ?? 10;
    const items = (input.kind ? [input.kind] : SEARCHABLE)
      .flatMap(kind => store.list({ kind, limit: String(limit), ...(input.query ? { q: input.query } : {}) }, agent).items)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .slice(0, limit).map(summary);
    return { items };
  }

  function callTool(params: Record<string, unknown>) {
    const call = toolCallSchema.safeParse(params);
    if (!call.success || !TOOLS.some(tool => tool.name === call.data.name)) throw new RpcError(-32602, "Unknown tool");
    try {
      const data = runTool(call.data.name, call.data.arguments);
      return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data, isError: false };
    } catch (error) {
      const message = error instanceof ApiError ? `${error.code}: ${error.message}`
        : error instanceof z.ZodError ? `invalid_input: ${error.issues.map(issue => `${issue.path.join(".") || "(root)"} ${issue.message}`).join("; ")}`
          : null;
      if (message === null) throw error;
      return { content: [{ type: "text", text: message }], isError: true };
    }
  }

  function dispatch(method: string, params: Record<string, unknown>): Record<string, unknown> {
    switch (method) {
      case "initialize": {
        const requested = params.protocolVersion;
        const protocolVersion = typeof requested === "string" && LEGACY_VERSIONS.includes(requested) ? requested : LEGACY_VERSIONS[0];
        return { protocolVersion, capabilities: CAPABILITIES, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS };
      }
      case "server/discover":
        return { supportedVersions: SUPPORTED_VERSIONS, capabilities: CAPABILITIES, instructions: INSTRUCTIONS };
      case "ping": return {};
      case "tools/list": return { tools: TOOLS, ttlMs: 300000, cacheScope: "private" };
      case "tools/call": return callTool(params);
      default: throw new RpcError(-32601, "Method not found");
    }
  }

  return async function mcpFetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // Loopback Host and no browser Origin block DNS-rebinding pages from reaching the listener.
    if (!hosts.has(request.headers.get("host") ?? url.host)) return reply({ error: { code: "invalid_host", message: "Host is not allowed" } }, 421);
    if (url.pathname !== "/mcp") return reply({ error: { code: "not_found", message: "Route not found" } }, 404);
    if (request.method !== "POST") return reply({ error: { code: "method_not_allowed", message: "Use POST" } }, 405, { Allow: "POST" });
    if (request.headers.has("origin")) return reply({ error: { code: "origin", message: "Browser origins are not allowed" } }, 403);
    const headerVersion = request.headers.get("mcp-protocol-version");
    if (headerVersion !== null && !SUPPORTED_VERSIONS.includes(headerVersion)) {
      return rpcFailure(null, -32600, "Unsupported MCP-Protocol-Version", 400);
    }
    const window = Math.floor(now() / 60000);
    if (window !== bucketWindow) { bucketWindow = window; count = 0; }
    if (++count > rateLimit) return reply({ error: { code: "rate_limited", message: "Request limit exceeded" } }, 429, { "Retry-After": "60" });

    let body: unknown;
    try { body = await json(request); }
    catch (error) {
      if (!(error instanceof ApiError)) throw error;
      return rpcFailure(null, error.status === 400 ? -32700 : -32600, error.message, error.status);
    }
    if (Array.isArray(body)) return rpcFailure(null, -32600, "Batch requests are not supported", 400);
    const parsed = messageSchema.safeParse(body);
    if (!parsed.success || (parsed.data.id !== undefined && parsed.data.method === undefined)) {
      return rpcFailure(null, -32600, "Invalid JSON-RPC message", 400);
    }
    const { id, method, params = {} } = parsed.data;
    if (id === undefined || method === undefined) return new Response(null, { status: 202, headers: { "Cache-Control": "no-store" } });

    const meta = z.record(z.string(), z.unknown()).safeParse(params._meta);
    const metaVersion = meta.success ? meta.data[VERSION_META] : undefined;
    try {
      if (metaVersion !== undefined && (typeof metaVersion !== "string" || !SUPPORTED_VERSIONS.includes(metaVersion))) {
        throw new RpcError(-32022, "Unsupported protocol version", { supported: SUPPORTED_VERSIONS, requested: metaVersion });
      }
      const result = dispatch(method, params);
      const stateless = metaVersion === STATELESS_VERSION || headerVersion === STATELESS_VERSION || method === "server/discover";
      return reply({ jsonrpc: "2.0", id, result: stateless
        ? { ...result, resultType: "complete", _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO } } : result });
    } catch (error) {
      if (error instanceof RpcError) return rpcFailure(id, error.code, error.message, 200, error.data);
      // Never echo request bodies or internal details back to the caller.
      return rpcFailure(id, -32603, "Internal error");
    }
  };
}
