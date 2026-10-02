import { z } from "zod";
import { BRIEFING_LIMITS, BRIEFING_PART_LABELS, BRIEFING_PARTS, BRIEFING_SECTION_LABELS, BRIEFING_SECTIONS, briefingOfPartId, BriefingPartSchema, BriefingSchema, DateSchema,
  MAIL_IMPORTANCE, MAIL_IMPORTANCE_LABELS, NEWS_SECTIONS, PART_SECTIONS, partOfSection } from "../shared/contracts";
import type { Briefing, BriefingArticle, BriefingHit, BriefingInput, BriefingMail, BriefingPart, BriefingSectionKey, BriefingSummary, DashboardRecord } from "../shared/contracts";
import { ApiError } from "./errors";
import { canonical, type Principal, type Store } from "./store";

const DAY_MS = 24 * 60 * 60 * 1000;
const SEOUL_OFFSET_MS = 9 * 60 * 60 * 1000;
const rowSchema = z.object({
  id: z.string(), date: z.string(), slot: z.string(), scheduled_at: z.string(), sections: z.string(), created_by: z.string(),
  created_at: z.string(), updated_at: z.string(), version: z.number().int(), news_read_at: z.string().nullable(), mail_read_at: z.string().nullable(),
});
const rangeSchema = z.object({ from: DateSchema.optional(), to: DateSchema.optional() }).strict();
const searchSchema = z.object({ q: z.string().trim().min(1).max(100), limit: z.coerce.number().int().min(1).max(50).default(30), part: BriefingPartSchema.optional() }).strict();
/** SQL over the `sections` JSON: whether a part is present, and how many items it has. */
const presentSql = (part: BriefingPart) => `(${PART_SECTIONS[part].map(key => `json_type(sections,'$.${key}') IS NOT NULL`).join(" OR ")})`;
const itemsSql = (part: BriefingPart) => PART_SECTIONS[part].map(key => `coalesce(json_array_length(sections,'$.${key}.items'),0)`).join("+");
const readColumn: Record<BriefingPart, "news_read_at" | "mail_read_at"> = { news: "news_read_at", mail: "mail_read_at" };
export const partReadAt = (briefing: Pick<Briefing, "newsReadAt" | "mailReadAt">, part: BriefingPart) => part === "mail" ? briefing.mailReadAt : briefing.newsReadAt;
const hasItems = (sections: Briefing["sections"], part: BriefingPart) => PART_SECTIONS[part].some(key => (sections[key]?.items.length ?? 0) > 0);
/** Read when both parts are: the later of the two times. */
const bothRead = (news: string | null, mail: string | null) => news && mail ? news > mail ? news : mail : null;

export const slotTime = (slot: string) => slot === "morning" ? "08:00" : slot === "evening" ? "21:00" : slot;
export const slotLabel = (slot: string) => slot === "morning" ? "아침" : slot === "evening" ? "저녁" : slot;
const seoulDay = (time: number) => new Date(time + SEOUL_OFFSET_MS).toISOString().slice(0, 10);
const shiftDay = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

function toBriefing(value: unknown): Briefing {
  const row = rowSchema.parse(value);
  return BriefingSchema.parse({ id: row.id, date: row.date, slot: row.slot, scheduledAt: row.scheduled_at, sections: JSON.parse(row.sections),
    createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at, version: row.version,
    newsReadAt: row.news_read_at, mailReadAt: row.mail_read_at, readAt: bothRead(row.news_read_at, row.mail_read_at) });
}
const newsItems = (briefing: Pick<Briefing, "sections">, keys: readonly BriefingSectionKey[] = NEWS_SECTIONS): BriefingArticle[][] =>
  NEWS_SECTIONS.filter(key => keys.includes(key)).map(key => briefing.sections[key]?.items ?? []);
/** The first headline of each news section, then the second of each, and so on: a mix of sections rather than one section's top three. */
export function headlines(briefing: Pick<Briefing, "sections">, count = 3, keys?: readonly BriefingSectionKey[]): string[] {
  const lists = newsItems(briefing, keys);
  const picked: string[] = [];
  for (let index = 0; picked.length < count && lists.some(list => index < list.length); index += 1) {
    for (const list of lists) { const item = list[index]; if (item && picked.length < count) picked.push(item.title); }
  }
  return picked;
}
export function summarize(briefing: Briefing): BriefingSummary {
  const { sections, ...rest } = briefing;
  const counts: BriefingSummary["counts"] = {};
  for (const key of BRIEFING_SECTIONS) { const section = sections[key]; if (section) counts[key] = section.items.length; }
  const mail = sections.mail?.items ?? [];
  const first = mail.reduce<BriefingMail | null>((best, item) => !best || MAIL_IMPORTANCE.indexOf(item.importance) < MAIL_IMPORTANCE.indexOf(best.importance) ? item : best, null);
  return { ...rest, counts, headlines: headlines(briefing), mailHeadline: first?.subject ?? null,
    urgent: mail.filter(item => item.importance === "urgent").length, todo: mail.filter(item => item.importance === "todo").length };
}
const matches = (needle: string, values: readonly string[]) => values.some(value => value.toLowerCase().includes(needle));

/**
 * News and mail briefings, kept apart from records. A briefing is keyed by its Seoul date and slot; an upload replaces the
 * sections it carries and keeps the others, so a late section can arrive on its own and an identical retry changes nothing.
 * The news and the mail of a briefing are read apart (`news_read_at`, `mail_read_at`).
 */
export class Briefings {
  constructor(readonly store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS briefings(id TEXT PRIMARY KEY, date TEXT NOT NULL, slot TEXT NOT NULL, scheduled_at TEXT NOT NULL,
        sections TEXT NOT NULL CHECK(json_valid(sections)), created_by TEXT NOT NULL REFERENCES principals(id), created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, version INTEGER NOT NULL, news_read_at TEXT, mail_read_at TEXT, UNIQUE(date, slot));
      CREATE INDEX IF NOT EXISTS briefings_scheduled ON briefings(scheduled_at);`);
    this.splitReadState();
  }

  /**
   * A database from before the split has one `read_at`: both parts take it over, and a part with nothing to read counts as
   * read from its creation. Runs once, in one transaction.
   */
  private splitReadState() {
    const columns = this.store.db.query("SELECT name FROM pragma_table_info('briefings')").all().map(value => z.object({ name: z.string() }).parse(value).name);
    if (!columns.includes("read_at")) return;
    this.store.db.transaction(() => {
      this.store.db.exec(`ALTER TABLE briefings RENAME COLUMN read_at TO news_read_at;
        ALTER TABLE briefings ADD COLUMN mail_read_at TEXT;
        UPDATE briefings SET mail_read_at=news_read_at;
        UPDATE briefings SET news_read_at=coalesce(news_read_at, created_at) WHERE ${itemsSql("news")}=0;
        UPDATE briefings SET mail_read_at=coalesce(mail_read_at, created_at) WHERE ${itemsSql("mail")}=0;`);
    }).immediate();
  }

  private find(date: string, slot: string): Briefing | null {
    const row = this.store.db.query("SELECT * FROM briefings WHERE date=? AND slot=?").get(date, slot);
    return row ? toBriefing(row) : null;
  }
  get(id: string): Briefing {
    const row = this.store.db.query("SELECT * FROM briefings WHERE id=?").get(id);
    if (!row) throw new ApiError(404, "not_found", "Briefing not found");
    return toBriefing(row);
  }
  exists(id: string) { return this.store.db.query("SELECT 1 FROM briefings WHERE id=?").get(id) !== null; }

  /**
   * `changed`: sections whose content differs from what was stored. `added`: sections that had no items before and have some
   * now, which is what a notification is about. A part gets unread again when one of its sections is added; a part with
   * nothing to read counts as read.
   */
  upsert(principal: Principal, input: BriefingInput): { briefing: Briefing; created: boolean; changed: BriefingSectionKey[]; added: BriefingSectionKey[] } {
    return this.store.db.transaction(() => {
      const existing = this.find(input.date, input.slot);
      const timestamp = new Date(this.store.now()).toISOString();
      const scheduledAt = input.scheduledAt ? new Date(input.scheduledAt).toISOString()
        : existing?.scheduledAt ?? new Date(`${input.date}T${slotTime(input.slot)}:00+09:00`).toISOString();
      const sections: Briefing["sections"] = { ...existing?.sections };
      const changed: BriefingSectionKey[] = [];
      const added: BriefingSectionKey[] = [];
      for (const key of BRIEFING_SECTIONS) {
        const next = input.sections[key];
        if (!next) continue;
        const previous = sections[key];
        if (previous && canonical({ items: previous.items, shortfall: previous.shortfall }) === canonical(next)) continue;
        if ((previous?.items.length ?? 0) === 0 && next.items.length > 0) added.push(key);
        changed.push(key);
        Object.assign(sections, { [key]: { ...next, updatedAt: timestamp } });
      }
      if (existing && changed.length === 0 && existing.scheduledAt === scheduledAt) return { briefing: existing, created: false, changed, added };
      const reads = Object.fromEntries(BRIEFING_PARTS.map(part => {
        const before = existing ? partReadAt(existing, part) : null;
        const read = added.some(key => partOfSection(key) === part) ? null : hasItems(sections, part) ? before : before ?? timestamp;
        return [part, read];
      })) as Record<BriefingPart, string | null>;
      const briefing = BriefingSchema.parse({
        id: existing?.id ?? crypto.randomUUID(), date: input.date, slot: input.slot, scheduledAt, sections,
        createdBy: existing?.createdBy ?? principal.id, createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp,
        version: (existing?.version ?? 0) + 1, newsReadAt: reads.news, mailReadAt: reads.mail, readAt: bothRead(reads.news, reads.mail),
      });
      this.store.db.query(`INSERT INTO briefings(id,date,slot,scheduled_at,sections,created_by,created_at,updated_at,version,news_read_at,mail_read_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET scheduled_at=excluded.scheduled_at,sections=excluded.sections,
        updated_at=excluded.updated_at,version=excluded.version,news_read_at=excluded.news_read_at,mail_read_at=excluded.mail_read_at`)
        .run(briefing.id, briefing.date, briefing.slot, briefing.scheduledAt, JSON.stringify(briefing.sections), briefing.createdBy,
          briefing.createdAt, briefing.updatedAt, briefing.version, briefing.newsReadAt, briefing.mailReadAt);
      return { briefing, created: existing === null, changed, added };
    }).immediate();
  }

  /**
   * Summaries from `from` to `to` (Seoul dates, default the last 14 days), newest scheduled first. `unread` counts unread parts
   * (a morning with unread news and mail counts twice); `parts` gives each part's unread count and its first date.
   */
  list(raw: Record<string, string>) {
    const query = rangeSchema.parse(raw);
    const to = query.to ?? seoulDay(this.store.now());
    const from = query.from ?? shiftDay(to, -13);
    if (from > to) throw new ApiError(400, "invalid_query", "from must not follow to");
    if (Date.parse(to) - Date.parse(from) > BRIEFING_LIMITS.rangeDays * DAY_MS) throw new ApiError(400, "invalid_query", `Ask for at most ${BRIEFING_LIMITS.rangeDays} days`);
    const db = this.store.db;
    const items = db.query("SELECT * FROM briefings WHERE date>=? AND date<=? ORDER BY scheduled_at DESC, id DESC").all(from, to).map(row => summarize(toBriefing(row)));
    const totals = z.object({ news: z.number(), mail: z.number(), newsEarliest: z.string().nullable(), mailEarliest: z.string().nullable(),
      earliest: z.string().nullable(), latest: z.string().nullable() })
      .parse(db.query(`SELECT count(news_read_at IS NULL OR NULL) AS news, count(mail_read_at IS NULL OR NULL) AS mail,
        min(CASE WHEN ${presentSql("news")} THEN date END) AS newsEarliest, min(CASE WHEN ${presentSql("mail")} THEN date END) AS mailEarliest,
        min(date) AS earliest, max(date) AS latest FROM briefings`).get());
    return { items, from, to, unread: totals.news + totals.mail, earliestDate: totals.earliest, latestDate: totals.latest,
      parts: { news: { unread: totals.news, earliestDate: totals.newsEarliest }, mail: { unread: totals.mail, earliestDate: totals.mailEarliest } } };
  }

  /** Marks one part, or both without `part`. Marking unread only touches a part that has something to read. */
  markRead(id: string, read: boolean, part?: BriefingPart): BriefingSummary {
    const current = this.get(id);
    const timestamp = new Date(this.store.now()).toISOString();
    const reads = { news: current.newsReadAt, mail: current.mailReadAt };
    for (const each of part ? [part] : BRIEFING_PARTS) {
      if (read) reads[each] ??= timestamp;
      else if (hasItems(current.sections, each)) reads[each] = null;
    }
    this.store.db.query(`UPDATE briefings SET ${readColumn.news}=?, ${readColumn.mail}=? WHERE id=?`).run(reads.news, reads.mail, id);
    return summarize({ ...current, newsReadAt: reads.news, mailReadAt: reads.mail, readAt: bothRead(reads.news, reads.mail) });
  }

  /** Articles (title, summary, source) and mail (sender, subject, summary, action) matching every briefing, newest first; `part` keeps to one. */
  search(raw: Record<string, string>): { items: BriefingHit[] } {
    const query = searchSchema.parse(raw);
    const needle = query.q.toLowerCase();
    const hits: BriefingHit[] = [];
    for (const row of this.store.db.query("SELECT * FROM briefings ORDER BY scheduled_at DESC, id DESC").iterate()) {
      const briefing = toBriefing(row);
      const base = { briefingId: briefing.id, date: briefing.date, slot: briefing.slot, scheduledAt: briefing.scheduledAt };
      for (const item of query.part === "news" ? [] : briefing.sections.mail?.items ?? []) {
        if (matches(needle, [item.from, item.address, item.subject, item.summary, item.action])) hits.push({ ...base, section: "mail", item });
      }
      for (const key of query.part === "mail" ? [] : NEWS_SECTIONS) for (const item of briefing.sections[key]?.items ?? []) {
        if (matches(needle, [item.title, item.summary, item.source])) hits.push({ ...base, section: key, item });
      }
      if (hits.length >= query.limit) break;
    }
    return { items: hits.slice(0, query.limit) };
  }

  /**
   * One part of a briefing as a note-shaped record for narration (듣기), with its label: the part's sections in order, each
   * item as one line. `narrationId` is the part's id (`briefingPartId`); null when there is no such briefing or part.
   */
  narrationSource(narrationId: string): { record: DashboardRecord; label: string } | null {
    const { id, part } = briefingOfPartId(narrationId);
    if (!this.exists(id)) return null;
    const briefing = this.get(id);
    const keys = PART_SECTIONS[part].filter(key => briefing.sections[key] !== undefined);
    if (keys.length === 0) return null;
    const [, month = "", day = ""] = briefing.date.split("-");
    const lines: string[] = [];
    const mail = (item: BriefingMail) => `- [${MAIL_IMPORTANCE_LABELS[item.importance]}] ${item.from}: ${item.subject}. ${item.summary}${item.action ? ` ${item.action}` : ""}`;
    const article = (item: BriefingArticle) => `- ${item.title}${item.source ? ` (${item.source})` : ""}: ${item.summary}`;
    for (const key of keys) {
      const section = briefing.sections[key];
      if (!section?.items.length) continue;
      lines.push(`## ${BRIEFING_SECTION_LABELS[key]}`, ...(key === "mail" ? (section.items as BriefingMail[]).map(mail) : (section.items as BriefingArticle[]).map(article)), "");
    }
    const counts = keys.filter(key => briefing.sections[key]?.items.length)
      .map(key => `${BRIEFING_SECTION_LABELS[key]} ${briefing.sections[key]?.items.length}건`).join(", ");
    const label = `${BRIEFING_PART_LABELS[part]} 브리핑`;
    return { label, record: { id: narrationId, kind: "note", title: `${Number(month)}월 ${Number(day)}일 ${slotLabel(briefing.slot)} ${label}`, body: lines.join("\n").trim(),
      status: "new", projectId: null, taskId: null, dueDate: null, tags: [], links: [], fields: { summary: counts },
      source: briefing.createdBy, createdBy: briefing.createdBy, reviewState: "approved", archivedAt: null,
      createdAt: briefing.createdAt, updatedAt: briefing.updatedAt, version: briefing.version } };
  }
}
