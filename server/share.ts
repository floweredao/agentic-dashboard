import { z } from "zod";
import type { DashboardRecord } from "../shared/contracts";
import { zonedDate } from "../shared/time";
import type { Store } from "./store";

export interface Share { readonly code: string; readonly url: string; readonly createdAt: string }

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const row = z.object({ code: z.string(), record_id: z.string(), created_at: z.string() });
const kindLabels: Record<DashboardRecord["kind"], string> = {
  research: "Research", "work-report": "Work report", note: "Note", social: "Link", task: "Task", project: "Project",
};
const sourceLabel = (source: string) => source === "manual" ? "Owner" : source;

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

export function renderMarkdown(record: DashboardRecord, share: Share, titleOf: (id: string) => string | null = () => null, timeZone = "UTC"): string {
  const view = projectRecord(record);
  const meta = [`- Kind: ${kindLabels[record.kind]}`, `- Source: ${sourceLabel(record.source)}`,
    `- Saved: ${zonedDate(new Date(record.createdAt), timeZone)}`];
  if (view.previousId) {
    const title = titleOf(view.previousId);
    meta.push(`- Continues: ${title === null ? view.previousId : `${title} (${view.previousId})`}`);
  }
  if (record.kind === "task") {
    meta.push(`- Status: ${record.status}`);
    if (record.dueDate) meta.push(`- Due: ${record.dueDate}`);
  }
  meta.push(`- Share code: ${share.code}`);
  const sections: string[] = [`# ${record.title}`, meta.join("\n")];
  const section = (heading: string, content: string) => { if (content.trim()) sections.push(`## ${heading}\n\n${content.trim()}`); };
  section("Conclusion", view.conclusion);
  section("Summary", view.summary);
  section("Body", view.body);
  section("Next actions", record.kind === "project" ? view.nextAction || view.nextActions : view.nextActions || view.nextAction);
  section("Links", view.links.map(link => `- [${link.label.trim() || link.url}](${link.url})`).join("\n"));
  section("Tags", view.tags.map(tag => `- #${tag}`).join("\n"));
  return `${sections.join("\n\n")}\n`;
}

export class Shares {
  constructor(private readonly store: Store, private readonly origin: string, readonly timeZone = "UTC") {
    store.db.run(`CREATE TABLE IF NOT EXISTS shares(code TEXT PRIMARY KEY,
      record_id TEXT NOT NULL UNIQUE REFERENCES records(id) ON DELETE CASCADE, created_at TEXT NOT NULL)`);
  }
  private view(value: unknown): Share {
    const entry = row.parse(value);
    return { code: entry.code, url: `${this.origin}/s/${entry.code}`, createdAt: entry.created_at };
  }
  readonly titleOf = (recordId: string): string | null => {
    const value = this.store.db.query("SELECT json_extract(data,'$.title') AS title FROM records WHERE id=?").get(recordId);
    return value ? z.object({ title: z.string() }).parse(value).title : null;
  };
  get(recordId: string): Share | null {
    const value = this.store.db.query("SELECT code,record_id,created_at FROM shares WHERE record_id=?").get(recordId);
    return value ? this.view(value) : null;
  }
  create(recordId: string): { share: Share; created: boolean } {
    return this.store.db.transaction(() => {
      const existing = this.get(recordId);
      if (existing) return { share: existing, created: false };
      const createdAt = new Date(this.store.now()).toISOString();
      // A primary-key collision on 60 random bits is practically impossible; retry anyway rather than fail.
      for (;;) {
        const code = generateCode();
        const result = this.store.db.query("INSERT OR IGNORE INTO shares(code,record_id,created_at) VALUES(?,?,?)").run(code, recordId, createdAt);
        if (result.changes === 1) return { share: { code, url: `${this.origin}/s/${code}`, createdAt }, created: true };
      }
    }).immediate();
  }
  revoke(recordId: string) {
    this.store.db.query("DELETE FROM shares WHERE record_id=?").run(recordId);
  }
  find(input: string): { share: Share; record: DashboardRecord } | null {
    const code = normalizeCode(input);
    if (!code) return null;
    const value = this.store.db.query("SELECT code,record_id,created_at FROM shares WHERE code=?").get(code);
    if (!value) return null;
    const share = this.view(value);
    return { share, record: this.store.get(row.parse(value).record_id) };
  }
}
