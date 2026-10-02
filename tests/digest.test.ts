import { afterAll, afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { DigestSchema, DigestSummarySchema } from "../shared/contracts";
import { bearer, fixture } from "./backend-helper";

let f = fixture();
afterEach(() => { f.close(); f = fixture(); });
afterAll(() => f.close());

const article = (key: string, title: string, extra: Record<string, unknown> = {}) => ({
  key, title, source: "Newswire", summary: `${title} 요약.`, url: `https://news.example.com/${key}`, ...extra,
});
const message = (key: string, subject: string, importance = "check") => ({
  key, importance, from: "Carrier", address: "noreply@carrier.example.com", subject, summary: `${subject} 요약.`, action: "본인 접속인지 확인하세요.",
  url: "https://mail.example.com/read/1",
});
const articles = (key: string, title: string, items: unknown[], extra: Record<string, unknown> = {}) => ({ key, title, kind: "articles", items, ...extra });
const messages = (key: string, title: string, items: unknown[]) => ({ key, title, kind: "messages", items });
const morning = (sections: unknown[], extra: Record<string, unknown> = {}) => ({ date: "2026-10-01", slot: "morning", sections, ...extra });
const saved = z.object({ digest: DigestSchema, created: z.boolean(), changed: z.array(z.string()), notified: z.boolean() });
const partTotals = z.object({ unread: z.number(), earliestDate: z.string().nullable() }).strict();
const list = z.object({ items: z.array(DigestSummarySchema), unread: z.number(), earliestDate: z.string().nullable(), latestDate: z.string().nullable(),
  parts: z.object({ articles: partTotals, messages: partTotals }).strict() });
const summaryOf = z.object({ digest: DigestSummarySchema });
const detailOf = z.object({ digest: DigestSchema });
const errorCode = async (response: Response) => z.object({ error: z.object({ code: z.string() }) }).parse(await response.json()).error.code;

async function upload(body: unknown, status = 201) {
  const response = await f.call("/api/v1/digests", "POST", body, bearer("omo"));
  expect(response.status).toBe(status);
  return saved.parse(await response.json());
}

test("An agent uploads a digest; the same upload again changes nothing and keeps its version and time", async () => {
  // Given: a morning digest with two article sections.
  const body = morning([articles("domestic", "Domestic", [article("a", "국내 첫 소식"), article("b", "국내 둘째 소식")]), articles("world", "World", [article("c", "해외 소식")])]);
  const first = await upload(body);
  expect(first).toMatchObject({ created: true, changed: ["domestic", "world"] });
  expect(first.digest).toMatchObject({ date: "2026-10-01", slot: "morning", version: 1, createdBy: "omo", readAt: null,
    scheduledAt: "2026-09-30T23:00:00.000Z" });
  expect(first.digest.sections.map(section => [section.key, section.title, section.kind])).toEqual([["domestic", "Domestic", "articles"], ["world", "World", "articles"]]);
  // When: the same body is sent again (a retry), and again after a restart.
  const replay = await upload(body, 200);
  f.restart();
  const afterRestart = await upload(body, 200);
  // Then: nothing changed and the stored digest is the first one.
  for (const result of [replay, afterRestart]) {
    expect(result).toMatchObject({ created: false, changed: [], notified: false });
    expect(result.digest).toEqual(first.digest);
  }
});

test("An upload replaces sections with the same key in place, keeps the others and appends new keys", async () => {
  // Given: two article sections arrived first.
  const first = await upload(morning([articles("domestic", "Domestic", [article("a", "국내 소식")]), articles("world", "World", [article("w", "해외 소식")])]));
  // When: messages arrive on their own, then the first section is corrected and retitled.
  const withMessages = await upload(morning([messages("inbox", "Inbox", [message("m1", "새 기기 접속 알림")])]), 200);
  const corrected = await upload(morning([articles("domestic", "Local news", [article("a", "국내 소식 (수정)")], { shortfall: "1건 부족" })]), 200);
  // Then: each upload changed only its section and bumped the version once; order stays, the new key went last.
  expect(withMessages).toMatchObject({ created: false, changed: ["inbox"] });
  expect(withMessages.digest.version).toBe(2);
  expect(withMessages.digest.sections.map(section => section.key)).toEqual(["domestic", "world", "inbox"]);
  expect(withMessages.digest.sections[0]).toEqual(first.digest.sections[0]);
  expect(corrected).toMatchObject({ changed: ["domestic"] });
  expect(corrected.digest.version).toBe(3);
  expect(corrected.digest.sections.map(section => [section.key, section.title])).toEqual([["domestic", "Local news"], ["world", "World"], ["inbox", "Inbox"]]);
  expect(corrected.digest.sections[0]).toMatchObject({ shortfall: "1건 부족", items: [{ title: "국내 소식 (수정)" }] });
});

test("Any registered agent uploads and reads digests; the owner gets 403, no credentials 401 and the public listener 404", async () => {
  const body = morning([articles("domestic", "Domestic", [article("a", "국내 소식")])]);
  expect((await f.call("/api/v1/digests", "POST", body)).status).toBe(401);
  expect((await f.call("/api/v1/digests", "POST", body, await f.login())).status).toBe(403);
  expect((await f.call("/api/v1/digests", "POST", body, bearer("omo"), true)).status).toBe(404);
  expect((await f.call("/api/v1/digests", "GET", undefined, bearer("omo"), true)).status).toBe(404);
  // And: nothing was stored by the refused calls.
  const listed = list.parse(await (await f.call("/api/v1/digests?from=2026-09-01&to=2026-10-31", "GET", undefined, await f.login())).json());
  expect(listed.items).toEqual([]);
  expect((await f.call("/api/v1/digests", "POST", body, bearer("codex"))).status).toBe(201);
  expect((await f.call("/api/v1/digests", "GET", undefined, bearer("chatgpt"))).status).toBe(200);
});

test("With DIGEST off every digest route answers 404", async () => {
  const off = fixture(10000, Date.now, { digestEnabled: false });
  try {
    const owner = await off.login();
    const id = crypto.randomUUID();
    expect((await off.call("/api/v1/digests", "POST", morning([articles("a", "A", [])]), bearer("omo"))).status).toBe(404);
    for (const path of ["/api/v1/digests", "/api/v1/digests/search?q=a", `/api/v1/digests/${id}`, `/api/v1/digests/${id}/narration`]) {
      const response = await off.call(path, "GET", undefined, owner);
      expect(response.status).toBe(404);
      expect(await errorCode(response)).toBe("feature_disabled");
    }
  } finally { off.close(); }
});

test("Malformed digests are refused before anything is written: unknown kind, duplicate or bad keys, empty sections", async () => {
  const ok = articles("domestic", "Domestic", [article("a", "소식")]);
  const cases: unknown[] = [
    morning([ok], { slot: "noon" }),
    morning([]),
    morning([articles("domestic", "Domestic", [article("a", "소식", { url: "javascript:alert(1)" })])]),
    morning([{ key: "weather", title: "Weather", kind: "forecast", items: [] }]),
    morning([ok, articles("domestic", "Again", [])]),
    morning([articles("Domestic", "Domestic", [])]),
    morning([articles("domestic", "", [])]),
    morning([articles("domestic", "Domestic", [message("m", "제목")])]),
    morning([messages("inbox", "Inbox", [message("m", "제목", "panic")])]),
    morning(Array.from({ length: 13 }, (_, index) => articles(`s${index}`, `S${index}`, []))),
  ];
  for (const body of cases) {
    const response = await f.call("/api/v1/digests", "POST", body, bearer("omo"));
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("invalid_input");
  }
  expect(list.parse(await (await f.call("/api/v1/digests?from=2026-09-01&to=2026-10-31", "GET", undefined, await f.login())).json()).items).toEqual([]);
});

test("A digest larger than the 32 KiB record limit is accepted", async () => {
  const items = Array.from({ length: 50 }, (_, index) => article(`k${index}`, `긴 소식 ${index}`, { summary: "가".repeat(400) }));
  const body = morning([articles("domestic", "Domestic", items)]);
  expect(new TextEncoder().encode(JSON.stringify(body)).byteLength).toBeGreaterThan(32768);
  const result = await upload(body);
  expect(result.digest.sections[0]?.items).toHaveLength(50);
});

test("The default scheduled time is the slot's time in the dashboard's time zone", async () => {
  const york = fixture(10000, Date.now, { timeZone: "America/New_York" });
  try {
    const post = async (slot: string) => saved.parse(await (await york.call("/api/v1/digests", "POST",
      { date: "2026-10-01", slot, sections: [articles("a", "A", [article("a", "소식")])] }, bearer("omo"))).json()).digest.scheduledAt;
    expect(await post("morning")).toBe("2026-10-01T12:00:00.000Z");
    expect(await post("evening")).toBe("2026-10-02T01:00:00.000Z");
    expect(await post("06:15")).toBe("2026-10-01T10:15:00.000Z");
  } finally { york.close(); }
});

test("The owner lists digests newest first, reads one, and marks it read until a new section arrives", async () => {
  // Given: yesterday evening, this morning and an extra 14:30 digest.
  const evening = await upload({ date: "2026-09-30", slot: "evening", sections: [articles("ai", "AI", [article("e", "저녁 AI 소식")])] });
  const am = await upload(morning([messages("inbox", "Inbox", [message("m1", "급한 메일", "urgent"), message("m2", "확인 메일")]),
    articles("domestic", "Domestic", [article("a", "아침 첫 소식"), article("b", "아침 둘째"), article("c", "셋째"), article("d", "넷째")]),
    articles("world", "World", [article("w", "해외 첫 소식")])]));
  const extra = await upload({ date: "2026-10-01", slot: "14:30", sections: [articles("world", "World", [article("x", "오후 해외 소식")])] });
  const owner = await f.login();
  // When: the owner lists the range.
  const listed = list.parse(await (await f.call("/api/v1/digests?from=2026-09-30&to=2026-10-01", "GET", undefined, owner)).json());
  // Then: newest scheduled first, with counts per key, round-robin headlines and the urgent count; the morning counts twice.
  expect(listed.items.map(item => [item.date, item.slot])).toEqual([["2026-10-01", "14:30"], ["2026-10-01", "morning"], ["2026-09-30", "evening"]]);
  expect(listed.items[1]).toMatchObject({ id: am.digest.id, counts: { inbox: 2, domestic: 4, world: 1 }, urgent: 1, todo: 0, readAt: null,
    headlines: ["아침 첫 소식", "해외 첫 소식", "아침 둘째"], messageHeadline: "급한 메일" });
  expect(listed.items[1]?.outline).toEqual([{ key: "inbox", title: "Inbox", kind: "messages", items: 2 },
    { key: "domestic", title: "Domestic", kind: "articles", items: 4 }, { key: "world", title: "World", kind: "articles", items: 1 }]);
  expect(listed).toMatchObject({ unread: 4, earliestDate: "2026-09-30", latestDate: "2026-10-01" });
  expect(extra.digest.scheduledAt).toBe("2026-10-01T05:30:00.000Z");
  // And: one digest reads in full; marking it read needs CSRF and lowers the unread count.
  const detail = detailOf.parse(await (await f.call(`/api/v1/digests/${evening.digest.id}`, "GET", undefined, owner)).json());
  expect(detail.digest.sections[0]?.items[0]).toMatchObject({ title: "저녁 AI 소식" });
  const { "X-CSRF-Token": _csrf, ...noCsrf } = owner;
  expect((await f.call(`/api/v1/digests/${am.digest.id}/read`, "POST", { read: true }, noCsrf)).status).toBe(403);
  const read = await f.call(`/api/v1/digests/${am.digest.id}/read`, "POST", { read: true }, owner);
  expect(read.status).toBe(200);
  expect(summaryOf.parse(await read.json()).digest.readAt).not.toBeNull();
  const after = list.parse(await (await f.call("/api/v1/digests?from=2026-09-30&to=2026-10-01", "GET", undefined, owner)).json());
  expect(after.unread).toBe(2);
  expect(after.parts).toEqual({ articles: { unread: 2, earliestDate: "2026-09-30" }, messages: { unread: 0, earliestDate: "2026-10-01" } });
  // When: a correction of a filled section keeps it read; a new section makes it unread again.
  await upload(morning([articles("domestic", "Domestic", [article("a", "아침 첫 소식 (수정)")])]), 200);
  expect(detailOf.parse(await (await f.call(`/api/v1/digests/${am.digest.id}`, "GET", undefined, owner)).json()).digest.readAt).not.toBeNull();
  await upload(morning([articles("ai", "AI", [article("z", "늦게 온 AI 소식")])]), 200);
  expect(detailOf.parse(await (await f.call(`/api/v1/digests/${am.digest.id}`, "GET", undefined, owner)).json()).digest.readAt).toBeNull();
  // And: the owner can mark it unread on purpose; an unknown id is 404.
  expect((await f.call(`/api/v1/digests/${evening.digest.id}/read`, "POST", { read: false }, owner)).status).toBe(200);
  expect((await f.call(`/api/v1/digests/${crypto.randomUUID()}`, "GET", undefined, owner)).status).toBe(404);
});

test("Articles and messages are read apart: reading the messages leaves the articles unread, and late messages make only that part unread", async () => {
  // Given: a morning with articles and messages, and an evening with articles only.
  const am = await upload(morning([articles("domestic", "Domestic", [article("a", "아침 소식")]),
    messages("inbox", "Inbox", [message("m1", "확인 메일"), message("m2", "할 일 메일", "todo"), message("m3", "급한 메일", "urgent")])]));
  const pm = await upload({ date: "2026-10-01", slot: "evening", sections: [articles("domestic", "Domestic", [article("e", "저녁 소식")])] });
  const owner = await f.login();
  const range = "/api/v1/digests?from=2026-10-01&to=2026-10-01";
  // Then: the morning is unread in both parts; the evening has no messages to read.
  expect(am.digest).toMatchObject({ articlesReadAt: null, messagesReadAt: null, readAt: null });
  expect(pm.digest.articlesReadAt).toBeNull();
  expect(pm.digest.messagesReadAt).not.toBeNull();
  const first = list.parse(await (await f.call(range, "GET", undefined, owner)).json());
  expect(first.parts).toEqual({ articles: { unread: 2, earliestDate: "2026-10-01" }, messages: { unread: 1, earliestDate: "2026-10-01" } });
  expect(first.unread).toBe(3);
  expect(first.items.find(item => item.id === am.digest.id)).toMatchObject({ messageHeadline: "급한 메일", urgent: 1, todo: 1 });
  // When: the owner reads the morning's messages.
  const readMessages = await f.call(`/api/v1/digests/${am.digest.id}/read`, "POST", { read: true, part: "messages" }, owner);
  expect(readMessages.status).toBe(200);
  expect(summaryOf.parse(await readMessages.json()).digest).toMatchObject({ articlesReadAt: null, readAt: null, messagesReadAt: expect.any(String) });
  expect(list.parse(await (await f.call(range, "GET", undefined, owner)).json()).parts).toMatchObject({ articles: { unread: 2 }, messages: { unread: 0 } });
  // When: the evening's articles are read, then messages arrive for the evening.
  await f.call(`/api/v1/digests/${pm.digest.id}/read`, "POST", { read: true, part: "articles" }, owner);
  const late = await upload({ date: "2026-10-01", slot: "evening", sections: [messages("inbox", "Inbox", [message("q", "늦은 메일")])] }, 200);
  // Then: only the evening's messages are unread; its articles stay read.
  expect(late.digest.articlesReadAt).not.toBeNull();
  expect(late.digest.messagesReadAt).toBeNull();
  expect(list.parse(await (await f.call(range, "GET", undefined, owner)).json()).parts).toMatchObject({ articles: { unread: 1 }, messages: { unread: 1 } });
  // When: a read without a part marks both parts; marking unread without a part leaves the empty one alone.
  const both = summaryOf.parse(await (await f.call(`/api/v1/digests/${am.digest.id}/read`, "POST", { read: true }, owner)).json()).digest;
  expect(both.articlesReadAt).not.toBeNull();
  expect(both.readAt).not.toBeNull();
  const fresh = await upload({ date: "2026-10-02", slot: "morning", sections: [articles("domestic", "Domestic", [article("n", "다음 날")])] });
  const unread = summaryOf.parse(await (await f.call(`/api/v1/digests/${fresh.digest.id}/read`, "POST", { read: false }, owner)).json()).digest;
  expect(unread.articlesReadAt).toBeNull();
  expect(unread.messagesReadAt).not.toBeNull();
  // And: an unknown part is refused.
  expect((await f.call(`/api/v1/digests/${am.digest.id}/read`, "POST", { read: true, part: "weather" }, owner)).status).toBe(400);
});

test("Search finds articles and messages across digests, newest first, and keeps to one part when asked", async () => {
  await upload({ date: "2026-09-30", slot: "evening", sections: [articles("domestic", "Domestic", [article("a", "반도체 수출 증가")])] });
  await upload(morning([messages("inbox", "Inbox", [message("m", "반도체 세미나 초대")]),
    articles("world", "World", [article("b", "Chip exports", { summary: "반도체 관세 이야기" })])]));
  await upload(morning([articles("domestic", "Domestic", [article("c", "날씨")])], { date: "2026-10-02" }));
  const owner = await f.login();
  const hits = z.object({ items: z.array(z.object({ digestId: z.string(), date: z.string(), section: z.string(), sectionTitle: z.string(), kind: z.string(),
    item: z.object({ key: z.string() }).passthrough() })) });
  const search = async (suffix: string) => hits.parse(await (await f.call(`/api/v1/digests/search?q=${encodeURIComponent("반도체")}${suffix}`, "GET", undefined, owner)).json())
    .items.map(hit => [hit.date, hit.section, hit.sectionTitle, hit.kind, hit.item.key]);
  expect(await search("")).toEqual([
    ["2026-10-01", "inbox", "Inbox", "messages", "m"], ["2026-10-01", "world", "World", "articles", "b"], ["2026-09-30", "domestic", "Domestic", "articles", "a"],
  ]);
  expect(await search("&part=articles")).toEqual([["2026-10-01", "world", "World", "articles", "b"], ["2026-09-30", "domestic", "Domestic", "articles", "a"]]);
  expect(await search("&part=messages")).toEqual([["2026-10-01", "inbox", "Inbox", "messages", "m"]]);
  expect((await f.call("/api/v1/digests/search?q=", "GET", undefined, owner)).status).toBe(400);
  expect((await f.call("/api/v1/digests/search?q=a&part=all", "GET", undefined, owner)).status).toBe(400);
});
