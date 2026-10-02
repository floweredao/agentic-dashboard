import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { agentRecord, bearer, fixture, payload, recordResult } from "./backend-helper";
import { generateCode, normalizeCode } from "../server/share";

const shareSchema = z.object({ code: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/), url: z.string(), createdAt: z.iso.datetime() }).strict();
const shareResult = z.object({ share: shareSchema });
let fixtures: ReturnType<typeof fixture>[] = [];
afterEach(() => { for (const f of fixtures) f.close(); fixtures = []; });
function setup() { const f = fixture(); fixtures.push(f); return f; }

async function ownerRecord(f: ReturnType<typeof fixture>, headers: Record<string, string>) {
  const response = await f.call("/api/v1/records", "POST", payload({
    kind: "research", title: "공유할 조사 보고", body: "본문 내용입니다.", tags: ["ai", "공유"],
    links: [{ label: "원문", url: "https://example.com/a" }, { label: "", url: "https://example.com/b" }],
    fields: { conclusion: "핵심 결론", summary: "짧은 요약", nextActions: "후속 확인", personalNotes: "비밀 메모", captureEnrichment: "internal-x" },
  }), headers);
  expect(response.status).toBe(201);
  return recordResult.parse(await response.json()).record;
}
async function share(f: ReturnType<typeof fixture>, id: string, headers: Record<string, string>) {
  const response = await f.call(`/api/v1/records/${id}/share`, "POST", undefined, headers);
  expect(response.status).toBe(201);
  return shareResult.parse(await response.json()).share;
}

test("owner creates one share per record and reads it back", async () => {
  const f = setup();
  const h = await f.login();
  const record = await ownerRecord(f, h);
  const empty = await f.call(`/api/v1/records/${record.id}/share`, "GET", undefined, h);
  expect(empty.status).toBe(200);
  expect(await empty.json()).toEqual({ share: null });
  const created = await share(f, record.id, h);
  expect(created.url).toBe(`http://127.0.0.1:4310/s/${created.code}`);
  const again = await f.call(`/api/v1/records/${record.id}/share`, "POST", undefined, h);
  expect(again.status).toBe(200);
  expect(shareResult.parse(await again.json()).share).toEqual(created);
  const read = await f.call(`/api/v1/records/${record.id}/share`, "GET", undefined, h);
  expect(shareResult.parse(await read.json()).share).toEqual(created);
});

test("share link serves Markdown without private notes and JSON projection without auth", async () => {
  const f = setup();
  const h = await f.login();
  const record = await ownerRecord(f, h);
  const created = await share(f, record.id, h);
  const text = await f.call(`/s/${created.code}`);
  expect(text.status).toBe(200);
  expect(text.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(text.headers.get("x-robots-tag")).toBe("noindex");
  const markdown = await text.text();
  expect(markdown.startsWith("# 공유할 조사 보고\n")).toBe(true);
  for (const part of ["- Kind: Research", "- Source: Owner", `- Share code: ${created.code}`, "## Conclusion\n\n핵심 결론", "## Summary\n\n짧은 요약",
    "## Body\n\n본문 내용입니다.", "## Next actions\n\n후속 확인", "- [원문](https://example.com/a)",
    "- [https://example.com/b](https://example.com/b)", "#ai", "#공유"]) expect(markdown).toContain(part);
  expect(markdown).not.toContain("비밀 메모");
  expect(markdown).not.toContain("internal-x");

  const json = await f.call(`/api/v1/shared/${created.code}`);
  expect(json.status).toBe(200);
  const body = z.object({ share: shareSchema, record: z.object({
    id: z.string(), kind: z.string(), title: z.string(), source: z.string(), status: z.string(), dueDate: z.string().nullable(),
    archived: z.boolean(), createdAt: z.string(), updatedAt: z.string(), summary: z.string(), conclusion: z.string(),
    nextActions: z.string(), nextAction: z.string(), body: z.string(), links: z.array(z.object({ label: z.string(), url: z.string() })),
    tags: z.array(z.string()), previousId: z.string().nullable(),
  }).strict() }).strict().parse(await json.json());
  expect(body.share).toEqual(created);
  expect(body.record).toMatchObject({ id: record.id, title: "공유할 조사 보고", conclusion: "핵심 결론", summary: "짧은 요약",
    nextActions: "후속 확인", nextAction: "", archived: false, body: "본문 내용입니다.", previousId: null });
  expect(markdown).not.toContain("Continues");
  expect(JSON.stringify(body)).not.toContain("비밀 메모");
  const after = await f.call(`/api/v1/records/${record.id}`, "GET", undefined, h);
  expect(recordResult.parse(await after.json()).record.version).toBe(record.version);
});

test("a continuing record's share names the earlier record by title and id", async () => {
  const f = setup();
  const h = await f.login();
  const earlier = await ownerRecord(f, h);
  const created = await f.call("/api/v1/records", "POST", payload({ kind: "note", title: "이어지는 메모", body: "후속", fields: { previousId: earlier.id } }), h);
  const later = recordResult.parse(await created.json()).record;
  const { code } = await share(f, later.id, h);
  expect(await (await f.call(`/s/${code}`)).text()).toContain(`Continues: 공유할 조사 보고 (${earlier.id})`);
  const json = z.looseObject({ record: z.looseObject({ previousId: z.string().nullable() }) }).parse(await (await f.call(`/api/v1/shared/${code}`)).json());
  expect(json.record.previousId).toBe(earlier.id);
});

test("code lookup is forgiving but rejects unknown or malformed codes", async () => {
  const f = setup();
  const h = await f.login();
  const record = await ownerRecord(f, h);
  const { code } = await share(f, record.id, h);
  const loose = code.toLowerCase().replaceAll("-", "");
  expect((await f.call(`/s/${loose}`)).status).toBe(200);
  expect((await f.call(`/api/v1/shared/${code.toLowerCase()}`)).status).toBe(200);
  expect((await f.call(`/s/${encodeURIComponent(` ${code.slice(0, 4)} ${code.slice(5)} `)}`)).status).toBe(200);
  const missing = await f.call("/s/0000-0000-0000");
  expect(missing.status).toBe(404);
  expect(missing.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(await missing.text()).toBe("Share link not found.");
  expect((await f.call("/s/UUUU-UUUU-UUUU")).status).toBe(404);
  expect((await f.call("/s/abc")).status).toBe(404);
  const jsonMissing = await f.call("/api/v1/shared/not-a-code");
  expect(jsonMissing.status).toBe(404);
  expect(z.object({ error: z.object({ code: z.literal("not_found"), message: z.string() }) }).safeParse(await jsonMissing.json()).success).toBe(true);
});

test("normalization maps O to 0 and I/L to 1", async () => {
  const f = setup();
  const h = await f.login();
  const record = await ownerRecord(f, h);
  const { code } = await share(f, record.id, h);
  const confusable = code.replaceAll("0", "O").replaceAll("1", "l");
  expect((await f.call(`/s/${confusable}`)).status).toBe(200);
  expect(normalizeCode("o1il-LOAB-cdef")).toBe("0111-10AB-CDEF");
  expect(normalizeCode(" 0000 0000 000u ")).toBeNull();
  expect(normalizeCode("0000-0000-00000")).toBeNull();
  expect(new Set(Array.from({ length: 50 }, generateCode)).size).toBe(50);
});

test("management routes require owner session and CSRF", async () => {
  const f = setup();
  const h = await f.login();
  const record = await ownerRecord(f, h);
  const path = `/api/v1/records/${record.id}/share`;
  for (const method of ["GET", "POST", "DELETE"]) {
    expect((await f.call(path, method, undefined, bearer("codex"))).status).toBe(403);
    expect((await f.call(path, method)).status).toBe(401);
  }
  const { Cookie, Origin } = h;
  expect((await f.call(path, "POST", undefined, { Cookie, Origin })).status).toBe(403);
  expect((await f.call(path, "DELETE", undefined, { Cookie, Origin })).status).toBe(403);
  expect((await f.call(path, "POST", undefined, { ...h, Origin: "https://evil.example" })).status).toBe(403);
  const missing = `/api/v1/records/${crypto.randomUUID()}/share`;
  for (const method of ["GET", "POST", "DELETE"]) expect((await f.call(missing, method, undefined, h)).status).toBe(404);
});

test("public agent listener does not expose share routes", async () => {
  const f = setup();
  const h = await f.login();
  const record = await ownerRecord(f, h);
  const { code } = await share(f, record.id, h);
  expect((await f.call(`/s/${code}`, "GET", undefined, {}, true)).status).toBe(404);
  expect((await f.call(`/api/v1/shared/${code}`, "GET", undefined, {}, true)).status).toBe(404);
  expect((await f.call(`/api/v1/records/${record.id}/share`, "GET", undefined, bearer("codex"), true)).status).toBe(404);
});

test("revoke, record deletion and restart", async () => {
  const f = setup();
  const h = await f.login();
  const record = await ownerRecord(f, h);
  const first = await share(f, record.id, h);
  expect((await f.call(`/api/v1/records/${record.id}/share`, "DELETE", undefined, h)).status).toBe(204);
  expect((await f.call(`/api/v1/records/${record.id}/share`, "DELETE", undefined, h)).status).toBe(204);
  expect((await f.call(`/s/${first.code}`)).status).toBe(404);
  const second = await share(f, record.id, h);
  expect(second.code).not.toBe(first.code);

  f.restart();
  const h2 = await f.login();
  expect((await f.call(`/s/${second.code}`)).status).toBe(200);
  const kept = await f.call(`/api/v1/records/${record.id}/share`, "GET", undefined, h2);
  expect(shareResult.parse(await kept.json()).share).toEqual(second);

  expect((await f.call(`/api/v1/records/${record.id}`, "DELETE", { expectedVersion: record.version }, h2)).status).toBe(204);
  expect((await f.call(`/s/${second.code}`)).status).toBe(404);
  expect((await f.call(`/api/v1/shared/${second.code}`)).status).toBe(404);
});

test("agent-created task shares render task meta and project nextAction", async () => {
  const f = setup();
  const h = await f.login();
  const created = await f.call("/api/v1/records", "POST", payload(agentRecord({ kind: "task", title: "Ship share", status: "todo", dueDate: "2026-10-01" })), bearer("omo"));
  expect(created.status).toBe(201);
  const task = recordResult.parse(await created.json()).record;
  const { code } = await share(f, task.id, h);
  const markdown = await (await f.call(`/s/${code}`)).text();
  for (const part of ["- Kind: Task", "- Source: omo", "- Status: todo", "- Due: 2026-10-01"]) expect(markdown).toContain(part);
  expect(markdown).not.toContain("## Body");

  const project = await f.call("/api/v1/records", "POST", payload({ kind: "project", title: "프로젝트", fields: { nextAction: "다음 단계" } }), h);
  const projectRecord = recordResult.parse(await project.json()).record;
  const projectShare = await share(f, projectRecord.id, h);
  expect(await (await f.call(`/s/${projectShare.code}`)).text()).toContain("## Next actions\n\n다음 단계");
  const json = z.looseObject({ record: z.looseObject({ nextAction: z.string() }) })
    .parse(await (await f.call(`/api/v1/shared/${projectShare.code}`)).json());
  expect(json.record.nextAction).toBe("다음 단계");
});
