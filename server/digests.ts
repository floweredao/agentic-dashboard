import { z } from "zod";
import { DIGEST_LIMITS, DIGEST_PARTS, digestOfPartId, DigestPartSchema, DigestSchema, DateSchema, MESSAGE_IMPORTANCE } from "../shared/contracts";
import type { DashboardRecord, Digest, DigestArticle, DigestHit, DigestInput, DigestMessage, DigestPart, DigestSection, DigestSummary } from "../shared/contracts";
import { zonedDate, zonedInstant } from "../shared/time";
import { ApiError } from "./errors";
import { canonical, type Principal, type Store } from "./store";

const DAY_MS = 24 * 60 * 60 * 1000;
const rowSchema = z.object({
  id: z.string(), date: z.string(), slot: z.string(), scheduled_at: z.string(), sections: z.string(), created_by: z.string(),
  created_at: z.string(), updated_at: z.string(), version: z.number().int(), articles_read_at: z.string().nullable(), messages_read_at: z.string().nullable(),
});
const rangeSchema = z.object({ from: DateSchema.optional(), to: DateSchema.optional() }).strict();
const searchSchema = z.object({ q: z.string().trim().min(1).max(100), limit: z.coerce.number().int().min(1).max(50).default(30), part: DigestPartSchema.optional() }).strict();
/** SQL over the `sections` JSON array: whether the digest has a section of a kind. */
const presentSql = (part: DigestPart) => `EXISTS (SELECT 1 FROM json_each(digests.sections) WHERE json_extract(value,'$.kind')='${part}')`;
export const partReadAt = (digest: Pick<Digest, "articlesReadAt" | "messagesReadAt">, part: DigestPart) => part === "messages" ? digest.messagesReadAt : digest.articlesReadAt;
const hasItems = (sections: readonly DigestSection[], part: DigestPart) => sections.some(section => section.kind === part && section.items.length > 0);
/** Read when both parts are: the later of the two times. */
const bothRead = (articles: string | null, messages: string | null) => articles && messages ? articles > messages ? articles : messages : null;

export const slotTime = (slot: string) => slot === "morning" ? "08:00" : slot === "evening" ? "21:00" : slot;
const shiftDay = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

function toDigest(value: unknown): Digest {
  const row = rowSchema.parse(value);
  return DigestSchema.parse({ id: row.id, date: row.date, slot: row.slot, scheduledAt: row.scheduled_at, sections: JSON.parse(row.sections),
    createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at, version: row.version,
    articlesReadAt: row.articles_read_at, messagesReadAt: row.messages_read_at, readAt: bothRead(row.articles_read_at, row.messages_read_at) });
}
const articleLists = (digest: Pick<Digest, "sections">, keys?: readonly string[]): DigestArticle[][] =>
  digest.sections.flatMap(section => section.kind === "articles" && (!keys || keys.includes(section.key)) ? [section.items] : []);
const messagesOf = (digest: Pick<Digest, "sections">, keys?: readonly string[]): DigestMessage[] =>
  digest.sections.flatMap(section => section.kind === "messages" && (!keys || keys.includes(section.key)) ? section.items : []);
/** The first headline of each article section, then the second of each, and so on: a mix of sections rather than one section's top three. */
export function headlines(digest: Pick<Digest, "sections">, count = 3, keys?: readonly string[]): string[] {
  const lists = articleLists(digest, keys);
  const picked: string[] = [];
  for (let index = 0; picked.length < count && lists.some(list => index < list.length); index += 1) {
    for (const list of lists) { const item = list[index]; if (item && picked.length < count) picked.push(item.title); }
  }
  return picked;
}
/** The message that matters most (first by importance, then by order), or null. */
export const topMessage = (messages: readonly DigestMessage[]) =>
  messages.reduce<DigestMessage | null>((best, item) => !best || MESSAGE_IMPORTANCE.indexOf(item.importance) < MESSAGE_IMPORTANCE.indexOf(best.importance) ? item : best, null);
export function summarize(digest: Digest): DigestSummary {
  const { sections, ...rest } = digest;
  const messages = messagesOf(digest);
  return { ...rest, counts: Object.fromEntries(sections.map(section => [section.key, section.items.length])),
    outline: sections.map(section => ({ key: section.key, title: section.title, kind: section.kind, items: section.items.length })),
    headlines: headlines(digest), messageHeadline: topMessage(messages)?.subject ?? null,
    urgent: messages.filter(item => item.importance === "urgent").length, todo: messages.filter(item => item.importance === "todo").length };
}
const matches = (needle: string, values: readonly string[]) => values.some(value => value.toLowerCase().includes(needle));

/**
 * Digests collected by agents, kept apart from records. A digest is keyed by its date and slot; an upload replaces the
 * sections with the keys it carries and keeps the others, so a late section can arrive on its own and an identical retry
 * changes nothing. The article sections and the message sections are read apart (`articles_read_at`, `messages_read_at`).
 */
export class Digests {
  constructor(readonly store: Store, readonly timeZone: string) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS digests(id TEXT PRIMARY KEY, date TEXT NOT NULL, slot TEXT NOT NULL, scheduled_at TEXT NOT NULL,
        sections TEXT NOT NULL CHECK(json_valid(sections)), created_by TEXT NOT NULL REFERENCES principals(id), created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, version INTEGER NOT NULL, articles_read_at TEXT, messages_read_at TEXT, UNIQUE(date, slot));
      CREATE INDEX IF NOT EXISTS digests_scheduled ON digests(scheduled_at);`);
  }

  private find(date: string, slot: string): Digest | null {
    const row = this.store.db.query("SELECT * FROM digests WHERE date=? AND slot=?").get(date, slot);
    return row ? toDigest(row) : null;
  }
  get(id: string): Digest {
    const row = this.store.db.query("SELECT * FROM digests WHERE id=?").get(id);
    if (!row) throw new ApiError(404, "not_found", "Digest not found");
    return toDigest(row);
  }
  exists(id: string) { return this.store.db.query("SELECT 1 FROM digests WHERE id=?").get(id) !== null; }

  /**
   * `changed`: section keys whose content (title, items, shortfall) differs from what was stored. `added`: sections that had
   * no items before and have some now, which is what a notification is about. A part gets unread again when one of its
   * sections is added; a part with nothing to read counts as read.
   */
  upsert(principal: Principal, input: DigestInput): { digest: Digest; created: boolean; changed: string[]; added: string[] } {
    return this.store.db.transaction(() => {
      const existing = this.find(input.date, input.slot);
      const timestamp = new Date(this.store.now()).toISOString();
      const scheduledAt = input.scheduledAt ? new Date(input.scheduledAt).toISOString()
        : existing?.scheduledAt ?? new Date(zonedInstant(input.date, slotTime(input.slot), this.timeZone)).toISOString();
      const sections: DigestSection[] = [...existing?.sections ?? []];
      const changed: string[] = [];
      const added: string[] = [];
      for (const next of input.sections) {
        const index = sections.findIndex(section => section.key === next.key);
        const previous = index >= 0 ? sections[index] : undefined;
        if (previous && canonical({ key: previous.key, title: previous.title, kind: previous.kind, items: previous.items, shortfall: previous.shortfall }) === canonical(next)) continue;
        if ((previous?.items.length ?? 0) === 0 && next.items.length > 0) added.push(next.key);
        changed.push(next.key);
        const section = { ...next, updatedAt: timestamp } as DigestSection;
        if (index >= 0) sections[index] = section; else sections.push(section);
      }
      if (existing && changed.length === 0 && existing.scheduledAt === scheduledAt) return { digest: existing, created: false, changed, added };
      const kindOf = (key: string) => sections.find(section => section.key === key)?.kind;
      const reads = Object.fromEntries(DIGEST_PARTS.map(part => {
        const before = existing ? partReadAt(existing, part) : null;
        const read = added.some(key => kindOf(key) === part) ? null : hasItems(sections, part) ? before : before ?? timestamp;
        return [part, read];
      })) as Record<DigestPart, string | null>;
      const digest = DigestSchema.parse({
        id: existing?.id ?? crypto.randomUUID(), date: input.date, slot: input.slot, scheduledAt, sections,
        createdBy: existing?.createdBy ?? principal.id, createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp,
        version: (existing?.version ?? 0) + 1, articlesReadAt: reads.articles, messagesReadAt: reads.messages, readAt: bothRead(reads.articles, reads.messages),
      });
      this.store.db.query(`INSERT INTO digests(id,date,slot,scheduled_at,sections,created_by,created_at,updated_at,version,articles_read_at,messages_read_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET scheduled_at=excluded.scheduled_at,sections=excluded.sections,
        updated_at=excluded.updated_at,version=excluded.version,articles_read_at=excluded.articles_read_at,messages_read_at=excluded.messages_read_at`)
        .run(digest.id, digest.date, digest.slot, digest.scheduledAt, JSON.stringify(digest.sections), digest.createdBy,
          digest.createdAt, digest.updatedAt, digest.version, digest.articlesReadAt, digest.messagesReadAt);
      return { digest, created: existing === null, changed, added };
    }).immediate();
  }

  /**
   * Summaries from `from` to `to` (dates in the dashboard's zone, default the last 14 days), newest scheduled first. `unread`
   * counts unread parts (a digest with unread articles and messages counts twice); `parts` gives each part's unread count and first date.
   */
  list(raw: Record<string, string>) {
    const query = rangeSchema.parse(raw);
    const to = query.to ?? zonedDate(new Date(this.store.now()), this.timeZone);
    const from = query.from ?? shiftDay(to, -13);
    if (from > to) throw new ApiError(400, "invalid_query", "from must not follow to");
    if (Date.parse(to) - Date.parse(from) > DIGEST_LIMITS.rangeDays * DAY_MS) throw new ApiError(400, "invalid_query", `Ask for at most ${DIGEST_LIMITS.rangeDays} days`);
    const db = this.store.db;
    const items = db.query("SELECT * FROM digests WHERE date>=? AND date<=? ORDER BY scheduled_at DESC, id DESC").all(from, to).map(row => summarize(toDigest(row)));
    const totals = z.object({ articles: z.number(), messages: z.number(), articlesEarliest: z.string().nullable(), messagesEarliest: z.string().nullable(),
      earliest: z.string().nullable(), latest: z.string().nullable() })
      .parse(db.query(`SELECT count(articles_read_at IS NULL OR NULL) AS articles, count(messages_read_at IS NULL OR NULL) AS messages,
        min(CASE WHEN ${presentSql("articles")} THEN date END) AS articlesEarliest, min(CASE WHEN ${presentSql("messages")} THEN date END) AS messagesEarliest,
        min(date) AS earliest, max(date) AS latest FROM digests`).get());
    return { items, from, to, unread: totals.articles + totals.messages, earliestDate: totals.earliest, latestDate: totals.latest,
      parts: { articles: { unread: totals.articles, earliestDate: totals.articlesEarliest }, messages: { unread: totals.messages, earliestDate: totals.messagesEarliest } } };
  }

  /** Marks one part, or both without `part`. Marking unread only touches a part that has something to read. */
  markRead(id: string, read: boolean, part?: DigestPart): DigestSummary {
    const current = this.get(id);
    const timestamp = new Date(this.store.now()).toISOString();
    const reads = { articles: current.articlesReadAt, messages: current.messagesReadAt };
    for (const each of part ? [part] : DIGEST_PARTS) {
      if (read) reads[each] ??= timestamp;
      else if (hasItems(current.sections, each)) reads[each] = null;
    }
    this.store.db.query("UPDATE digests SET articles_read_at=?, messages_read_at=? WHERE id=?").run(reads.articles, reads.messages, id);
    return summarize({ ...current, articlesReadAt: reads.articles, messagesReadAt: reads.messages, readAt: bothRead(reads.articles, reads.messages) });
  }

  /** Articles (title, summary, source) and messages (sender, subject, summary, action) matching, newest digest first; `part` keeps to one kind. */
  search(raw: Record<string, string>): { items: DigestHit[] } {
    const query = searchSchema.parse(raw);
    const needle = query.q.toLowerCase();
    const hits: DigestHit[] = [];
    for (const row of this.store.db.query("SELECT * FROM digests ORDER BY scheduled_at DESC, id DESC").iterate()) {
      const digest = toDigest(row);
      const base = { digestId: digest.id, date: digest.date, slot: digest.slot, scheduledAt: digest.scheduledAt };
      for (const section of digest.sections) {
        if (query.part && section.kind !== query.part) continue;
        const head = { ...base, section: section.key, sectionTitle: section.title, kind: section.kind };
        if (section.kind === "messages") {
          for (const item of section.items) if (matches(needle, [item.from, item.address, item.subject, item.summary, item.action])) hits.push({ ...head, item });
        } else {
          for (const item of section.items) if (matches(needle, [item.title, item.summary, item.source])) hits.push({ ...head, item });
        }
      }
      if (hits.length >= query.limit) break;
    }
    return { items: hits.slice(0, query.limit) };
  }

  /**
   * One part of a digest as a note-shaped record for narration, with its label: the part's sections in order under their
   * titles, each item as one line. `narrationId` is the part's id (`digestPartId`); null when there is no such digest or part.
   */
  narrationSource(narrationId: string): { record: DashboardRecord; label: string } | null {
    const { id, part } = digestOfPartId(narrationId);
    if (!this.exists(id)) return null;
    const digest = this.get(id);
    const sections = digest.sections.filter(section => section.kind === part);
    if (sections.length === 0) return null;
    const lines: string[] = [];
    const message = (item: DigestMessage) => `- [${item.importance}] ${item.from}: ${item.subject}. ${item.summary}${item.action ? ` ${item.action}` : ""}`;
    const article = (item: DigestArticle) => `- ${item.title}${item.source ? ` (${item.source})` : ""}: ${item.summary}`;
    for (const section of sections) {
      if (!section.items.length) continue;
      lines.push(`## ${section.title}`, ...(section.kind === "messages" ? section.items.map(message) : section.items.map(article)), "");
    }
    const counts = sections.filter(section => section.items.length).map(section => `${section.title} ${section.items.length}`).join(", ");
    const label = part === "messages" ? "Digest messages" : "Digest articles";
    return { label, record: { id: narrationId, kind: "note", title: `${digest.date} ${digest.slot} ${label.toLowerCase()}`, body: lines.join("\n").trim(),
      status: "new", projectId: null, taskId: null, dueDate: null, tags: [], links: [], fields: { summary: counts },
      source: digest.createdBy, createdBy: digest.createdBy, reviewState: "approved", archivedAt: null,
      createdAt: digest.createdAt, updatedAt: digest.updatedAt, version: digest.version } };
  }
}
