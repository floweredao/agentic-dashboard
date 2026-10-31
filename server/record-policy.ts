import { TITLE_MAX_WIDTH, titleWidth } from "../shared/contracts";
import type { DashboardRecord, RecordKind, Source } from "../shared/contracts";
import { ApiError } from "./errors";
export interface Principal { readonly id: string; readonly source: Source }
export const CONTINUABLE: ReadonlySet<RecordKind> = new Set(["research", "work-report", "note", "social"]);
/** Kinds every agent may read whoever saved them, while unarchived. Tasks, projects and archived records stay with their creator and the owner. */
export const AGENT_READABLE_KINDS = ["research", "work-report", "note", "social"] as const;
/** Every registered agent works with the owner on the Work tab: it also reads the owner's unarchived tasks and projects (never edits them). */
export const SHARED_WORK_KINDS = ["task", "project"] as const;
export function agentCanRead(principal: Principal, record: DashboardRecord) {
  if (record.createdBy === principal.id) return true;
  if (record.archivedAt !== null) return false;
  return AGENT_READABLE_KINDS.some(kind => kind === record.kind)
    || (record.createdBy === "owner" && SHARED_WORK_KINDS.some(kind => kind === record.kind));
}
/** What an agent sees of a record: everything, except the owner's personal notes on records it did not create. */
export function agentView(principal: Principal, record: DashboardRecord): DashboardRecord {
  if (record.createdBy === principal.id) return record;
  const { personalNotes: _private, ...fields } = record.fields;
  return { ...record, fields };
}
export function checkTitle(title: string) {
  const width = titleWidth(title.trim());
  if (width > TITLE_MAX_WIDTH) throw new ApiError(400, "title_too_long", `Title is ${width} columns; keep it within ${TITLE_MAX_WIDTH} (Hangul and CJK count 2, about 18 Korean characters). Keep the subject and the key point, drop dates, parentheses and qualifiers, and move detail to fields.summary.`);
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
