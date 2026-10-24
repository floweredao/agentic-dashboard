import { expect, test } from "bun:test";
import { z } from "zod";
import { hostedFixture } from "./helpers/hosted";

const issued = z.object({ key: z.string().startsWith("fd_"), agent: z.object({ name: z.string(), capture: z.boolean() }) });
const note = { kind: "note", title: "Agent connection test", body: "Saved by the test agent.", tags: ["test"] };

test("browser-issued installer invitation is single-use and registers in its issuing account", async () => {
  const f = await hostedFixture();
  try {
    const response = await f.call("/api/v1/agents/invites", { method: "POST", body: { name: "computer" } });
    expect(response.status).toBe(201);
    const invite = z.object({ code: z.string(), expiresAt: z.string() }).parse(await response.json());
    const first = await f.call("/api/v1/agents/connect", { method: "POST", body: { code: invite.code }, headers: {} });
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ agent: "computer" });
    expect((await f.call("/api/v1/agents/connect", { method: "POST", body: { code: invite.code }, headers: {} })).status).toBe(404);
    expect(await f.b.scope.agents.get("computer")).toBeNull();
    expect(await f.a.scope.agents.get("computer")).not.toBeNull();
  } finally { await f.close(); }
});

test("personal token is shown once, saves with attribution, rotates and revokes", async () => {
  const f = await hostedFixture();
  try {
    // Given a session-authenticated token creation.
    const created = await f.call("/api/v1/agents", { method: "POST", body: { name: "omo", capture: true } });
    expect(created.status).toBe(201);
    const first = issued.parse(await created.json());
    // When the bearer saves through the actual API.
    const save = await f.call("/api/v1/records", { method: "POST", body: { requestId: crypto.randomUUID(), record: note },
      headers: { Authorization: `Bearer ${first.key}` } });
    // Then the account owns the record and future reads never return the token.
    expect(save.status).toBe(201);
    expect(await save.json()).toMatchObject({ record: { source: "omo", createdBy: "omo" } });
    expect(await (await f.call("/api/v1/agents")).text()).not.toContain(first.key);
    const second = issued.parse(await (await f.call("/api/v1/agents/omo/rotate", { method: "POST" })).json());
    expect((await f.call("/api/v1/records", { headers: { Authorization: `Bearer ${first.key}` } })).status).toBe(401);
    expect((await f.call("/api/v1/records", { headers: { Authorization: `Bearer ${second.key}` } })).status).toBe(200);
    expect((await f.call("/api/v1/agents/omo", { method: "DELETE" })).status).toBe(204);
    expect((await f.call("/api/v1/records", { headers: { Authorization: `Bearer ${second.key}` } })).status).toBe(401);
  } finally { await f.close(); }
});

test("token management requires CSRF and cannot touch another account", async () => {
  const f = await hostedFixture();
  try {
    await f.call("/api/v1/agents", { method: "POST", body: { name: "writer" } });
    expect((await f.call("/api/v1/agents", { method: "POST", body: { name: "bad" }, headers: { Cookie: f.a.headers.Cookie } })).status).toBe(403);
    expect((await f.call("/api/v1/agents/writer/rotate", { method: "POST", headers: f.b.headers })).status).toBe(404);
    expect((await f.call("/api/v1/agents/writer", { method: "DELETE", headers: f.b.headers })).status).toBe(404);
    expect(await (await f.call("/api/v1/agents", { headers: f.b.headers })).json()).toEqual({ items: [] });
  } finally { await f.close(); }
});

test("hosted capture requires an enabled agent bearer and preserves tenant attribution", async () => {
  const f = await hostedFixture();
  try {
    const enabled = issued.parse(await (await f.call("/api/v1/agents", { method: "POST", body: { name: "capture", capture: true } })).json());
    const disabled = issued.parse(await (await f.call("/api/v1/agents", { method: "POST", body: { name: "ordinary" } })).json());
    const body = { url: "https://example.test/article" };
    expect((await f.call("/api/v1/capture", { method: "POST", body, headers: { "X-Capture": "shortcut-v1" } })).status).toBe(401);
    expect((await f.call("/api/v1/capture", { method: "POST", body,
      headers: { Authorization: `Bearer ${disabled.key}`, "X-Capture": "shortcut-v1" } })).status).toBe(403);
    const saved = await f.call("/api/v1/capture", { method: "POST", body,
      headers: { Authorization: `Bearer ${enabled.key}`, "X-Floweredao-Capture": "shortcut-v1" } });
    expect(saved.status).toBe(201);
    const record = z.object({ record: z.object({ id: z.string(), createdBy: z.string() }) }).parse(await saved.json()).record;
    expect(record.createdBy).toBe("capture");
    expect((await f.call(`/api/v1/records/${record.id}`, { headers: f.b.headers })).status).toBe(404);
  } finally { await f.close(); }
});

test("main-port MCP requires a bearer even for notifications and isolates every tool", async () => {
  const f = await hostedFixture();
  try {
    const issuedA = issued.parse(await (await f.call("/api/v1/agents", { method: "POST", body: { name: "chatgpt" } })).json());
    const issuedB = issued.parse(await (await f.call("/api/v1/agents", { method: "POST", body: { name: "chatgpt" }, headers: f.b.headers })).json());
    const rpc = (method: string, params: unknown, key?: string) => f.call("/mcp", { method: "POST",
      body: { jsonrpc: "2.0", id: 1, method, params }, headers: key ? { Authorization: `Bearer ${key}` } : {} });
    expect((await rpc("initialize", {})).status).toBe(401);
    expect((await f.call("/mcp", { method: "POST", body: { jsonrpc: "2.0", method: "notifications/initialized" }, headers: {} })).status).toBe(401);
    const saved = z.object({ result: z.object({ structuredContent: z.object({ id: z.string() }) }) }).parse(
      await (await rpc("tools/call", { name: "save_record", arguments: { requestId: "one", record: note } }, issuedA.key)).json());
    const id = saved.result.structuredContent.id;
    expect(await (await rpc("tools/call", { name: "get_record", arguments: { id } }, issuedB.key)).json()).toMatchObject({ result: { isError: true } });
    expect(await (await rpc("tools/call", { name: "get_record", arguments: { id } }, issuedA.key)).json()).toMatchObject({ result: { structuredContent: { id, source: "chatgpt" } } });
    expect((await f.call("/mcp", { method: "POST", body: {}, headers: { Authorization: `Bearer ${issuedA.key}`, Origin: "http://127.0.0.1:4390" } })).status).toBe(403);
  } finally { await f.close(); }
});
