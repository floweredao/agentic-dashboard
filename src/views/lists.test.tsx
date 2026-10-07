import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DashboardRecordSchema, DigestSummarySchema } from "../../shared/contracts";
import { channelsFor, setChannelKeys } from "../model";
import { DashboardContext } from "../state";
import { fakeDashboard } from "../test-dashboard";
import { InboxPane } from "./Inbox";
import { LibraryPane } from "./Library";

afterEach(() => setChannelKeys(channelsFor([], [])));

const make = (id: string, patch: Record<string, unknown> = {}) => DashboardRecordSchema.parse({
  id,
  kind: "social",
  title: "기록",
  body: "",
  source: "manual",
  createdBy: "owner",
  reviewState: "approved",
  archivedAt: null,
  createdAt: "2026-09-20T00:00:00Z",
  updatedAt: "2026-09-20T00:00:00Z",
  version: 1,
  fields: {},
  ...patch,
});

const render = (records: readonly ReturnType<typeof make>[], view: "inbox" | "library", params: Readonly<Record<string, string>> = {}, id: string | null = null) =>
  renderToStaticMarkup(<DashboardContext.Provider value={fakeDashboard(records, { view, params, id })}>
    {view === "inbox" ? <InboxPane /> : <LibraryPane />}
  </DashboardContext.Provider>);

async function scan(markup: string, selector: string) {
  let count = 0;
  let text = "";
  await new HTMLRewriter().on(selector, {
    element() { count += 1; },
    text(chunk) { text += chunk.text; },
  }).transform(new Response(markup)).text();
  return { count, text };
}

test("LibraryPane shows a social record summary", async () => {
  // Given: a saved link with a generated summary.
  const records = [make("00000000-0000-4000-8000-000000000001", { fields: { summary: "요약 본문" } })];
  // When: the library list is rendered.
  const summary = await scan(render(records, "library"), ".row-summary");
  // Then: the summary is visible in the row preview.
  expect(summary).toEqual({ count: 1, text: "요약 본문" });
});

test("LibraryPane search matches one record summary", async () => {
  // Given: only one of two saved records contains the committed query in its summary.
  const records = [
    make("00000000-0000-4000-8000-000000000002", { title: "일치", fields: { summary: "검색용설명" } }),
    make("00000000-0000-4000-8000-000000000003", { title: "불일치", fields: { summary: "다른 설명" } }),
  ];
  // When: the library is rendered with the query parameter.
  const rows = await scan(render(records, "library", { q: "검색용설명" }), ".row");
  // Then: exactly one matching row is rendered.
  expect(rows.count).toBe(1);
});

test("InboxPane search lists only matching records, has no channel chips and offers to clear an empty search", async () => {
  // Given: records from OmO and direct entry; only the OmO one mentions the query in its body.
  const records = [
    make("00000000-0000-4000-8000-000000000004", { title: "OmO 항목", body: "검색어 포함", source: "omo", createdBy: "omo", reviewState: "pending" }),
    make("00000000-0000-4000-8000-000000000005", { title: "직접 항목" }),
  ];
  // When: the inbox is rendered with the committed query, and with one that matches nothing.
  const html = render(records, "inbox", { q: "검색어" });
  const none = render(records, "inbox", { q: "없는 말" });
  // Then: only the matching row remains, the field shows the query, there is no channel group, and an empty search can be cleared.
  expect(await scan(html, ".row-title")).toEqual({ count: 1, text: "미확인 OmO 항목" });
  expect(html).toMatch(/<input[^>]*aria-label="받은 항목 검색"[^>]*value="검색어"/);
  expect(html).not.toContain('aria-label="채널"');
  expect(none).toContain("검색 결과 없음");
  expect(none).toMatch(/<button[^>]*>검색 지우기<\/button>/);
});

test("InboxPane lists approved material under the default 전체 and omits it from 미확인", async () => {
  // Given: approved material with no revisit date.
  const records = [make("00000000-0000-4000-8000-000000000006", { fields: { summary: "확인 완료" } })];
  // When: the inbox is rendered with no filter and with 미확인.
  const html = render(records, "inbox");
  // Then: 전체 is pressed and lists it; 미확인 renders no row.
  expect((await scan(html, 'div[aria-label="확인 상태"] button[aria-pressed="true"]')).text).toBe("전체1");
  expect((await scan(html, ".row")).count).toBe(1);
  expect((await scan(render(records, "inbox", { state: "pending" }), ".row")).count).toBe(0);
});

test("InboxPane keeps an approved record listed only while it is the open one", async () => {
  // Given: a confirmed link that was opened from the inbox, and a newer pending link.
  const opened = make("00000000-0000-4000-8000-000000000009", { title: "확인한 항목", createdAt: "2026-09-19T00:00:00Z" });
  const records = [opened, make("00000000-0000-4000-8000-000000000010", { title: "새 항목", reviewState: "pending" })];
  // Then: with the confirmed link selected it keeps its row, in date order; without the selection only the pending row remains.
  expect(await scan(render(records, "inbox", { state: "pending" }, opened.id), ".row-title")).toEqual({ count: 2, text: "미확인 새 항목확인한 항목" });
  expect(await scan(render(records, "inbox", { state: "pending" }), ".row-title")).toEqual({ count: 1, text: "미확인 새 항목" });
});

test("InboxPane 확인함 lists confirmed records, presses its chip and counts each 확인 filter", async () => {
  // Given: one pending and two confirmed links.
  const records = [
    make("00000000-0000-4000-8000-000000000015", { title: "새 항목", reviewState: "pending" }),
    make("00000000-0000-4000-8000-000000000016", { title: "확인한 항목 1", createdAt: "2026-09-21T00:00:00Z" }),
    make("00000000-0000-4000-8000-000000000017", { title: "확인한 항목 2" }),
  ];
  const html = render(records, "inbox", { state: "approved" });
  // Then: only the confirmed rows show, 확인함 is pressed, and 전체/미확인/확인함 count 3/1/2.
  expect(await scan(html, ".row-title")).toEqual({ count: 2, text: "확인한 항목 1확인한 항목 2" });
  expect((await scan(html, 'div[aria-label="확인 상태"] button[aria-pressed="true"]')).text).toBe("확인함2");
  expect((await scan(html, 'div[aria-label="확인 상태"] .chip-count')).text).toBe("3120");
  expect((await scan(html, ".pane-title .count")).text).toBe("2");
});

test("InboxPane Favorites lists only unarchived starred records, counts them and says so when there are none", async () => {
  // Given: a pending favorite, a confirmed favorite, an archived favorite and a record that is not a favorite.
  const records = [
    make("00000000-0000-4000-8000-000000000018", { title: "즐겨찾기 1", reviewState: "pending", fields: { starred: true }, createdAt: "2026-09-21T00:00:00Z" }),
    make("00000000-0000-4000-8000-000000000019", { title: "즐겨찾기 2", fields: { starred: true } }),
    make("00000000-0000-4000-8000-000000000020", { title: "보관한 즐겨찾기", fields: { starred: true }, archivedAt: "2026-09-22T00:00:00Z" }),
    make("00000000-0000-4000-8000-000000000021", { title: "보통 기록" }),
  ];
  const html = render(records, "inbox", { state: "starred" });
  // Then: only the two live favorites show, newest first; Favorites is the pressed chip and counts 2; the title counts 2.
  expect(await scan(html, ".row-title")).toEqual({ count: 2, text: "미확인 즐겨찾기 1즐겨찾기 2" });
  expect((await scan(html, 'div[aria-label="확인 상태"] button[aria-pressed="true"]')).text).toBe("즐겨찾기2");
  expect((await scan(html, ".pane-title .count")).text).toBe("2");
  // And: without favorites the list says so in one line.
  expect(render([records[3]!], "inbox", { state: "starred" })).toContain("즐겨찾기한 항목 없음");
});

test("InboxPane lists a revisit-due approved row with a 다시 볼 날 chip and no unread mark", async () => {
  // Given: one approved link whose revisit date has passed and one pending link.
  const records = [
    make("00000000-0000-4000-8000-000000000007", { title: "다시 볼 글", fields: { revisitDate: "2026-01-01" } }),
    make("00000000-0000-4000-8000-000000000008", { title: "새 글", reviewState: "pending" }),
  ];
  const html = render(records, "inbox", { state: "pending" });
  // Then: both rows are queued, only the pending one reads 미확인, and the note counts one revisit.
  expect((await scan(html, ".row")).count).toBe(2);
  expect((await scan(html, ".row.unread")).count).toBe(1);
  expect((await scan(html, ".row-meta .tag")).text).toBe("다시 볼 날");
  expect((await scan(html, ".pane-note")).text).toBe("다시 볼 항목 1");
});

test("InboxPane mixes digests into the records by time, with unread marks, filter counts and no swipe", async () => {
  // Given: a pending link between an unread morning digest (newer) and a read evening digest (older).
  const brief = (id: string, patch: Record<string, unknown>) => DigestSummarySchema.parse({
    id, date: "2026-09-21", slot: "morning", scheduledAt: "2026-09-21T00:00:00Z", createdBy: "omo",
    createdAt: "2026-09-21T00:00:00Z", updatedAt: "2026-09-21T00:00:00Z", version: 1, articlesReadAt: null, messagesReadAt: null, readAt: null,
    counts: { inbox: 2, local: 2, ai: 7 }, outline: [{ key: "inbox", title: "Inbox", kind: "messages", items: 2 }, { key: "local", title: "Local", kind: "articles", items: 2 }, { key: "ai", title: "AI", kind: "articles", items: 7 }],
    headlines: ["첫 기사"], messageHeadline: "중요 메일", urgent: 0, todo: 0, ...patch,
  });
  const morning = brief("00000000-0000-4000-8000-000000000021", {});
  const evening = brief("00000000-0000-4000-8000-000000000022", { slot: "evening", scheduledAt: "2026-09-19T12:00:00Z",
    counts: { local: 1 }, outline: [{ key: "local", title: "Local", kind: "articles", items: 1 }], headlines: [], messageHeadline: "메일만",
    articlesReadAt: "2026-09-19T13:00:00Z", messagesReadAt: "2026-09-19T13:00:00Z" });
  const records = [make("00000000-0000-4000-8000-000000000023", { title: "새 항목", reviewState: "pending" })];
  const page = { items: [morning, evening], from: "2026-09-08", to: "2026-09-21", unread: 2, earliestDate: "2026-09-19", latestDate: "2026-09-21",
    parts: { articles: { unread: 1, earliestDate: "2026-09-19" }, messages: { unread: 1, earliestDate: "2026-09-21" } } };
  const inbox = (params: Record<string, string> = {}, id: string | null = null) =>
    renderToStaticMarkup(<DashboardContext.Provider value={fakeDashboard(records, { view: "inbox", params, id }, { digests: page })}>
      <InboxPane />
    </DashboardContext.Provider>);
  // When: the inbox is rendered under 전체.
  const html = inbox();
  // Then: rows run newest first across both kinds, only the morning digest and the link read 미확인, and digest rows have no swipe layer.
  expect((await scan(html, ".row-title")).text).toBe("미확인 아침 다이제스트미확인 새 항목저녁 다이제스트");
  expect((await scan(html, ".row.unread")).count).toBe(2);
  expect((await scan(html, ".swipe")).count).toBe(1);
  expect((await scan(html, `#row-${morning.id} .row-summary`)).text).toBe("첫 기사");
  expect((await scan(html, `#row-${morning.id} .row-meta`)).text).toBe("다이제스트 · Inbox 2 · Local 2 · AI 7");
  expect((await scan(html, `#row-${evening.id} .row-summary`)).text).toBe("메일만");
  expect(html).toContain(`href="#/inbox/${morning.id}"`);
  // And: 전체/미확인/확인함 count 3/2/1 and the title counts the current list.
  expect((await scan(html, 'div[aria-label="확인 상태"] .chip-count')).text).toBe("3210");
  expect((await scan(html, ".pane-title .count")).text).toBe("3");
  // And: 미확인 drops the read evening unless it is the open one; the search reaches digest headlines.
  expect((await scan(inbox({ state: "pending" }), ".row")).count).toBe(2);
  expect((await scan(inbox({ state: "pending" }, evening.id), ".row-title")).text).toBe("미확인 아침 다이제스트미확인 새 항목저녁 다이제스트");
  expect((await scan(inbox({ q: "첫 기사" }), ".row-title")).text).toBe("미확인 아침 다이제스트");
});

test("InboxPane starts digest and record rows with their category tile without changing LibraryPane rows", async () => {
  // Given: an unread digest and a record waiting in the inbox.
  const digest = DigestSummarySchema.parse({
    id: "00000000-0000-4000-8000-000000000031", date: "2026-09-21", slot: "morning", scheduledAt: "2026-09-21T00:00:00Z", createdBy: "omo",
    createdAt: "2026-09-21T00:00:00Z", updatedAt: "2026-09-21T00:00:00Z", version: 1, articlesReadAt: null, messagesReadAt: null, readAt: null,
    counts: { local: 1 }, outline: [{ key: "local", title: "Local", kind: "articles", items: 1 }], headlines: ["기사"], messageHeadline: "", urgent: 0, todo: 0,
  });
  const page = { items: [digest], from: "2026-09-08", to: "2026-09-21", unread: 1, earliestDate: "2026-09-21", latestDate: "2026-09-21",
    parts: { articles: { unread: 1, earliestDate: "2026-09-21" }, messages: { unread: 0, earliestDate: null } } };
  const record = make("00000000-0000-4000-8000-000000000032", { reviewState: "pending" });
  // When: the inbox and the library are rendered.
  const inbox = renderToStaticMarkup(<DashboardContext.Provider value={fakeDashboard([record], { view: "inbox" }, { digests: page })}>
    <InboxPane />
  </DashboardContext.Provider>);
  const library = render([record], "library");
  // Then: each inbox row leads with the tile of its tab (digest, library) and library rows have none.
  expect((await scan(inbox, ".row > .row-kind-icon.kind-digest")).count).toBe(1);
  expect((await scan(inbox, ".row > .row-kind-icon.kind-record")).count).toBe(1);
  expect((await scan(library, ".row-kind-icon")).count).toBe(0);
});

test("an empty filter combination keeps every active chip and offers to clear all conditions", async () => {
  // Given: a starred ChatGPT link exists, but the owner also asks for reports only.
  const records = [make("00000000-0000-4000-8000-000000000011", { source: "chatgpt", createdBy: "chatgpt", fields: { starred: true } })];
  setChannelKeys(channelsFor([], records));
  const html = render(records, "library", { starred: "1", type: "research", channel: "chatgpt" });
  // Then: the ChatGPT chip is still visible and pressed, and the empty state clears everything at once.
  const pressed = await scan(html, 'button.chip[aria-pressed="true"]');
  expect(pressed.text).toContain("chatgpt");
  expect(html).toMatch(/<button[^>]*>조건 모두 지우기<\/button>/);
});

test("library chip counts follow the committed search, and the search field can be cleared", async () => {
  // Given: three links, one of which matches the query.
  const records = [
    make("00000000-0000-4000-8000-000000000012", { title: "알파 문서" }),
    make("00000000-0000-4000-8000-000000000013", { title: "베타" }),
    make("00000000-0000-4000-8000-000000000014", { title: "감마" }),
  ];
  const html = render(records, "library", { q: "알파" });
  // Then: 전체 and 링크 count the one search result, not the whole library (전체, 조사, 작업, 링크, 메모).
  const counts = await scan(html, 'div[aria-label="기록 종류"] .chip-count');
  expect(counts.text).toBe("10010");
  // And: the kind chips are named without 보고.
  expect((await scan(html, 'div[aria-label="기록 종류"] button.chip')).text).toBe("전체1조사0작업0링크1메모0");
  expect(html).toContain('aria-label="검색어 지우기"');
});
