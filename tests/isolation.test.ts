import { expect, test } from "bun:test";
import { z } from "zod";
import { TOOLS } from "../server/mcp";
import { CASES } from "./isolation-cases";
import { isolationFixture, noteInput, subscription, type IsolationFixture } from "./isolation-fixture";

const PUBLIC_ROUTES = new Set([
  "ALL /*", "ALL /api/*", "GET /*", "GET /api/health", "GET /api/v1/health", "GET /api/v1/schema",
  "GET /api/v1/config", "GET /api/v1/shared/:code", "GET /s/:code", "POST /api/v1/agents/connect",
  "GET /auth/google/start", "GET /auth/google/callback", "GET /auth/capacity",
]);
const MCP_CASES: Readonly<Record<string, (f: IsolationFixture) => Promise<void>>> = {
  async get_record(f) {
    const result = z.object({ result: z.object({ isError: z.boolean(), content: z.array(z.object({ text: z.string() })) }) }).parse(await f.rpc("get_record", { id: f.record.id })).result;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toStartWith("not_found:");
  },
  async update_record(f) {
    expect(await f.rpc("update_record", { id: f.record.id, expectedVersion: 1, changes: { title: "B overwrite" } })).toMatchObject({ result: { isError: true } });
  },
  async search_records(f) {
    expect(await f.rpc("search_records", { query: "Private" })).toMatchObject({ result: { isError: false, structuredContent: { items: [] } } });
  },
  async save_record(f) {
    const result = z.object({ result: z.object({ structuredContent: z.object({ id: z.string(), replayed: z.boolean() }) }) })
      .parse(await f.rpc("save_record", { requestId: "overlap", record: noteInput })).result.structuredContent;
    expect(result.replayed).toBe(false);
    expect(result.id).not.toBe(f.record.id);
    expect((await f.b.store.get(result.id)).createdBy).toBe("writer");
  },
};

test("every registered HTTP route and MCP tool has an isolation case", async () => {
  const f = await isolationFixture();
  try {
    const routes = new Set([...f.app.routes, ...f.app.publicRoutes].map(route => `${route.method} ${route.path}`));
    const missing = [...routes].filter(route => !(route in CASES));
    const missingTools = TOOLS.map(tool => tool.name).filter(name => !(name in MCP_CASES));
    expect({ missingRoutes: missing, missingTools }).toEqual({ missingRoutes: [], missingTools: [] });
    expect(Object.keys(CASES).filter(route => !routes.has(route))).toEqual([]);
  } finally { await f.close(); }
});

for (const [route, scenario] of Object.entries(CASES)) {
  switch (scenario.kind) {
    case "public":
      test(`${route} is an explicitly public capability or metadata route`, () => { expect(PUBLIC_ROUTES.has(route)).toBe(true); });
      break;
    case "private":
      test(`${route} isolates B from A and leaves A unchanged`, async () => {
        const f = await isolationFixture();
        try {
          // Given: A owns content in every tenant table, B has separate credentials.
          const before = await f.snapshot();
          const [method = "", template = ""] = route.split(" ");
          const id = template.includes("/comments/") ? f.comment.id : template.includes("/trash/") ? f.trashed.id
            : template.includes("/digests/") ? f.digest.id : f.record.id;
          const path = template.replace(":id", id).replace(":voice", "test-read").replace(":name", "only-a") + (scenario.query ?? "");
          // When: the real router processes B's request against A's identifiers or collection.
          const response = await f.call(path, { method, ...(scenario.body ? { body: scenario.body(f) } : {}),
            ...(scenario.agent ? { agent: true } : {}) });
          // Then: B gets only its own scope, and no A row changed.
          expect(response.status).toBe(scenario.status);
          if (scenario.check) scenario.check(await response.json(), f);
          else await response.arrayBuffer();
          await f.b.narration.idle();
          await f.b.push.idle();
          expect(await f.snapshot()).toBe(before);
        } finally { await f.close(); }
      });
      break;
    default: {
      const exhaustive: never = scenario;
      throw new Error(`Unknown isolation case: ${String(exhaustive)}`);
    }
  }
}

for (const [name, run] of Object.entries(MCP_CASES)) {
  test(`MCP ${name} uses B's bearer and leaves A unchanged`, async () => {
    const f = await isolationFixture();
    try {
      const before = await f.snapshot();
      await run(f);
      expect(await f.snapshot()).toBe(before);
    } finally { await f.close(); }
  });
}

test("agent ingress cannot read A and scopes repeated request IDs to B", async () => {
  const f = await isolationFixture();
  try {
    const before = await f.snapshot();
    expect((await f.call(`/api/v1/records/${f.record.id}`, { agent: true, ingress: true })).status).toBe(404);
    const response = await f.call("/api/v1/records", { method: "POST", agent: true, ingress: true, body: { requestId: "overlap", record: noteInput } });
    const own = z.object({ record: z.object({ id: z.string() }), replayed: z.boolean() }).parse(await response.json());
    expect(own.replayed).toBe(false);
    expect(own.record.id).not.toBe(f.record.id);
    expect(await f.snapshot()).toBe(before);
  } finally { await f.close(); }
});

test("push notification fanout reaches only the bound account", async () => {
  const f = await isolationFixture();
  try {
    const before = await f.snapshot();
    await f.a.push.notify([{ kind: "review", payload: { kind: "review", title: "A", body: "Private A", url: "/", tag: "a" } }]);
    await f.a.push.idle();
    expect(f.deliveries.map(delivery => delivery.endpoint)).toEqual([subscription("a").endpoint]);
    expect(await f.snapshot()).toBe(before);
  } finally { await f.close(); }
});

test("a device moves to its last subscribing account without leaking its old keys", async () => {
  const f = await isolationFixture();
  try {
    await f.b.push.subscribe(subscription("a"));
    expect(await f.a.push.device(subscription("a").endpoint)).toBeNull();
    await f.a.push.notify([{ kind: "review", payload: { kind: "review", title: "A", body: "Private A", url: "/", tag: "a" } }]);
    await f.a.push.idle();
    expect(f.deliveries).toEqual([]);
  } finally { await f.close(); }
});

test("public share lookup resolves the issuing tenant rather than the local owner", async () => {
  const f = await isolationFixture();
  try {
    const response = await f.call(`/api/v1/shared/${f.share.code}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ record: { id: f.record.id, title: "Private A" } });
  } finally { await f.close(); }
});

test("A exhausting its daily narration allowance does not consume B's allowance", async () => {
  const f = await isolationFixture();
  try {
    await f.a.narration.saveAuto({ digests: "off", records: "off", scope: "full" });
    for (let index = 0; index < 19; index++) {
      await f.a.store.db.run("INSERT INTO narration_runs(record_id,started_at,user_id) VALUES(?,?,?)", [f.record.id, new Date(f.a.store.now()).toISOString()]);
    }
    await expect(f.a.narration.request({ id: "owner", source: "manual" }, f.record, true)).rejects.toMatchObject({ code: "narration_daily_limit" });
    const own = (await f.b.store.create({ id: "owner", source: "manual" }, "b-audio", noteInput, noteInput)).record;
    const response = await f.call(`/api/v1/records/${own.id}/narration`, { method: "POST", body: {} });
    expect(response.status).toBe(202);
  } finally { await f.close(); }
});

test("concurrent accounts cannot exceed the service-wide narration cap", async () => {
  const f = await isolationFixture();
  try {
    for (let index = 0; index < 58; index++) {
      await f.app.sql.run("INSERT INTO narration_runs(record_id,started_at,user_id) VALUES(?,?,?)",
        ["other", new Date(f.a.store.now()).toISOString(), "other"]);
    }
    const own = (await f.b.store.create({ id: "owner", source: "manual" }, "b-audio", noteInput, noteInput)).record;
    const results = await Promise.allSettled([
      f.a.narration.request({ id: "owner", source: "manual" }, f.record, true),
      f.b.narration.request({ id: "owner", source: "manual" }, own, false),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(result => result.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : null).toMatchObject({ code: "narration_global_daily_limit" });
  } finally { await f.close(); }
});
