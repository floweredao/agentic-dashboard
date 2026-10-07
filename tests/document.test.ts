import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { DocumentStateSchema } from "../shared/contracts";
import { agentRecord, bearer, fixture, recordResult } from "./backend-helper";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });
function setup() {
  const f = fixture();
  cleanups.push(() => f.close());
  return f;
}
type Fixture = ReturnType<typeof setup>;
const HTML = "<!doctype html><html><head><title>t</title></head><body><h1>전체 문서</h1><p>본문</p><script>alert(1)</script></body></html>";
const doc = (id: string) => `/api/v1/records/${id}/document`;
async function create(f: Fixture, record: Record<string, unknown>, headers: HeadersInit) {
  const response = await f.call("/api/v1/records", "POST", { requestId: crypto.randomUUID(), record }, headers);
  expect(response.status).toBe(201);
  return recordResult.parse(await response.json()).record;
}

test("the creating agent attaches an HTML document that the owner and readers get back unchanged; other agents cannot replace it", async () => {
  const f = setup();
  const owner = await f.login();
  const record = await create(f, agentRecord(), bearer("omo"));
  expect(DocumentStateSchema.parse(await (await f.call(doc(record.id), "GET", undefined, owner)).json()).document).toBeNull();

  const put = await f.call(doc(record.id), "PUT", { html: HTML }, bearer("omo"));
  expect(put.status).toBe(200);
  const saved = DocumentStateSchema.parse(await put.json()).document;
  expect(saved?.bytes).toBe(new TextEncoder().encode(HTML).byteLength);

  for (const headers of [owner, bearer("codex")]) {
    const read = DocumentStateSchema.parse(await (await f.call(doc(record.id), "GET", undefined, headers)).json());
    expect(read.document?.html).toBe(HTML);
  }
  expect((await f.call(doc(record.id), "PUT", { html: "<p>x</p>" }, bearer("codex"))).status).toBe(403);
  expect((await f.call(doc(record.id), "DELETE", undefined, bearer("codex"))).status).toBe(403);
  const { "X-CSRF-Token": _csrf, ...noCsrf } = owner;
  expect((await f.call(doc(record.id), "PUT", { html: "<p>x</p>" }, noCsrf)).status).toBe(403);
  expect((await f.call(doc(record.id), "PUT", { html: "<p>owner</p>" }, owner)).status).toBe(200);
  expect(DocumentStateSchema.parse(await (await f.call(doc(record.id), "GET", undefined, owner)).json()).document?.html).toBe("<p>owner</p>");
  expect((await f.call(doc(record.id), "DELETE", undefined, bearer("omo"))).status).toBe(204);
  expect(DocumentStateSchema.parse(await (await f.call(doc(record.id), "GET", undefined, owner)).json()).document).toBeNull();
});

test("documents are for material records, need HTML, refuse over 1 MiB, and answer 404 for unknown records", async () => {
  const f = setup();
  const owner = await f.login();
  const record = await create(f, agentRecord(), bearer("omo"));
  const task = await create(f, { kind: "task", title: "할 일", status: "todo" }, owner);
  expect((await f.call(doc(task.id), "PUT", { html: HTML }, owner)).status).toBe(400);
  expect((await f.call(doc(record.id), "PUT", { html: "" }, bearer("omo"))).status).toBe(400);
  expect((await f.call(doc(record.id), "PUT", { html: "가".repeat(400_000) }, bearer("omo"))).status).toBe(400);
  expect((await f.call(doc(crypto.randomUUID()), "GET", undefined, owner)).status).toBe(404);
  expect((await f.call(doc(crypto.randomUUID()), "PUT", { html: HTML }, owner)).status).toBe(404);
});

test("a full research text far past the old 16,000 characters is saved as the body", async () => {
  const f = setup();
  const body = `## 배경\n\n${"전체 조사 내용을 그대로 남깁니다. ".repeat(3000)}`;
  expect(body.length).toBeGreaterThan(50_000);
  const record = await create(f, agentRecord({ body }), bearer("omo"));
  expect(record.body).toBe(body);
});

test("a document stays with a trashed record and its restore, and goes when the record is deleted for good", async () => {
  const f = setup();
  const owner = await f.login();
  const record = await create(f, agentRecord(), bearer("omo"));
  expect((await f.call(doc(record.id), "PUT", { html: HTML }, bearer("omo"))).status).toBe(200);
  expect((await f.call(`/api/v1/records/${record.id}`, "DELETE", { expectedVersion: record.version }, owner)).status).toBe(204);
  expect((await f.call(`/api/v1/trash/${record.id}/restore`, "POST", undefined, owner)).status).toBe(200);
  expect(DocumentStateSchema.parse(await (await f.call(doc(record.id), "GET", undefined, owner)).json()).document?.html).toBe(HTML);
  const restored = recordResult.parse(await (await f.call(`/api/v1/records/${record.id}`, "GET", undefined, owner)).json()).record;
  expect((await f.call(`/api/v1/records/${record.id}`, "DELETE", { expectedVersion: restored.version }, owner)).status).toBe(204);
  expect((await f.call(`/api/v1/trash/${record.id}`, "DELETE", undefined, owner)).status).toBe(204);
  const db = new Database(f.options.databasePath, { readonly: true });
  const left = db.query("SELECT count(*) AS n FROM documents").get();
  db.close();
  expect(z.object({ n: z.number() }).parse(left).n).toBe(0);
});
