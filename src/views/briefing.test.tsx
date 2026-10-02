import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BriefingSchema, BriefingSummarySchema } from "../../shared/contracts";
import { DashboardContext } from "../state";
import { fakeDashboard } from "../test-dashboard";
import { BriefingPane, BriefingRow, BriefingView, briefingPart, dayHeading, parseCollapsed, publishedLabel } from "./Briefing";
import type { BriefingFilter } from "./Briefing";

const at = "2026-09-30T23:30:00.000Z";
const briefing = BriefingSchema.parse({
  id: "00000000-0000-4000-8000-0000000000b1", date: "2026-10-01", slot: "morning", scheduledAt: "2026-09-30T23:00:00.000Z",
  createdBy: "omo", createdAt: at, updatedAt: at, version: 1, readAt: null, newsReadAt: null, mailReadAt: null,
  sections: {
    domestic: { updatedAt: at, shortfall: "1건 부족", items: [
      { key: "a", title: "국내 첫 소식", source: "조선일보", summary: "요약 문장.", url: "https://news.google.com/read/A", originalUrl: "https://www.chosun.com/a",
        publishedAt: "2026-09-30T22:04:00.000Z", publishedDate: null },
    ] },
    mail: { updatedAt: at, shortfall: null, items: [
      { key: "m1", importance: "check", from: "KT", address: "noreply@kt.example", subject: "접속 알림", summary: "확인 요약", action: "본인인지 확인", url: null, merged: 1 },
      { key: "m2", importance: "urgent", from: "X", address: "", subject: "계정 확인", summary: "급한 요약", action: "바로 확인", url: "https://mail.example.com/1", merged: 2 },
    ] },
  },
});

async function scan(markup: string, selector: string) {
  const texts: string[] = [];
  let current = "";
  await new HTMLRewriter().on(selector, {
    element(element) { if (current) texts.push(current); current = ""; element.onEndTag(() => { texts.push(current); current = ""; }); },
    text(chunk) { current += chunk.text; },
  }).transform(new Response(markup)).text();
  return texts.filter(Boolean);
}

test("BriefingView shows only its part: the mail with urgent mail on top, or the news cards that open the publisher's page", async () => {
  const render = (part: BriefingFilter) => renderToStaticMarkup(<DashboardContext.Provider value={fakeDashboard([], { view: "briefing", id: briefing.id })}>
    <BriefingView briefing={briefing} part={part} /></DashboardContext.Provider>);
  const mailHtml = render("mail");
  expect(await scan(mailHtml, ".briefing-section-label")).toEqual(["메일"]);
  expect(await scan(mailHtml, ".mail-card .briefing-card-title")).toEqual(["계정 확인", "접속 알림"]);
  expect(await scan(mailHtml, ".importance")).toEqual(["즉시 조치", "확인"]);
  expect(mailHtml).toContain('href="https://mail.example.com/1"');
  expect(mailHtml).toContain("2건 통합");
  expect(mailHtml).not.toContain("국내 첫 소식");
  expect(await scan(mailHtml, ".reader-dates")).toEqual(["메일 2건"]);
  const newsHtml = render("news");
  expect(await scan(newsHtml, ".briefing-section-label")).toEqual(["국내"]);
  expect(newsHtml).toContain('href="https://www.chosun.com/a"');
  expect(newsHtml).toContain("1건 부족");
  expect(newsHtml).not.toContain("계정 확인");
  expect(await scan(newsHtml, ".reader-dates")).toEqual(["뉴스 1건"]);
  expect(await scan(newsHtml, "#briefing-title")).toEqual(["10월 1일 목요일"]);
  expect(newsHtml).toContain("아침 브리핑 · 08:00");
  // And: 전체 shows the mail first, then the news, with both totals.
  const allHtml = render("all");
  expect(await scan(allHtml, ".briefing-section-label")).toEqual(["메일", "국내"]);
  expect(await scan(allHtml, ".reader-dates")).toEqual(["메일 2건 · 뉴스 1건"]);
  expect(await scan(allHtml, ".briefing-jump .chip")).toEqual(["메일2", "국내1"]);
});

test("Each section head is a disclosure button; a collapsed section hides its body and keeps its head", async () => {
  // Given: 국내 collapsed.
  const html = renderToStaticMarkup(<DashboardContext.Provider value={fakeDashboard([], { view: "briefing", id: briefing.id })}>
    <BriefingView briefing={briefing} part="all" collapsed={new Set(["domestic"])} /></DashboardContext.Provider>);
  // Then: the button carries the state and points at its body; only the collapsed body is hidden.
  expect(html).toContain('<button type="button" class="briefing-section-toggle" aria-expanded="true" aria-controls="section-mail-body">');
  expect(html).toContain('<button type="button" class="briefing-section-toggle" aria-expanded="false" aria-controls="section-domestic-body">');
  expect(html).toContain('<div id="section-mail-body" class="briefing-section-body">');
  expect(html).toContain('<div id="section-domestic-body" class="briefing-section-body" hidden="">');
  expect(await scan(html, ".briefing-section-toggle .count")).toEqual(["2", "1"]);
  // And: the importance note stays outside the button, at the end of the head.
  expect(await scan(html, ".briefing-section-head > .briefing-section-note")).toEqual(["즉시 조치 1 · 확인 1"]);
});

test("The stored collapsed set reads safely: only known section keys, and anything malformed means none", () => {
  expect([...parseCollapsed('["mail","aiDevelopment"]')]).toEqual(["mail", "aiDevelopment"]);
  expect([...parseCollapsed('["mail","bogus",3]')]).toEqual(["mail"]);
  expect(parseCollapsed("{not json").size).toBe(0);
  expect(parseCollapsed('{"mail":true}').size).toBe(0);
  expect(parseCollapsed(null).size).toBe(0);
});

test("The part param is 뉴스 or 메일; none (or anything else) is 전체", () => {
  expect(briefingPart({})).toBe("all");
  expect(briefingPart({ part: "news" })).toBe("news");
  expect(briefingPart({ part: "mail" })).toBe("mail");
  expect(briefingPart({ part: "other" })).toBe("all");
});

test("BriefingRow marks an unread part and lists that part's headline and counts", async () => {
  const { sections: _sections, ...rest } = briefing;
  const summary = BriefingSummarySchema.parse({ ...rest, newsReadAt: at, counts: { mail: 2, domestic: 1 }, headlines: ["국내 첫 소식"],
    mailHeadline: "계정 확인", urgent: 1, todo: 0 });
  const row = (part: BriefingFilter, value = summary, selected = false) =>
    renderToStaticMarkup(<ul><BriefingRow summary={value} part={part} selected={selected} href="#/briefing" onOpen={() => {}} /></ul>);
  const mail = row("mail");
  expect(mail).toContain('class="briefing-row unread"');
  expect(await scan(mail, ".briefing-row-title")).toEqual(["안 읽음 아침 브리핑"]);
  expect(await scan(mail, ".briefing-row-headline")).toEqual(["계정 확인"]);
  expect(await scan(mail, ".briefing-row-meta span")).toEqual(["메일 2", "즉시 조치 1"]);
  const news = row("news");
  expect(news).not.toContain("unread");
  expect(await scan(news, ".briefing-row-headline")).toEqual(["국내 첫 소식"]);
  expect(await scan(news, ".briefing-row-meta span")).toEqual(["국내 1"]);
  // And: 전체 is unread while any part with items is, leads with the news headline and counts both parts.
  const all = row("all");
  expect(all).toContain('class="briefing-row unread"');
  expect(await scan(all, ".briefing-row-headline")).toEqual(["국내 첫 소식"]);
  expect(await scan(all, ".briefing-row-meta span")).toEqual(["메일 2 · 국내 1", "즉시 조치 1"]);
  expect(row("all", { ...summary, mailReadAt: at })).not.toContain("unread");
  // A part without items does not keep the row unread, and the mail headline stands in when there is no news.
  const mailOnly = row("all", { ...summary, mailReadAt: at, newsReadAt: null, counts: { mail: 2, domestic: 0 }, headlines: [] });
  expect(mailOnly).not.toContain("unread");
  expect(await scan(mailOnly, ".briefing-row-headline")).toEqual(["계정 확인"]);
  expect(row("mail", { ...summary, mailReadAt: at }, true)).toContain('aria-current="true"');
});

test("BriefingPane lists every briefing under 전체 by default, or only the chosen part's, under a three-segment switch with unread counts", async () => {
  const { sections: _sections, ...rest } = briefing;
  const morning = BriefingSummarySchema.parse({ ...rest, counts: { mail: 2, domestic: 1 }, headlines: ["국내 첫 소식"], mailHeadline: "계정 확인", urgent: 1, todo: 0 });
  const evening = BriefingSummarySchema.parse({ ...rest, id: "00000000-0000-4000-8000-0000000000b2", slot: "evening", scheduledAt: "2026-10-01T12:00:00.000Z",
    mailReadAt: at, counts: { international: 3 }, headlines: ["해외 소식"], mailHeadline: null, urgent: 0, todo: 0 });
  const page = { items: [evening, morning], from: "2026-09-18", to: "2026-10-01", unread: 3, earliestDate: "2026-10-01", latestDate: "2026-10-01",
    parts: { news: { unread: 2, earliestDate: "2026-10-01" }, mail: { unread: 1, earliestDate: "2026-10-01" } } };
  const render = (params: Record<string, string>) => renderToStaticMarkup(<DashboardContext.Provider
    value={fakeDashboard([], { view: "briefing", params }, { briefings: page })}><BriefingPane /></DashboardContext.Provider>);
  const switchButtons = '[aria-label="전체·뉴스·메일"] button';
  const all = render({});
  expect(await scan(all, switchButtons)).toEqual(["전체안 읽음 3", "뉴스안 읽음 2", "메일안 읽음 1"]);
  expect(await scan(all, `${switchButtons}[aria-pressed="true"]`)).toEqual(["전체안 읽음 3"]);
  expect(await scan(all, ".briefing-row-headline")).toEqual(["해외 소식", "국내 첫 소식"]);
  expect(all).toContain('placeholder="기사·메일 검색"');
  expect(all).toContain('href="#/briefing/00000000-0000-4000-8000-0000000000b1"');
  const mail = render({ part: "mail" });
  expect(await scan(mail, `${switchButtons}[aria-pressed="true"]`)).toEqual(["메일안 읽음 1"]);
  expect(await scan(mail, ".briefing-row-headline")).toEqual(["계정 확인"]);
  expect(mail).toContain('placeholder="메일 검색"');
  const news = render({ part: "news" });
  expect(await scan(news, `${switchButtons}[aria-pressed="true"]`)).toEqual(["뉴스안 읽음 2"]);
  expect(await scan(news, ".briefing-row-headline")).toEqual(["해외 소식", "국내 첫 소식"]);
  expect(news).toContain('placeholder="기사 검색"');
  expect(news).toContain('href="#/briefing/00000000-0000-4000-8000-0000000000b2?part=news"');
  expect(mail).toContain('href="#/briefing/00000000-0000-4000-8000-0000000000b1?part=mail"');
});

test("Day headings and publish times read in Seoul time", () => {
  expect(dayHeading("2026-10-01", "2026-10-01")).toBe("오늘 · 10월 1일 목요일");
  expect(dayHeading("2026-09-30", "2026-10-01")).toBe("어제 · 9월 30일 수요일");
  expect(dayHeading("2026-09-28", "2026-10-01")).toBe("9월 28일 월요일");
  const article = briefing.sections.domestic?.items[0];
  if (!article) throw new Error("fixture");
  expect(publishedLabel(article, "2026-10-01")).toBe("오전 7:04");
  expect(publishedLabel({ ...article, publishedAt: null, publishedDate: "2026-09-29" }, "2026-10-01")).toBe("9월 29일");
});
