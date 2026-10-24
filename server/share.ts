import { z } from "zod";
import type { DashboardRecord } from "../shared/contracts";
import { zonedDate } from "../shared/time";
import { Store } from "./store";
import { ControlDb } from "./control-db";
import { TenantDb } from "./tenant-db";

export interface Share { readonly code: string; readonly url: string; readonly createdAt: string }

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const row = z.object({ code: z.string(), record_id: z.string(), created_at: z.string() });
const kindLabels: Record<DashboardRecord["kind"], string> = {
  research: "Research", "work-report": "Work report", note: "Note", social: "Link", task: "Task", project: "Project",
};
const sourceLabel = (source: string) => source === "manual" ? "Owner" : source;
const labels = {
  en: { kind: "Kind", source: "Source", owner: "Owner", saved: "Saved", continues: "Continues", status: "Status", due: "Due",
    code: "Share code", conclusion: "Conclusion", summary: "Summary", body: "Body", next: "Next actions", links: "Links", tags: "Tags",
    kinds: kindLabels },
  ko: { kind: "종류", source: "출처", owner: "소유자", saved: "저장일", continues: "이전 기록", status: "상태", due: "마감일",
    code: "공유 코드", conclusion: "결론", summary: "요약", body: "본문", next: "다음 할 일", links: "링크", tags: "태그",
    kinds: { research: "조사", "work-report": "작업 보고", note: "메모", social: "링크", task: "할 일", project: "프로젝트" } },
} as const;

/** 12 Crockford base32 characters (60 random bits) grouped as XXXX-XXXX-XXXX. */
export function generateCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const chars = [...bytes].map(byte => ALPHABET[byte & 31]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8)}`;
}

/** Case-insensitive, dash/whitespace-optional lookup with O->0 and I/L->1; null when not a valid code. */
export function normalizeCode(input: string): string | null {
  const chars = input.toUpperCase().replace(/[\s-]/g, "").replaceAll("O", "0").replace(/[IL]/g, "1");
  if (!/^[0-9A-HJKMNP-TV-Z]{12}$/.test(chars)) return null;
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8)}`;
}

const text = (value: unknown) => typeof value === "string" ? value : "";

/** Public projection of a record: never includes personalNotes or internal fields. */
export function projectRecord(record: DashboardRecord) {
  return {
    id: record.id, kind: record.kind, title: record.title, source: record.source, status: record.status,
    dueDate: record.dueDate, archived: record.archivedAt !== null, createdAt: record.createdAt, updatedAt: record.updatedAt,
    summary: text(record.fields.summary), conclusion: text(record.fields.conclusion),
    nextActions: text(record.fields.nextActions), nextAction: text(record.fields.nextAction),
    body: record.body, links: record.links.map(link => ({ label: link.label, url: link.url })), tags: [...record.tags],
    previousId: typeof record.fields.previousId === "string" ? record.fields.previousId : null,
  };
}

export function renderMarkdown(record: DashboardRecord, share: Share, titleOf: (id: string) => string | null = () => null, timeZone = "UTC", locale: "en" | "ko" = "en"): string {
  const t = labels[locale];
  const view = projectRecord(record);
  const meta = [`- ${t.kind}: ${t.kinds[record.kind]}`, `- ${t.source}: ${record.source === "manual" ? t.owner : sourceLabel(record.source)}`,
    `- ${t.saved}: ${zonedDate(new Date(record.createdAt), timeZone)}`];
  if (view.previousId) {
    const title = titleOf(view.previousId);
    meta.push(`- ${t.continues}: ${title === null ? view.previousId : `${title} (${view.previousId})`}`);
  }
  if (record.kind === "task") {
    meta.push(`- ${t.status}: ${record.status}`);
    if (record.dueDate) meta.push(`- ${t.due}: ${record.dueDate}`);
  }
  meta.push(`- ${t.code}: ${share.code}`);
  const sections: string[] = [`# ${record.title}`, meta.join("\n")];
  const section = (heading: string, content: string) => { if (content.trim()) sections.push(`## ${heading}\n\n${content.trim()}`); };
  section(t.conclusion, view.conclusion);
  section(t.summary, view.summary);
  section(t.body, view.body);
  section(t.next, record.kind === "project" ? view.nextAction || view.nextActions : view.nextActions || view.nextAction);
  section(t.links, view.links.map(link => `- [${link.label.trim() || link.url}](${link.url})`).join("\n"));
  section(t.tags, view.tags.map(tag => `- #${tag}`).join("\n"));
  return `${sections.join("\n\n")}\n`;
}

export class Shares {
  constructor(private readonly store: Store, private readonly origin: string, readonly timeZone = "UTC") {}
  private view(value: unknown): Share {
    const entry = row.parse(value);
    return { code: entry.code, url: `${this.origin}/s/${entry.code}`, createdAt: entry.created_at };
  }
  readonly titleOf = async (recordId: string): Promise<string | null> => {
    const value = (await this.store.db.get("SELECT json_extract(data,'$.title') AS title FROM records WHERE (id=?) AND user_id=?", [recordId]));
    return value ? z.object({ title: z.string() }).parse(value).title : null;
  };
  async get(recordId: string): Promise<Share | null> {
    const value = (await this.store.db.get("SELECT code,record_id,created_at FROM shares WHERE (record_id=?) AND user_id=?", [recordId]));
    return value ? this.view(value) : null;
  }
  async create(recordId: string): Promise<{ share: Share; created: boolean }> {
    return await this.store.db.tx(async () => {
      const existing = (await this.get(recordId));
      if (existing) return { share: existing, created: false };
      const createdAt = new Date(this.store.now()).toISOString();
      // A primary-key collision on 60 random bits is practically impossible; retry anyway rather than fail.
      for (;;) {
        const code = generateCode();
        const result = (await this.store.db.run("INSERT OR IGNORE INTO shares(code,record_id,created_at,user_id) VALUES(?,?,?,?)", [code, recordId, createdAt]));
        if (result.changes === 1) return { share: { code, url: `${this.origin}/s/${code}`, createdAt }, created: true };
      }
    });
  }
  async revoke(recordId: string) {
    (await this.store.db.run("DELETE FROM shares WHERE (record_id=?) AND user_id=?", [recordId]));
  }
  async find(input: string) {
    const code = normalizeCode(input);
    if (!code) return null;
    const value = await new ControlDb(this.store.db.sql).shareByCode(code);
    if (!value) return null;
    const share = this.view(value);
    return { share, record: await new Store(new TenantDb(this.store.db.sql, value.user_id), this.store.now).get(value.record_id), userId: value.user_id };
  }
}
