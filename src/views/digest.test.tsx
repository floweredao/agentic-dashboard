import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DigestSchema, DigestSummarySchema } from "../../shared/contracts";
import { applyLocale } from "../i18n";
import { DashboardContext } from "../state";
import { fakeDashboard } from "../test-dashboard";
import { DigestPane, DigestRow, DigestView, digestPart, dayHeading, parseCollapsed, publishedLabel } from "./Digest";
import type { DigestFilter } from "./Digest";

const at = "2026-09-30T23:30:00.000Z";
const digest = DigestSchema.parse({
  id: "00000000-0000-4000-8000-0000000000b1", date: "2026-10-01", slot: "morning", scheduledAt: "2026-09-30T23:00:00.000Z",
  createdBy: "omo", createdAt: at, updatedAt: at, version: 1, readAt: null, articlesReadAt: null, messagesReadAt: null,
  sections: [
    { key: "local", title: "Local", kind: "articles", updatedAt: at, shortfall: "1건 부족", items: [
      { key: "a", title: "국내 첫 소식", source: "Daily", summary: "요약 문장.", url: "https://news.example.com/read/A", originalUrl: "https://daily.example.com/a",
        publishedAt: "2026-09-30T22:04:00.000Z", publishedDate: null },
    ] },
    { key: "inbox", title: "Inbox", kind: "messages", updatedAt: at, shortfall: null, items: [
      { key: "m1", importance: "check", from: "Carrier", address: "noreply@carrier.example.com", subject: "접속 알림", summary: "확인 요약", action: "본인인지 확인", url: null, merged: 1 },
      { key: "m2", importance: "urgent", from: "X", address: "", subject: "계정 확인", summary: "급한 요약", action: "바로 확인", url: "https://mail.example.com/1", merged: 2 },
    ] },
  ],
});
const { sections: _sections, ...rest } = digest;
const outline = [{ key: "local", title: "Local", kind: "articles", items: 1 }, { key: "inbox", title: "Inbox", kind: "messages", items: 2 }];

async function scan(markup: string, selector: string) {
  const texts: string[] = [];
  let current = "";
  await new HTMLRewriter().on(selector, {
    element(element) { if (current) texts.push(current); current = ""; element.onEndTag(() => { texts.push(current); current = ""; }); },
    text(chunk) { current += chunk.text; },
  }).transform(new Response(markup)).text();
  return texts.filter(Boolean);
}

test("DigestView shows sections in stored order under their own titles, filtered to one kind when asked", async () => {
  const render = (part: DigestFilter) => renderToStaticMarkup(<DashboardContext.Provider value={fakeDashboard([], { view: "digest", id: digest.id })}>
    <DigestView digest={digest} part={part} /></DashboardContext.Provider>);
  const messagesHtml = render("messages");
  expect(await scan(messagesHtml, ".digest-section-label")).toEqual(["Inbox"]);
  expect(await scan(messagesHtml, ".message-card .digest-card-title")).toEqual(["계정 확인", "접속 알림"]);
  expect(await scan(messagesHtml, ".importance")).toEqual(["즉시 조치", "확인"]);
  expect(messagesHtml).toContain('href="https://mail.example.com/1"');
  expect(messagesHtml).toContain("2건 통합");
  expect(messagesHtml).not.toContain("국내 첫 소식");
  expect(await scan(messagesHtml, ".reader-dates")).toEqual(["메시지 2건"]);
  const articlesHtml = render("articles");
  expect(await scan(articlesHtml, ".digest-section-label")).toEqual(["Local"]);
  expect(articlesHtml).toContain('href="https://daily.example.com/a"');
  expect(articlesHtml).toContain("1건 부족");
  expect(articlesHtml).not.toContain("계정 확인");
  expect(await scan(articlesHtml, ".reader-dates")).toEqual(["기사 1건"]);
  expect(await scan(articlesHtml, "#digest-title")).toEqual(["10월 1일 목요일"]);
  expect(articlesHtml).toContain("아침 다이제스트 · 08:00");
  // And: 전체 keeps the stored order (articles, then messages) and totals both parts.
  const allHtml = render("all");
  expect(await scan(allHtml, ".digest-section-label")).toEqual(["Local", "Inbox"]);
  expect(await scan(allHtml, ".reader-dates")).toEqual(["메시지 2건 · 기사 1건"]);
  expect(await scan(allHtml, ".digest-jump .chip")).toEqual(["Local1", "Inbox2"]);
  expect(allHtml).toContain('id="item-inbox-m2"');
});

test("Each section head is a disclosure button; a collapsed section hides its body and keeps its head", async () => {
  const html = renderToStaticMarkup(<DashboardContext.Provider value={fakeDashboard([], { view: "digest", id: digest.id })}>
    <DigestView digest={digest} part="all" collapsed={new Set(["local"])} /></DashboardContext.Provider>);
  expect(html).toContain('<button type="button" class="digest-section-toggle" aria-expanded="false" aria-controls="section-local-body">');
  expect(html).toContain('<button type="button" class="digest-section-toggle" aria-expanded="true" aria-controls="section-inbox-body">');
  expect(html).toContain('<div id="section-local-body" class="digest-section-body" hidden="">');
  expect(html).toContain('<div id="section-inbox-body" class="digest-section-body">');
  expect(await scan(html, ".digest-section-toggle .count")).toEqual(["1", "2"]);
  // And: the importance note stays outside the button, at the end of a messages head.
  expect(await scan(html, ".digest-section-head > .digest-section-note")).toEqual(["즉시 조치 1 · 확인 1"]);
});

test("The stored collapsed set reads safely: only valid section keys, and anything malformed means none", () => {
  expect([...parseCollapsed('["inbox","ai-news"]')]).toEqual(["inbox", "ai-news"]);
  expect([...parseCollapsed('["inbox","Bad Key",3]')]).toEqual(["inbox"]);
  expect(parseCollapsed("{not json").size).toBe(0);
  expect(parseCollapsed('{"inbox":true}').size).toBe(0);
  expect(parseCollapsed(null).size).toBe(0);
});

test("The part param is articles or messages; none (or anything else) is 전체", () => {
  expect(digestPart({})).toBe("all");
  expect(digestPart({ part: "articles" })).toBe("articles");
  expect(digestPart({ part: "messages" })).toBe("messages");
  expect(digestPart({ part: "news" })).toBe("all");
});

test("DigestRow marks an unread part and lists that part's headline and section counts", async () => {
  const summary = DigestSummarySchema.parse({ ...rest, articlesReadAt: at, counts: { local: 1, inbox: 2 }, outline, headlines: ["국내 첫 소식"],
    messageHeadline: "계정 확인", urgent: 1, todo: 0 });
  const row = (part: DigestFilter, value = summary, selected = false) =>
    renderToStaticMarkup(<ul><DigestRow summary={value} part={part} selected={selected} href="#/digest" onOpen={() => {}} /></ul>);
  const messages = row("messages");
  expect(messages).toContain('class="digest-row unread"');
  expect(await scan(messages, ".digest-row-title")).toEqual(["안 읽음 아침 다이제스트"]);
  expect(await scan(messages, ".digest-row-headline")).toEqual(["계정 확인"]);
  expect(await scan(messages, ".digest-row-meta span")).toEqual(["Inbox 2", "즉시 조치 1"]);
  const articles = row("articles");
  expect(articles).not.toContain("unread");
  expect(await scan(articles, ".digest-row-headline")).toEqual(["국내 첫 소식"]);
  expect(await scan(articles, ".digest-row-meta span")).toEqual(["Local 1"]);
  const all = row("all");
  expect(all).toContain('class="digest-row unread"');
  expect(await scan(all, ".digest-row-meta span")).toEqual(["Local 1 · Inbox 2", "즉시 조치 1"]);
  expect(row("all", { ...summary, messagesReadAt: at })).not.toContain("unread");
  // A part without items does not keep the row unread, and the message headline stands in when there are no articles.
  const messagesOnly = row("all", { ...summary, messagesReadAt: at, articlesReadAt: null, outline: [{ ...outline[0], items: 0 }, outline[1]], headlines: [] } as typeof summary);
  expect(messagesOnly).not.toContain("unread");
  expect(await scan(messagesOnly, ".digest-row-headline")).toEqual(["계정 확인"]);
  expect(row("messages", { ...summary, messagesReadAt: at }, true)).toContain('aria-current="true"');
});

test("DigestPane lists every digest under 전체 by default, or only the chosen part's, under a three-segment switch with unread counts", async () => {
  const morning = DigestSummarySchema.parse({ ...rest, counts: { local: 1, inbox: 2 }, outline, headlines: ["국내 첫 소식"], messageHeadline: "계정 확인", urgent: 1, todo: 0 });
  const evening = DigestSummarySchema.parse({ ...rest, id: "00000000-0000-4000-8000-0000000000b2", slot: "evening", scheduledAt: "2026-10-01T12:00:00.000Z",
    messagesReadAt: at, counts: { world: 3 }, outline: [{ key: "world", title: "World", kind: "articles", items: 3 }], headlines: ["해외 소식"], messageHeadline: null, urgent: 0, todo: 0 });
  const page = { items: [evening, morning], from: "2026-09-18", to: "2026-10-01", unread: 3, earliestDate: "2026-10-01", latestDate: "2026-10-01",
    parts: { articles: { unread: 2, earliestDate: "2026-10-01" }, messages: { unread: 1, earliestDate: "2026-10-01" } } };
  const render = (params: Record<string, string>) => renderToStaticMarkup(<DashboardContext.Provider
    value={fakeDashboard([], { view: "digest", params }, { digests: page })}><DigestPane /></DashboardContext.Provider>);
  const switchButtons = '[aria-label="전체·기사·메시지"] button';
  const all = render({});
  expect(await scan(all, switchButtons)).toEqual(["전체안 읽음 3", "기사안 읽음 2", "메시지안 읽음 1"]);
  expect(await scan(all, `${switchButtons}[aria-pressed="true"]`)).toEqual(["전체안 읽음 3"]);
  expect(await scan(all, ".digest-row-headline")).toEqual(["해외 소식", "국내 첫 소식"]);
  expect(all).toContain('placeholder="기사·메시지 검색"');
  expect(all).toContain('href="#/digest/00000000-0000-4000-8000-0000000000b1"');
  const messages = render({ part: "messages" });
  expect(await scan(messages, `${switchButtons}[aria-pressed="true"]`)).toEqual(["메시지안 읽음 1"]);
  expect(await scan(messages, ".digest-row-headline")).toEqual(["계정 확인"]);
  expect(messages).toContain('placeholder="메시지 검색"');
  expect(messages).toContain('href="#/digest/00000000-0000-4000-8000-0000000000b1?part=messages"');
  const articles = render({ part: "articles" });
  expect(await scan(articles, ".digest-row-headline")).toEqual(["해외 소식", "국내 첫 소식"]);
  expect(articles).toContain('placeholder="기사 검색"');
  expect(articles).toContain('href="#/digest/00000000-0000-4000-8000-0000000000b2?part=articles"');
});

test("Day headings and publish times read in Seoul time", () => {
  expect(dayHeading("2026-10-01", "2026-10-01")).toBe("오늘 · 10월 1일 목요일");
  expect(dayHeading("2026-09-30", "2026-10-01")).toBe("어제 · 9월 30일 수요일");
  expect(dayHeading("2026-09-28", "2026-10-01")).toBe("9월 28일 월요일");
  const section = digest.sections[0];
  const article = section?.kind === "articles" ? section.items[0] : undefined;
  if (!article) throw new Error("fixture");
  expect(publishedLabel(article, "2026-10-01")).toBe("오전 7:04");
  expect(publishedLabel({ ...article, publishedAt: null, publishedDate: "2026-09-29" }, "2026-10-01")).toBe("9월 29일");
});

test("DigestView and DigestRow render in English when the locale is en", async () => {
  applyLocale("en");
  try {
    const html = renderToStaticMarkup(<DashboardContext.Provider value={fakeDashboard([], { view: "digest", id: digest.id })}>
      <DigestView digest={digest} part="all" /></DashboardContext.Provider>);
    expect(await scan(html, ".importance")).toEqual(["Act now", "Review"]);
    expect(await scan(html, ".reader-dates")).toEqual(["Messages 2 · Articles 1"]);
    expect(await scan(html, "#digest-title")).toEqual(["Thursday, October 1"]);
    expect(html).toContain("Morning digest · 08:00");
    expect(html).toContain("Jump to section");
    expect(html).toContain("2 merged");
    const summary = DigestSummarySchema.parse({ ...rest, counts: { local: 1, inbox: 2 }, outline, headlines: ["x"], messageHeadline: null, urgent: 1, todo: 0 });
    const row = renderToStaticMarkup(<ul><DigestRow summary={summary} part="all" selected={false} href="#/digest" onOpen={() => {}} /></ul>);
    expect(await scan(row, ".digest-row-title")).toEqual(["Unread Morning digest"]);
    expect(await scan(row, ".digest-row-meta span")).toEqual(["Local 1 · Inbox 2", "Act now 1"]);
  } finally { applyLocale("ko"); }
});
