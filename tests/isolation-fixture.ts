import { expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app";
import { ControlDb } from "../server/control-db";
import { hash, SESSION_COOKIE } from "../server/auth";
import { Comments } from "../server/comments";
import { Digests } from "../server/digests";
import { Shares } from "../server/share";
import { TABLES } from "../server/schema";
import { canonical } from "../server/store";
import { CommentInputSchema, DigestInputSchema, RecordInputSchema } from "../shared/contracts";
import type { NarrationProvider } from "../server/narration";
import type { PushPayload } from "../shared/contracts";

export const origin = "http://127.0.0.1:4310";
export const clock = () => Date.parse("2026-10-24T12:00:00.000Z");
export const noteInput = RecordInputSchema.parse({ kind: "note", title: "Private A", body: "Only account A knows this.", tags: ["test"] });
export const digestInput = DigestInputSchema.parse({ date: "2026-10-24", slot: "morning", notify: false, sections: [
  { key: "tech", kind: "articles", title: "Private digest", items: [
    { key: "a1", title: "A headline", source: "Example", summary: "Only account A.", url: "https://example.test/article" },
  ] },
] });
export const subscription = (name: string) => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/${name}`,
  keys: { p256dh: Buffer.alloc(65, 1).toString("base64url"), auth: Buffer.alloc(16, 2).toString("base64url") },
});
const provider: NarrationProvider = {
  ttsModel: "test", scriptModel: "test", voice: "test-read", hosts: ["test-a", "test-b"],
  available: async () => true, script: async () => "A private narration.",
  speak: async () => new Uint8Array(480), converse: async () => new Uint8Array(480),
};
export async function isolationFixture() {
  const dir = mkdtempSync(join(tmpdir(), "tenant-isolation-"));
  const credentialsPath = join(dir, "credentials.json");
  writeFileSync(credentialsPath, JSON.stringify({ owner: "local-fixture-owner" }), { mode: 0o600 });
  const deliveries: { endpoint: string; payload: PushPayload }[] = [];
  const app = await createApp({
    databasePath: ":memory:", credentialsPath, now: clock, rateLimit: 10000, mcpAgent: "writer",
    narration: { provider, audioDir: join(dir, "audio"), encode: async path => ({ path, mime: "audio/wav" }) },
    push: { deliver: async (target, payload) => { deliveries.push({ endpoint: target.endpoint, payload }); return 201; } },
  });
  const control = new ControlDb(app.sql);
  for (const id of ["a", "b"]) await control.createUser(id, new Date(clock()).toISOString());
  const a = await app.tenant("a");
  const b = await app.tenant("b");
  const tokens = { a: "agent-a-isolation-key", b: "agent-b-isolation-key", ownerB: "owner-b-isolation-key" };
  for (const [scope, ownerKey, agentKey] of [[a, "owner-a-isolation-key", tokens.a], [b, tokens.ownerB, tokens.b]] as const) {
    await scope.store.db.run("INSERT INTO principals(id,source,token_hash,created_at,user_id) VALUES('owner','manual',?,?,?)",
      [hash(ownerKey), new Date(clock()).toISOString()]);
    await scope.agents.add("writer", agentKey);
  }
  await a.auth.createOwnerSession();
  await a.agents.add("only-a");
  await a.invites.create("pending-agent");
  const session = await b.auth.createOwnerSession();
  const ownerB = { Cookie: `${SESSION_COOKIE}=${session.value}`, Origin: origin, "X-CSRF-Token": session.csrfToken };
  const agentB = { Authorization: `Bearer ${tokens.b}` };
  const owner = { id: "owner", source: "manual" };
  const writer = { id: "writer", source: "writer" };
  const record = (await a.store.create(writer, "overlap", noteInput, noteInput)).record;
  const taskInput = RecordInputSchema.parse({ kind: "task", title: "A task", fields: { evidenceIds: [record.id] } });
  const task = (await a.store.create(owner, "task", taskInput, taskInput)).record;
  const trashed = (await a.store.create(owner, "trash", noteInput, noteInput)).record;
  await a.store.delete(trashed.id, 1);
  const comment = (await new Comments(a.store).create(owner,
    CommentInputSchema.parse({ requestId: "comment", recordId: task.id, body: "Private timeline" }))).comment;
  const digests = new Digests(a.store, "UTC");
  const digest = (await digests.upsert(writer, digestInput)).digest;
  await digests.react(digest.id, { section: "tech", key: "a1", reaction: "like" });
  const share = (await new Shares(a.store, origin).create(record.id)).share;
  await a.store.putDocument(record.id, "<p>Private document</p>", owner);
  await a.narration.request(owner, record, false);
  await a.narration.idle();
  await a.narration.saveAuto({ digests: "all", records: "podcast", scope: "full" });
  await b.narration.saveAuto({ digests: "off", records: "off", scope: "summary" });
  await a.narration.saveVoices({ readVoice: "test-b", hostA: "test-a", hostB: "test-b", readStyle: "Private A style", podcastStyle: "A podcast style" });
  await a.push.subscribe(subscription("a"));
  await b.push.subscribe(subscription("b"));
  const snapshot = async () => {
    const rows: unknown[] = [];
    for (const table of Object.keys(TABLES)) rows.push([table, await app.sql.all(`SELECT * FROM ${table} WHERE user_id=? ORDER BY rowid`, ["a"])]);
    return new Bun.CryptoHasher("sha256").update(canonical(rows)).digest("hex");
  };
  const call = (route: string, options: { method?: string; body?: unknown; agent?: boolean; ingress?: boolean } = {}) => {
    const headers = new Headers(options.agent ? agentB : ownerB);
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    const request = new Request(`${origin}${route}`, { method: options.method ?? "GET", headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
    return options.ingress ? app.publicFetch(request) : app.fetch(request);
  };
  const rpc = async (name: string, args: unknown) => {
    const response = await app.mcpFetch(new Request("http://127.0.0.1:4313/mcp", { method: "POST",
      headers: { ...agentB, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }));
    expect(response.status).toBe(200);
    return response.json();
  };
  return { app, a, b, dir, record, task, trashed, comment, digest, share, tokens, ownerB, agentB, deliveries, snapshot, call, rpc,
    async close() { await app.close(); rmSync(dir, { recursive: true, force: true }); } };
}
export type IsolationFixture = Awaited<ReturnType<typeof isolationFixture>>;
