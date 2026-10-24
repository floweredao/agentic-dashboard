import { z } from "zod";
import { DigestInputSchema } from "../shared/contracts";
import type { DigestInput, DigestMessage, DigestSectionInput } from "../shared/contracts";

/** Headings in mail.json's grouped Markdown messages. */
const IMPORTANCE: Readonly<Record<string, DigestMessage["importance"]>> = {
  "즉시 조치": "urgent", "할 일": "todo", "확인": "check", "참고": "info",
};
const NEWS_KEYS = ["domestic", "international"] as const;
const AI_NEWS_KEYS = ["aiDevelopment"] as const;
const AI_EDITIONS = ["ai-morning", "ai-evening"] as const;
const TITLES = {
  en: { mail: "Mail", domestic: "Domestic", international: "International", aiDevelopment: "AI / Development", social: "Social" },
  ko: { mail: "메일", domestic: "국내", international: "해외", aiDevelopment: "AI / 개발", social: "소셜" },
} as const;
const headings = {
  locale: z.enum(["en", "ko"]).optional(),
  sectionTitles: z.record(z.string(), z.string().trim().min(1).max(60)).optional(),
};
const articleSchema = z.object({
  eventKey: z.string(), title: z.string(), source: z.string().optional(), summary: z.string().optional(), url: z.string(),
  originalUrl: z.string().nullish(), publishedAt: z.string().nullish(), publishedDate: z.string().nullish(), imageUrl: z.string().nullish(),
});
export const newsSchema = z.object({
  ...headings, edition: z.string().optional(), targetScheduledAt: z.iso.datetime({ offset: true }),
  articles: z.object({
    domestic: z.array(articleSchema).optional(), international: z.array(articleSchema).optional(), aiDevelopment: z.array(articleSchema).optional(),
  }),
  shortfalls: z.record(z.string(), z.string().nullable()).nullish(),
});
export const mailSchema = z.object({
  ...headings, title: z.string().trim().min(1).max(60).optional(),
  targetScheduledAt: z.iso.datetime({ offset: true }), messages: z.array(z.string()),
});
export const xSchema = z.object({
  ...headings, title: z.string().trim().min(1).max(60).optional(),
  targetScheduledAt: z.iso.datetime({ offset: true }), shortfall: z.string().nullish(),
  items: z.array(z.object({
    key: z.string(), title: z.string(), author: z.string(), summary: z.string(), url: z.string(), postedAt: z.string().nullish(),
  })),
});

/** Parse category headings, sender/subject bullets, summaries, actions and optional message links. */
export function parseMailDigest(messages: readonly string[]): DigestMessage[] {
  const items: DigestMessage[] = [];
  let importance: DigestMessage["importance"] | null = null;
  let current: DigestMessage | null = null;
  let announced = 0;
  for (const raw of messages.join("\n").split("\n")) {
    const line = raw.trim();
    const heading = /^\*\*(.+?)\s*\|\s*\d+건\*\*$/.exec(line);
    if (heading) { importance = IMPORTANCE[heading[1]?.trim() ?? ""] ?? null; current = null; continue; }
    if (/^(?:즉시 조치|할 일|확인|참고) \d+건/.test(line)) {
      const merged = /통합 (\d+)건/.exec(line);
      announced = merged ? Number(merged[1]) : [...line.matchAll(/(\d+)건/g)].reduce((sum, match) => sum + Number(match[1]), 0);
      continue;
    }
    const bullet = /^•\s*(.+)$/.exec(line);
    if (bullet?.[1] && importance) {
      const mergedCount = /\s*\(관련 메일 (\d+)건 통합\)$/.exec(bullet[1]);
      const text = mergedCount ? bullet[1].slice(0, mergedCount.index) : bullet[1];
      const [from = "", address = "", ...subject] = text.split(" | ").map(part => part.trim());
      current = { key: `mail-${items.length + 1}`, importance, from, address: address === from ? "" : address,
        subject: subject.join(" | ") || address, merged: mergedCount ? Number(mergedCount[1]) : 1, summary: "", action: "", url: null };
      items.push(current);
      continue;
    }
    if (!current || !line) continue;
    const link = /^\[메일에서 열기\]\((https?:\/\/[^)\s]+)\)$/.exec(line);
    const action = /^(?:즉시 조치|할 일|확인|참고):\s*(.+)$/.exec(line);
    if (link?.[1]) current.url = link[1];
    else if (action?.[1]) current.action = action[1];
    else current.summary = current.summary ? `${current.summary} ${line}` : line;
  }
  if (items.length === 0 && announced > 0) throw new Error(`Mail announces ${announced} items but none could be parsed; check mail.json messages.`);
  return items;
}

/** Convert a briefing folder to the public digest body; AI editions use their scheduled HH:MM slot. */
export function digestFromFiles(files: { readonly news?: unknown; readonly mail?: unknown; readonly x?: unknown },
  options: { readonly sections?: readonly string[]; readonly notify?: boolean; readonly locale?: "en" | "ko" } = {}): DigestInput {
  const news = files.news === undefined ? null : newsSchema.parse(files.news);
  const mail = files.mail === undefined ? null : mailSchema.parse(files.mail);
  if (!news && !mail) throw new Error("A briefing folder needs news.json or mail.json.");
  const scheduledAt = news?.targetScheduledAt ?? mail?.targetScheduledAt ?? "";
  const shifted = new Date(Date.parse(scheduledAt) + 9 * 60 * 60 * 1000).toISOString();
  const date = shifted.slice(0, 10), time = shifted.slice(11, 16);
  const aiEdition = AI_EDITIONS.some(edition => edition === news?.edition);
  const edition = news?.edition === "morning" || news?.edition === "evening" ? news.edition : undefined;
  const slot = aiEdition ? time : edition ?? (time === "08:00" ? "morning" : time === "21:00" ? "evening" : time);
  const x = aiEdition && files.x !== undefined ? xSchema.parse(files.x) : null;
  const locale = options.locale ?? news?.locale ?? mail?.locale ?? x?.locale ?? "en";
  const sections: DigestSectionInput[] = [];
  if (mail && !aiEdition) sections.push({
    key: "mail", kind: "messages", title: mail.title ?? mail.sectionTitles?.mail ?? TITLES[locale].mail,
    items: parseMailDigest(mail.messages), shortfall: null,
  });
  if (x) sections.push({
    key: "social", kind: "articles", title: x.title ?? x.sectionTitles?.social ?? TITLES[locale].social,
    shortfall: x.shortfall ?? null, items: x.items.map(item => ({
      key: item.key, title: item.title, source: item.author, summary: item.summary, url: item.url, originalUrl: null,
      publishedAt: item.postedAt ?? null, publishedDate: null, imageUrl: null,
    })),
  });
  if (news) for (const key of aiEdition ? AI_NEWS_KEYS : NEWS_KEYS) {
    const articles = news.articles[key];
    if (!articles) continue;
    const publicKey = key === "aiDevelopment" ? "ai-development" : key;
    sections.push({
      key: publicKey, kind: "articles", title: news.sectionTitles?.[publicKey] ?? news.sectionTitles?.[key] ?? TITLES[locale][key],
      shortfall: news.shortfalls?.[key] ?? null, items: articles.map(item => ({
        key: item.eventKey, title: item.title, source: item.source ?? "", summary: item.summary ?? "", url: item.url,
        originalUrl: item.originalUrl ?? null, publishedAt: item.publishedAt ?? null,
        publishedDate: item.publishedAt ? null : item.publishedDate ?? null, imageUrl: item.imageUrl ?? null,
      })),
    });
  }
  const chosen = options.sections?.map(key => key === "aiDevelopment" ? "ai-development" : key);
  return DigestInputSchema.parse({
    date, slot, scheduledAt, sections: chosen ? sections.filter(section => chosen.includes(section.key)) : sections,
    notify: options.notify ?? true,
  });
}
