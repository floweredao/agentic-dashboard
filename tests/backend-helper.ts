import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "bun:test";
import { z } from "zod";
import { createApp, type AppOptions } from "../server/app";

export const origin = "http://127.0.0.1:4310";
export const tokens = { owner: "owner-test-secret", chatgpt: "chatgpt-test-secret", codex: "codex-test-secret", omo: "omo-test-secret" };
export const recordResult = z.object({ record: z.object({
  id: z.string().uuid(), source: z.string(), createdBy: z.string(), title: z.string(),
  kind: z.string(), body: z.string(), status: z.string(), version: z.number(),
  reviewState: z.string(), archivedAt: z.string().nullable(), fields: z.record(z.string(), z.unknown()),
  projectId: z.string().nullable(), taskId: z.string().nullable(), dueDate: z.string().nullable(),
  tags: z.array(z.string()), links: z.array(z.object({ label: z.string(), url: z.string() })),
}) });
export const AGENTS = ["chatgpt", "codex", "omo"] as const;
/**
 * An app on a temporary database with the owner key and three registered agents (chatgpt, codex, omo) holding fixed keys.
 * The tests were written for an Asia/Seoul calendar and an MCP connector saving as chatgpt, so those are the defaults here.
 */
export function fixture(rateLimit = 10000, now: () => number = Date.now, extra: Partial<AppOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agentic-backend-"));
  const credentialsPath = join(dir, "credentials.json");
  writeFileSync(credentialsPath, JSON.stringify({ owner: tokens.owner }), { mode: 0o600 });
  const options = { databasePath: join(dir, "db.sqlite"), credentialsPath, rateLimit, now, timeZone: "Asia/Seoul", mcpAgent: "chatgpt", ...extra,
    ...(extra.aiFill ? { aiFill: { sources: ["chatgpt"], ...extra.aiFill } } : {}) };
  let app = createApp(options);
  for (const agent of AGENTS) app.agents.add(agent, tokens[agent]);
  return {
    dir, options,
    get app() { return app; },
    restart() { app.close(); app = createApp(options); },
    close() { app.close(); rmSync(dir, { recursive: true, force: true }); },
    async call(path: string, method = "GET", body?: unknown, headers: HeadersInit = {}, publicOnly = false) {
      const h = new Headers(headers);
      if (body !== undefined) h.set("Content-Type", "application/json");
      const request = new Request(`${origin}${path}`, {
        method, headers: h, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return await (publicOnly ? app.publicFetch(request) : app.fetch(request));
    },
    async login() {
      const response = await app.fetch(new Request(`${origin}/api/v1/auth/session`, {
        method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ token: tokens.owner }),
      }));
      expect(response.status).toBe(200);
      const result = z.object({ csrfToken: z.string(), expiresAt: z.string() }).parse(await response.json());
      return { Cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "", Origin: origin, "X-CSRF-Token": result.csrfToken };
    },
  };
}
export const bearer = (source: "owner" | "chatgpt" | "codex" | "omo") => ({ Authorization: `Bearer ${tokens[source]}` });
const agentDefaults: Record<string, { body?: string; fields?: Record<string, unknown> }> = {
  research: { body: "본문", fields: { summary: "요약", conclusion: "결론", nextActions: "- 없음" } },
  "work-report": { body: "본문", fields: { summary: "요약", conclusion: "결론", nextActions: "- 없음" } },
  note: { body: "본문" },
  social: { fields: { summary: "요약" } },
};
/** A record that follows the agent record format for its kind, with the given values on top. */
export function agentRecord(record: Record<string, unknown> = {}) {
  const kind = typeof record["kind"] === "string" ? record["kind"] : "research";
  const defaults = agentDefaults[kind] ?? {};
  const fields = typeof record["fields"] === "object" && record["fields"] !== null ? record["fields"] : {};
  return { kind, title: "Research", tags: ["테스트"], ...defaults, ...record, fields: { ...defaults.fields, ...fields } };
}
export const payload = (record: unknown = agentRecord(), requestId = crypto.randomUUID()) => ({ requestId, record });
