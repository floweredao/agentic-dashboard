import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DashboardRecordSchema, DigestSummarySchema } from "../../shared/contracts";
import { DashboardContext } from "../state";
import { fakeDashboard } from "../test-dashboard";
import { LibraryPane } from "./Library";

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

const render = (records: readonly ReturnType<typeof make>[], params: Readonly<Record<string, string>> = {}, id: string | null = null) =>
  renderToStaticMarkup(<DashboardContext.Provider value={fakeDashboard(records, { view: "library", params, id })}>
    <LibraryPane />
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
  const summary = await scan(render(records), ".row-summary");
  // Then: the summary is visible in the row preview.
  expect(summary).toEqual({ count: 1, text: "요약 본문" });
});

test("LibraryPane has the search and the four state chips only: no kind, channel or topic chips", async () => {
  // Given: research and a link from different channels, with tags.
  const records = [
    make("00000000-0000-4000-8000-000000000041", { kind: "research", source: "omo", createdBy: "omo", tags: ["창업"], body: "본문",
      fields: { summary: "요약", conclusion: "결론", nextActions: "- 없음" } }),
    make("00000000-0000-4000-8000-000000000042", { source: "chatgpt", createdBy: "chatgpt", tags: ["창업"] }),
  ];
  const html = render(records);
  // Then: one chip group, 기록 상태, reads 전체 2 · 미확인 0 · 즐겨찾기 0 · 보관됨 0, and nothing names a kind or a channel.
  expect((await scan(html, 'div[role="group"]')).count).toBe(1);
  expect((await scan(html, 'div[aria-label="기록 상태"] button.chip')).text).toBe("전체2미확인0즐겨찾기0보관됨0");
  expect(html).not.toContain('aria-label="기록 종류"');
  expect(html).not.toContain('aria-label="채널"');
  expect(html).toMatch(/<input[^>]*aria-label="기록 검색"/);
});

test("LibraryPane search lists only matching records and offers to clear an empty search", async () => {
  // Given: records from OmO and direct entry; only the OmO one mentions the query in its body.
  const records = [
    make("00000000-0000-4000-8000-000000000004", { title: "OmO 항목", body: "검색어 포함", source: "omo", createdBy: "omo", reviewState: "pending" }),
    make("00000000-0000-4000-8000-000000000005", { title: "직접 항목" }),
  ];
  // When: the list is rendered with the committed query, and with one that matches nothing.
  const html = render(records, { q: "검색어" });
  const none = render(records, { q: "없는 말" });
  // Then: only the matching row remains, the field shows the query, chip counts follow the search, and an empty search can be cleared.
  expect(await scan(html, ".row-title")).toEqual({ count: 1, text: "미확인 OmO 항목" });
  expect(html).toMatch(/<input[^>]*aria-label="기록 검색"[^>]*value="검색어"/);
  expect((await scan(html, 'div[aria-label="기록 상태"] .chip-count')).text).toBe("1100");
  expect(none).toContain("검색 결과 없음");
  expect(none).toMatch(/<button[^>]*>검색 지우기<\/button>/);
  expect(html).toContain('aria-label="검색어 지우기"');
});

test("LibraryPane lists approved material under the default 전체 and omits it from 미확인", async () => {
  const records = [make("00000000-0000-4000-8000-000000000006", { fields: { summary: "확인 완료" } })];
  const html = render(records);
  expect((await scan(html, 'div[aria-label="기록 상태"] button[aria-pressed="true"]')).text).toBe("전체1");
  expect((await scan(html, ".row")).count).toBe(1);
  expect((await scan(render(records, { state: "pending" }), ".row")).count).toBe(0);
  expect(render(records, { state: "pending" })).toContain("확인할 기록 없음");
});

test("LibraryPane 미확인 keeps an approved record listed only while it is the open one", async () => {
  const opened = make("00000000-0000-4000-8000-000000000009", { title: "확인한 항목", createdAt: "2026-09-19T00:00:00Z" });
  const records = [opened, make("00000000-0000-4000-8000-000000000010", { title: "새 항목", reviewState: "pending" })];
  expect(await scan(render(records, { state: "pending" }, opened.id), ".row-title")).toEqual({ count: 2, text: "미확인 새 항목확인한 항목" });
  expect(await scan(render(records, { state: "pending" }), ".row-title")).toEqual({ count: 1, text: "미확인 새 항목" });
});

test("LibraryPane 즐겨찾기 lists only unarchived favorite records, counts them and says so when there are none", async () => {
  const records = [
    make("00000000-0000-4000-8000-000000000018", { title: "즐겨찾기 1", reviewState: "pending", fields: { starred: true }, createdAt: "2026-09-21T00:00:00Z" }),
    make("00000000-0000-4000-8000-000000000019", { title: "즐겨찾기 2", fields: { starred: true } }),
    make("00000000-0000-4000-8000-000000000020", { title: "보관한 즐겨찾기", fields: { starred: true }, archivedAt: "2026-09-22T00:00:00Z" }),
    make("00000000-0000-4000-8000-000000000021", { title: "보통 기록" }),
  ];
  const html = render(records, { state: "starred" });
  expect(await scan(html, ".row-title")).toEqual({ count: 2, text: "미확인 즐겨찾기 1즐겨찾기 2" });
  expect((await scan(html, 'div[aria-label="기록 상태"] button[aria-pressed="true"]')).text).toBe("즐겨찾기2");
  expect((await scan(html, ".pane-title .count")).text).toBe("2");
  expect(render([records[3]!], { state: "starred" })).toContain("즐겨찾기한 기록 없음");
});

test("LibraryPane 보관됨 lists archived records of every kind, latest first, and leaves live ones out", async () => {
  const records = [
    make("00000000-0000-4000-8000-000000000051", { kind: "task", title: "끝난 업무", status: "done", archivedAt: "2026-09-20T00:00:00Z" }),
    make("00000000-0000-4000-8000-000000000052", { kind: "note", title: "보관한 메모", archivedAt: "2026-09-21T00:00:00Z" }),
    make("00000000-0000-4000-8000-000000000053", { title: "살아 있는 링크" }),
  ];
  const html = render(records, { state: "archived" });
  expect(await scan(html, ".row-title")).toEqual({ count: 2, text: "보관한 메모끝난 업무" });
  expect((await scan(html, ".pane-title .count")).text).toBe("2");
  expect((await scan(html, 'div[aria-label="기록 상태"] button[aria-pressed="true"]')).text).toBe("보관됨2");
  expect(render([records[2]!], { state: "archived" })).toContain("보관한 항목 없음");
});

test("LibraryPane lists a revisit-due approved row under 미확인 with a 다시 볼 날 chip and no unread mark", async () => {
  const records = [
    make("00000000-0000-4000-8000-000000000007", { title: "다시 볼 글", fields: { revisitDate: "2026-01-01" } }),
    make("00000000-0000-4000-8000-000000000008", { title: "새 글", reviewState: "pending" }),
  ];
  const html = render(records, { state: "pending" });
  expect((await scan(html, ".row")).count).toBe(2);
  expect((await scan(html, ".row.unread")).count).toBe(1);
  expect((await scan(html, ".row-meta .tag")).text).toBe("다시 볼 날");
  expect((await scan(html, ".pane-note")).text).toBe("다시 볼 기록 1");
});

test("LibraryPane folds a continued record under the latest one with 이어진 기록 N, and unfolds while an earlier one is open", async () => {
  // Given: a chain of three records (the newest continues the middle, which continues the oldest) and a lone record.
  const first = make("00000000-0000-4000-8000-000000000061", { title: "첫 기록", createdAt: "2026-09-17T00:00:00Z" });
  const second = make("00000000-0000-4000-8000-000000000062", { title: "둘째 기록", fields: { previousId: first.id }, createdAt: "2026-09-18T00:00:00Z" });
  const third = make("00000000-0000-4000-8000-000000000063", { title: "셋째 기록", fields: { previousId: second.id }, createdAt: "2026-09-20T00:00:00Z" });
  const lone = make("00000000-0000-4000-8000-000000000064", { title: "따로 기록", createdAt: "2026-09-19T00:00:00Z" });
  const records = [first, second, third, lone];
  const html = render(records);
  // Then: under 전체 only the newest of the chain and the lone record have rows, the chain's toggle reads 이어진 기록 2, folded.
  expect(await scan(html, ".row-title")).toEqual({ count: 2, text: "셋째 기록따로 기록" });
  expect((await scan(html, ".thread-button")).text).toBe("이어진 기록 2");
  expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*>/);
  // And: the title still counts every record; with an earlier record open, the chain shows unfolded.
  expect((await scan(html, ".pane-title .count")).text).toBe("4");
  expect((await scan(render(records, {}, first.id), ".row-title")).text).toBe("셋째 기록둘째 기록첫 기록따로 기록");
  // And: a search or another state lists each record on its own row.
  expect((await scan(render(records, { q: "기록" }), ".row")).count).toBe(4);
});

test("LibraryPane lists records only: digests stay in the Digest tab, out of its rows and counts", async () => {
  // Given: a pending link and an unread morning digest (newer than the link).
  const morning = DigestSummarySchema.parse({
    id: "00000000-0000-4000-8000-000000000021", date: "2026-09-21", slot: "morning", scheduledAt: "2026-09-21T00:00:00Z", createdBy: "omo",
    createdAt: "2026-09-21T00:00:00Z", updatedAt: "2026-09-21T00:00:00Z", version: 1, articlesReadAt: null, messagesReadAt: null, readAt: null,
    counts: { inbox: 2, local: 2 }, outline: [{ key: "inbox", title: "Inbox", kind: "messages", items: 2 }, { key: "local", title: "Local", kind: "articles", items: 2 }],
    headlines: ["첫 기사"], messageHeadline: "중요 메일", urgent: 0, todo: 0,
  });
  const records = [make("00000000-0000-4000-8000-000000000023", { title: "새 항목", reviewState: "pending" })];
  const page = { items: [morning], from: "2026-09-08", to: "2026-09-21", unread: 1, earliestDate: "2026-09-21", latestDate: "2026-09-21",
    parts: { articles: { unread: 1, earliestDate: "2026-09-21" }, messages: { unread: 1, earliestDate: "2026-09-21" } } };
  const html = renderToStaticMarkup(<DashboardContext.Provider value={fakeDashboard(records, { view: "library" }, { digests: page })}>
    <LibraryPane />
  </DashboardContext.Provider>);
  // Then: only the link is listed and counted; the digest has no row.
  expect((await scan(html, ".row-title")).text).toBe("미확인 새 항목");
  expect(html).not.toContain(morning.id);
  expect((await scan(html, 'div[aria-label="기록 상태"] .chip-count')).text).toBe("1100");
});
