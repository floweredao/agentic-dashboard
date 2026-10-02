import { afterAll, afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { z } from "zod";
import { BriefingSchema, BriefingSummarySchema } from "../shared/contracts";
import { bearer, fixture } from "./backend-helper";

let f = fixture();
afterEach(() => { f.close(); f = fixture(); });
afterAll(() => f.close());

const article = (key: string, title: string, extra: Record<string, unknown> = {}) => ({
  key, title, source: "연합뉴스", summary: `${title} 요약.`, url: `https://news.example.com/${key}`, ...extra,
});
const mail = (key: string, subject: string, importance = "check") => ({
  key, importance, from: "KT", address: "noreply@kt.example", subject, summary: `${subject} 요약.`, action: "본인 접속인지 확인하세요.",
  url: "https://mail.example.com/read/1",
});
const morning = (sections: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  date: "2026-10-01", slot: "morning", sections, ...extra,
});
const saved = z.object({ briefing: BriefingSchema, created: z.boolean(), changed: z.array(z.string()), notified: z.boolean() });
const partTotals = z.object({ unread: z.number(), earliestDate: z.string().nullable() }).strict();
const list = z.object({ items: z.array(BriefingSummarySchema), unread: z.number(), earliestDate: z.string().nullable(), latestDate: z.string().nullable(),
  parts: z.object({ news: partTotals, mail: partTotals }).strict() });
const errorCode = async (response: Response) => z.object({ error: z.object({ code: z.string() }) }).parse(await response.json()).error.code;

async function upload(body: unknown, status = 201) {
  const response = await f.call("/api/v1/briefings", "POST", body, bearer("omo"));
  expect(response.status).toBe(status);
  return saved.parse(await response.json());
}

test("OmO uploads a briefing; the same upload again changes nothing and keeps its version and time", async () => {
  // Given: a morning briefing with two news sections.
  const body = morning({ domestic: { items: [article("a", "국내 첫 소식"), article("b", "국내 둘째 소식")] }, international: { items: [article("c", "해외 소식")] } });
  const first = await upload(body);
  expect(first).toMatchObject({ created: true, changed: ["domestic", "international"] });
  expect(first.briefing).toMatchObject({ date: "2026-10-01", slot: "morning", version: 1, createdBy: "omo", readAt: null,
    scheduledAt: "2026-09-30T23:00:00.000Z" });
  // When: the same body is sent again (a retry), and again after a restart.
  const replay = await upload(body, 200);
  f.restart();
  const afterRestart = await upload(body, 200);
  // Then: nothing changed and the stored briefing is the first one.
  for (const result of [replay, afterRestart]) {
    expect(result).toMatchObject({ created: false, changed: [], notified: false });
    expect(result.briefing).toEqual(first.briefing);
  }
});

test("A later upload fills a missing section and keeps the sections it leaves out", async () => {
  // Given: the news arrived first.
  const first = await upload(morning({ domestic: { items: [article("a", "국내 소식")] } }));
  // When: mail arrives on its own, then the domestic section is corrected.
  const withMail = await upload(morning({ mail: { items: [mail("m1", "새 기기 접속 알림")] } }), 200);
  const corrected = await upload(morning({ domestic: { items: [article("a", "국내 소식 (수정)")], shortfall: "1건 부족" } }), 200);
  // Then: each upload changed only its section, bumped the version once, and the other section stayed.
  expect(withMail).toMatchObject({ created: false, changed: ["mail"] });
  expect(withMail.briefing.version).toBe(2);
  expect(withMail.briefing.sections.domestic).toEqual(first.briefing.sections.domestic);
  expect(corrected).toMatchObject({ changed: ["domestic"] });
  expect(corrected.briefing.version).toBe(3);
  expect(corrected.briefing.sections.mail?.items.map(item => item.subject)).toEqual(["새 기기 접속 알림"]);
  expect(corrected.briefing.sections.domestic).toMatchObject({ shortfall: "1건 부족", items: [{ title: "국내 소식 (수정)" }] });
});

test("Any registered agent uploads and reads briefings; the owner gets 403, no credentials 401 and the public listener 404", async () => {
  const body = morning({ domestic: { items: [article("a", "국내 소식")] } });
  expect((await f.call("/api/v1/briefings", "POST", body)).status).toBe(401);
  expect((await f.call("/api/v1/briefings", "POST", body, await f.login())).status).toBe(403);
  expect((await f.call("/api/v1/briefings", "POST", body, bearer("omo"), true)).status).toBe(404);
  expect((await f.call("/api/v1/briefings", "GET", undefined, bearer("omo"), true)).status).toBe(404);
  // And: nothing was stored by the refused calls.
  const listed = list.parse(await (await f.call("/api/v1/briefings?from=2026-09-01&to=2026-10-31", "GET", undefined, await f.login())).json());
  expect(listed.items).toEqual([]);
  expect((await f.call("/api/v1/briefings", "POST", body, bearer("codex"))).status).toBe(201);
  expect((await f.call("/api/v1/briefings", "GET", undefined, bearer("chatgpt"))).status).toBe(200);
});

test("Malformed briefings are refused before anything is written", async () => {
  const cases: [unknown, string][] = [
    [morning({ domestic: { items: [article("a", "소식")] } }, { slot: "noon" }), "invalid_input"],
    [morning({}), "invalid_input"],
    [morning({ domestic: { items: [article("a", "소식", { url: "javascript:alert(1)" })] } }), "invalid_input"],
    [morning({ weather: { items: [] } }), "invalid_input"],
    [morning({ mail: { items: [mail("m", "제목", "panic")] } }), "invalid_input"],
  ];
  for (const [body, code] of cases) {
    const response = await f.call("/api/v1/briefings", "POST", body, bearer("omo"));
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe(code);
  }
});

test("A briefing larger than the 32 KiB record limit is accepted", async () => {
  const items = Array.from({ length: 50 }, (_, index) => article(`k${index}`, `긴 소식 ${index}`, { summary: "가".repeat(400) }));
  const body = morning({ domestic: { items } });
  expect(new TextEncoder().encode(JSON.stringify(body)).byteLength).toBeGreaterThan(32768);
  const result = await upload(body);
  expect(result.briefing.sections.domestic?.items).toHaveLength(50);
});

test("The owner lists briefings newest first, reads one, and marks it read until a new section arrives", async () => {
  // Given: yesterday evening, this morning and an extra 14:30 briefing.
  const evening = await upload({ date: "2026-09-30", slot: "evening", sections: { aiDevelopment: { items: [article("e", "저녁 AI 소식")] } } });
  const am = await upload(morning({ domestic: { items: [article("a", "아침 첫 소식"), article("b", "아침 둘째"), article("c", "셋째"), article("d", "넷째")] },
    mail: { items: [mail("m1", "급한 메일", "urgent"), mail("m2", "확인 메일")] } }));
  const extra = await upload({ date: "2026-10-01", slot: "14:30", sections: { international: { items: [article("x", "오후 해외 소식")] } } });
  const owner = await f.login();
  // When: the owner lists the range.
  const listed = list.parse(await (await f.call("/api/v1/briefings?from=2026-09-30&to=2026-10-01", "GET", undefined, owner)).json());
  // Then: newest scheduled first, with counts, the first headlines and the urgent mail count; all three unread
  // (the morning twice: its news and its mail).
  expect(listed.items.map(item => [item.date, item.slot])).toEqual([["2026-10-01", "14:30"], ["2026-10-01", "morning"], ["2026-09-30", "evening"]]);
  expect(listed.items[1]).toMatchObject({ id: am.briefing.id, counts: { mail: 2, domestic: 4 }, urgent: 1, todo: 0, readAt: null,
    headlines: ["아침 첫 소식", "아침 둘째", "셋째"], mailHeadline: "급한 메일" });
  expect(listed).toMatchObject({ unread: 4, earliestDate: "2026-09-30", latestDate: "2026-10-01" });
  expect(extra.briefing.scheduledAt).toBe("2026-10-01T05:30:00.000Z");
  // And: one briefing reads in full; marking it read needs CSRF and lowers the unread count.
  const detail = z.object({ briefing: BriefingSchema }).parse(await (await f.call(`/api/v1/briefings/${evening.briefing.id}`, "GET", undefined, owner)).json());
  expect(detail.briefing.sections.aiDevelopment?.items[0]?.title).toBe("저녁 AI 소식");
  const { "X-CSRF-Token": _csrf, ...noCsrf } = owner;
  expect((await f.call(`/api/v1/briefings/${am.briefing.id}/read`, "POST", { read: true }, noCsrf)).status).toBe(403);
  const read = await f.call(`/api/v1/briefings/${am.briefing.id}/read`, "POST", { read: true }, owner);
  expect(read.status).toBe(200);
  expect(z.object({ briefing: BriefingSummarySchema }).parse(await read.json()).briefing.readAt).not.toBeNull();
  const after = list.parse(await (await f.call("/api/v1/briefings?from=2026-09-30&to=2026-10-01", "GET", undefined, owner)).json());
  expect(after.unread).toBe(2);
  expect(after.parts).toEqual({ news: { unread: 2, earliestDate: "2026-09-30" }, mail: { unread: 0, earliestDate: "2026-10-01" } });
  // When: a section that was missing arrives, the briefing is unread again; a correction of a filled one keeps it read.
  await upload(morning({ domestic: { items: [article("a", "아침 첫 소식 (수정)")] } }), 200);
  const corrected = z.object({ briefing: BriefingSchema }).parse(await (await f.call(`/api/v1/briefings/${am.briefing.id}`, "GET", undefined, owner)).json());
  expect(corrected.briefing.readAt).not.toBeNull();
  await upload(morning({ aiDevelopment: { items: [article("z", "늦게 온 AI 소식")] } }), 200);
  const refilled = z.object({ briefing: BriefingSchema }).parse(await (await f.call(`/api/v1/briefings/${am.briefing.id}`, "GET", undefined, owner)).json());
  expect(refilled.briefing.readAt).toBeNull();
  // And: the owner can mark it unread on purpose; an unknown id is 404.
  expect((await f.call(`/api/v1/briefings/${evening.briefing.id}/read`, "POST", { read: false }, owner)).status).toBe(200);
  expect((await f.call(`/api/v1/briefings/${crypto.randomUUID()}`, "GET", undefined, owner)).status).toBe(404);
});

test("Search finds articles and mail across briefings, newest first", async () => {
  await upload({ date: "2026-09-30", slot: "evening", sections: { domestic: { items: [article("a", "반도체 수출 증가")] } } });
  await upload(morning({ international: { items: [article("b", "Chip exports", { summary: "반도체 관세 이야기" })] },
    mail: { items: [mail("m", "반도체 세미나 초대")] } }));
  await upload(morning({ domestic: { items: [article("c", "날씨")] } }, { date: "2026-10-02" }));
  const owner = await f.login();
  const response = await f.call(`/api/v1/briefings/search?q=${encodeURIComponent("반도체")}`, "GET", undefined, owner);
  expect(response.status).toBe(200);
  const result = z.object({ items: z.array(z.object({ briefingId: z.string(), date: z.string(), slot: z.string(), section: z.string(),
    item: z.object({ key: z.string() }).passthrough() })) }).parse(await response.json());
  expect(result.items.map(hit => [hit.date, hit.section, hit.item.key])).toEqual([
    ["2026-10-01", "mail", "m"], ["2026-10-01", "international", "b"], ["2026-09-30", "domestic", "a"],
  ]);
  expect((await f.call("/api/v1/briefings/search?q=", "GET", undefined, owner)).status).toBe(400);
});

const summaryOf = z.object({ briefing: BriefingSummarySchema });
const detailOf = z.object({ briefing: BriefingSchema });

test("News and mail are read apart: reading the mail leaves the news unread, and late mail makes only the mail unread again", async () => {
  // Given: a morning with news and mail, and an evening with news only.
  const am = await upload(morning({ domestic: { items: [article("a", "아침 소식")] },
    mail: { items: [mail("m1", "확인 메일"), mail("m2", "할 일 메일", "todo"), mail("m3", "급한 메일", "urgent")] } }));
  const pm = await upload({ date: "2026-10-01", slot: "evening", sections: { domestic: { items: [article("e", "저녁 소식")] } } });
  const owner = await f.login();
  const range = "/api/v1/briefings?from=2026-10-01&to=2026-10-01";
  // Then: the morning is unread in both parts; the evening has no mail to read.
  expect(am.briefing).toMatchObject({ newsReadAt: null, mailReadAt: null, readAt: null });
  expect(pm.briefing.newsReadAt).toBeNull();
  expect(pm.briefing.mailReadAt).not.toBeNull();
  const first = list.parse(await (await f.call(range, "GET", undefined, owner)).json());
  expect(first.parts).toEqual({ news: { unread: 2, earliestDate: "2026-10-01" }, mail: { unread: 1, earliestDate: "2026-10-01" } });
  expect(first.unread).toBe(3);
  expect(first.items.find(item => item.id === am.briefing.id)).toMatchObject({ mailHeadline: "급한 메일", urgent: 1, todo: 1 });
  // When: the owner reads the morning's mail.
  const readMail = await f.call(`/api/v1/briefings/${am.briefing.id}/read`, "POST", { read: true, part: "mail" }, owner);
  expect(readMail.status).toBe(200);
  // Then: its mail is read, its news is not, and the briefing as a whole is not read yet.
  expect(summaryOf.parse(await readMail.json()).briefing).toMatchObject({ newsReadAt: null, readAt: null, mailReadAt: expect.any(String) });
  expect(list.parse(await (await f.call(range, "GET", undefined, owner)).json()).parts).toMatchObject({ news: { unread: 2 }, mail: { unread: 0 } });
  // When: the evening's news is read, then mail arrives for the evening.
  await f.call(`/api/v1/briefings/${pm.briefing.id}/read`, "POST", { read: true, part: "news" }, owner);
  const late = await upload({ date: "2026-10-01", slot: "evening", sections: { mail: { items: [mail("q", "늦은 메일")] } } }, 200);
  // Then: only the evening's mail is unread; its news stays read.
  expect(late.briefing.newsReadAt).not.toBeNull();
  expect(late.briefing.mailReadAt).toBeNull();
  expect(list.parse(await (await f.call(range, "GET", undefined, owner)).json()).parts).toMatchObject({ news: { unread: 1 }, mail: { unread: 1 } });
  // When: a read without a part (the old call) marks both parts; marking unread without a part leaves the empty one alone.
  const both = summaryOf.parse(await (await f.call(`/api/v1/briefings/${am.briefing.id}/read`, "POST", { read: true }, owner)).json()).briefing;
  expect(both.newsReadAt).not.toBeNull();
  expect(both.readAt).not.toBeNull();
  const fresh = await upload({ date: "2026-10-02", slot: "morning", sections: { domestic: { items: [article("n", "다음 날")] } } });
  const unread = summaryOf.parse(await (await f.call(`/api/v1/briefings/${fresh.briefing.id}/read`, "POST", { read: false }, owner)).json()).briefing;
  expect(unread.newsReadAt).toBeNull();
  expect(unread.mailReadAt).not.toBeNull();
  // And: an unknown part is refused.
  expect((await f.call(`/api/v1/briefings/${am.briefing.id}/read`, "POST", { read: true, part: "weather" }, owner)).status).toBe(400);
});

test("Search keeps to one part when asked: news finds articles only, mail finds mail only", async () => {
  await upload(morning({ domestic: { items: [article("a", "반도체 수출")] }, mail: { items: [mail("m", "반도체 세미나")] } }));
  const owner = await f.login();
  const keys = async (part: string) => z.object({ items: z.array(z.object({ section: z.string() }).passthrough()) })
    .parse(await (await f.call(`/api/v1/briefings/search?q=${encodeURIComponent("반도체")}${part}`, "GET", undefined, owner)).json()).items.map(hit => hit.section);
  expect(await keys("")).toEqual(["mail", "domestic"]);
  expect(await keys("&part=news")).toEqual(["domestic"]);
  expect(await keys("&part=mail")).toEqual(["mail"]);
  expect((await f.call("/api/v1/briefings/search?q=a&part=all", "GET", undefined, owner)).status).toBe(400);
});

test("A database from before the split keeps each briefing's read state for both parts", async () => {
  // Given: the old table with one read briefing (news and mail) and one unread news-only briefing.
  const db = new Database(f.options.databasePath);
  const at = "2026-10-01T00:00:00.000Z";
  const section = (items: unknown[]) => ({ items, shortfall: null, updatedAt: at });
  db.exec(`DROP TABLE briefings; CREATE TABLE briefings(id TEXT PRIMARY KEY, date TEXT NOT NULL, slot TEXT NOT NULL, scheduled_at TEXT NOT NULL,
    sections TEXT NOT NULL CHECK(json_valid(sections)), created_by TEXT NOT NULL REFERENCES principals(id), created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, version INTEGER NOT NULL, read_at TEXT, UNIQUE(date, slot))`);
  const insert = db.query("INSERT INTO briefings VALUES(?,?,?,?,?,?,?,?,?,?)");
  const read = crypto.randomUUID();
  const unread = crypto.randomUUID();
  const parsedMail = { key: "m", importance: "check", from: "KT", address: "", subject: "메일", summary: "", action: "", url: null, merged: 1 };
  const parsedArticle = { key: "a", title: "소식", source: "", summary: "", url: "https://news.example.com/a", originalUrl: null, publishedAt: null, publishedDate: null };
  insert.run(read, "2026-10-01", "morning", "2026-09-30T23:00:00.000Z", JSON.stringify({ mail: section([parsedMail]), domestic: section([parsedArticle]) }), "omo", at, at, 1, "2026-10-01T01:00:00.000Z");
  insert.run(unread, "2026-10-01", "evening", "2026-10-01T12:00:00.000Z", JSON.stringify({ domestic: section([parsedArticle]) }), "omo", at, at, 1, null);
  db.close();
  // When: the server starts on it (twice, as a restart would).
  f.restart();
  f.restart();
  const owner = await f.login();
  const get = async (id: string) => detailOf.parse(await (await f.call(`/api/v1/briefings/${id}`, "GET", undefined, owner)).json()).briefing;
  // Then: the read one is read in both parts; the unread one is unread news with no mail waiting.
  expect(await get(read)).toMatchObject({ newsReadAt: "2026-10-01T01:00:00.000Z", mailReadAt: "2026-10-01T01:00:00.000Z", readAt: "2026-10-01T01:00:00.000Z" });
  expect(await get(unread)).toMatchObject({ newsReadAt: null, mailReadAt: at, readAt: null });
  const listed = list.parse(await (await f.call("/api/v1/briefings?from=2026-10-01&to=2026-10-01", "GET", undefined, owner)).json());
  expect(listed.parts).toEqual({ news: { unread: 1, earliestDate: "2026-10-01" }, mail: { unread: 0, earliestDate: "2026-10-01" } });
});
