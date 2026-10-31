import { expect, test } from "bun:test";
import { DigestInputSchema } from "../shared/contracts";
import { digestFromFiles, parseMailDigest } from "./briefing-convert";

const news = {
  edition: "morning", targetScheduledAt: "2026-10-01T08:00:00+09:00",
  articles: {
    domestic: [{ eventKey: "local-a", title: "Example city opens a library", source: "Example News",
      summary: "A fictional library opens.", url: "https://example.com/news/a", originalUrl: "https://example.com/original/a",
      publishedAt: "2026-09-30T22:00:00Z", imageUrl: "https://example.com/a.jpg" }],
    international: [],
    aiDevelopment: [{ eventKey: "ai-b", title: "Example toolkit adds a compiler", url: "https://example.com/news/b",
      publishedAt: null, publishedDate: "2026-09-30" }],
  },
  shortfalls: { international: "No further verified stories." },
};
const messages = [
  "즉시 조치 1건 · 할 일 0건 · 확인 2건 · 참고 0건  통합 3건\n**즉시 조치 | 1건**\n" +
    "• Example Service | Example Service | Example account update (관련 메일 2건 통합)\n" +
    "A fictional account changed.\n즉시 조치: Review the change.\n[메일에서 열기](https://example.com/mail/1)\n" +
    "**확인 | 2건**\n• Example Network | Example Network | Example device notice\n" +
    "A fictional device connected.\n확인: Check the device.\n[메일에서 열기](https://example.com/mail/2)",
  "• Example Search | Example Search | Example login notice\nA fictional login occurred.\n확인: Check activity.",
];
const mail = { targetScheduledAt: news.targetScheduledAt, messages };
const x = {
  targetScheduledAt: "2026-10-01T08:10:00+09:00", shortfall: null,
  items: [{ key: "post-a", title: "Example tool preview", author: "Example Developer", summary: "A fictional preview.",
    url: "https://example.com/posts/a", postedAt: "2026-09-30T21:00:00Z" }],
};

test("parses grouped mail across messages with importance, actions and optional links", () => {
  expect(parseMailDigest(messages)).toEqual([
    { key: "mail-1", importance: "urgent", from: "Example Service", address: "", subject: "Example account update",
      merged: 2, summary: "A fictional account changed.", action: "Review the change.", url: "https://example.com/mail/1" },
    { key: "mail-2", importance: "check", from: "Example Network", address: "", subject: "Example device notice",
      merged: 1, summary: "A fictional device connected.", action: "Check the device.", url: "https://example.com/mail/2" },
    { key: "mail-3", importance: "check", from: "Example Search", address: "", subject: "Example login notice",
      merged: 1, summary: "A fictional login occurred.", action: "Check activity.", url: null },
  ]);
});

test("rejects mail that announces items in an unreadable format", () => {
  expect(() => parseMailDigest(["즉시 조치 1건 · 확인 0건\nUnknown format"])).toThrow();
});

test("converts ordinary news and mail into public digest sections", () => {
  const input = DigestInputSchema.parse(digestFromFiles({ news, mail }));
  expect(input).toMatchObject({ date: "2026-10-01", slot: "morning", scheduledAt: news.targetScheduledAt, notify: true });
  expect(input.sections.map(section => [section.key, section.kind])).toEqual([
    ["mail", "messages"], ["domestic", "articles"], ["international", "articles"],
  ]);
  expect(input.sections[1]).toMatchObject({ title: "Domestic", shortfall: null, items: [{
    key: "local-a", originalUrl: "https://example.com/original/a", publishedAt: "2026-09-30T22:00:00Z",
    publishedDate: null, imageUrl: "https://example.com/a.jpg",
  }] });
  expect(input.sections[2]).toMatchObject({ items: [], shortfall: news.shortfalls.international });
  expect(input.sections[0]?.items).toHaveLength(3);
});

test.each(["ai-morning", "ai-evening"])("maps %s to its scheduled time with AI and social articles only", edition => {
  const scheduledAt = edition === "ai-morning" ? x.targetScheduledAt : "2026-10-01T21:10:00+09:00";
  const input = DigestInputSchema.parse(digestFromFiles({
    news: { ...news, edition, targetScheduledAt: scheduledAt, shortfalls: { aiDevelopment: null } }, mail, x,
  }));
  expect(input.slot).toBe(edition === "ai-morning" ? "08:10" : "21:10");
  expect(input.sections.map(section => section.key).sort()).toEqual(["ai-development", "social"]);
  expect(input.sections.find(section => section.key === "ai-development")).toMatchObject({
    kind: "articles", shortfall: null, items: [{ key: "ai-b", publishedDate: "2026-09-30", publishedAt: null }],
  });
  expect(input.sections.find(section => section.key === "social")).toMatchObject({
    kind: "articles", title: "Social", items: [{ key: "post-a", source: "Example Developer", publishedAt: x.items[0]?.postedAt }],
  });
});

test("ignores social input outside AI editions", () => {
  expect(digestFromFiles({ news, x }).sections.some(section => section.key === "social")).toBe(false);
});

test("uses input section titles before locale defaults", () => {
  const input = digestFromFiles({ news: { ...news, locale: "ko", sectionTitles: { domestic: "지역 기사" } },
    mail: { ...mail, title: "받은 소식" } });
  expect(input.sections.map(section => section.title)).toEqual(["받은 소식", "지역 기사", "해외"]);
  expect(digestFromFiles({ news: { ...news, edition: "ai-morning" }, x: { ...x, title: "Community picks" } })
    .sections.find(section => section.key === "social")?.title).toBe("Community picks");
});

test("filters public keys, applies quiet mode and handles off-schedule mail", () => {
  const input = digestFromFiles({ mail: { ...mail, targetScheduledAt: "2026-10-01T23:30:00Z" } },
    { sections: ["mail"], notify: false, locale: "ko" });
  expect(input).toMatchObject({ date: "2026-10-02", slot: "08:30", notify: false });
  expect(input.sections.map(section => section.key)).toEqual(["mail"]);
  expect(input.sections[0]?.title).toBe("메일");
  expect(digestFromFiles({ news: { ...news, edition: "evening" } }).slot).toBe("evening");
  expect(digestFromFiles({ news, mail }, { sections: ["domestic"] }).sections).toHaveLength(1);
});

test("rejects missing files, invalid scheduled times and empty section selections", () => {
  expect(() => digestFromFiles({})).toThrow();
  expect(() => digestFromFiles({ news: { ...news, targetScheduledAt: "not-a-date" } })).toThrow();
  expect(() => digestFromFiles({ news }, { sections: ["social"] })).toThrow();
});
