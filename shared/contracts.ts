import { z } from "zod";

export const RecordKindSchema = z.enum(["project", "task", "research", "work-report", "note", "social"]);
/** Who wrote a record: `manual` is the owner, any other value is the name of a registered agent. */
export const SourceSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
export const OWNER_SOURCE = "manual";
/** Registered agent names: lowercase letters, digits and dashes, starting with a letter; `manual` and `owner` are reserved. */
export const AgentNameSchema = SourceSchema.refine(name => name !== OWNER_SOURCE && name !== "owner", "manual and owner are reserved names");
export const ReviewStateSchema = z.enum(["pending", "approved", "rejected"]);
export const DateSchema = z.iso.date();
export type RecordKind = z.infer<typeof RecordKindSchema>;
export type Source = z.infer<typeof SourceSchema>;
export type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue };
export const JSONValueSchema: z.ZodType<JSONValue> = z.lazy(() => z.union([
  z.string(), z.number().finite(), z.boolean(), z.null(), z.array(JSONValueSchema), z.record(z.string(), JSONValueSchema),
]));

function withinDepth(value: JSONValue, depth = 0): boolean {
  if (depth > 8) return false;
  if (value === null || typeof value !== "object") return true;
  return Object.values(value).every(child => withinDepth(child, depth + 1));
}
const knownFields = z.object({
  goal: z.string().optional(), stage: z.string().optional(), nextAction: z.string().optional(),
  priority: z.enum(["high", "normal", "low"]).optional(), decisions: z.string().optional(),
  taskType: z.enum(["general", "project"]).optional(), today: z.boolean().optional(),
  acceptance: z.string().optional(), progress: z.string().optional(), result: z.string().optional(),
  evidenceIds: z.array(z.string().uuid()).max(100).optional(), previousId: z.string().uuid().optional(),
  origin: z.enum(["manual", "x", "threads", "other"]).optional(),
  summary: z.string().optional(), conclusion: z.string().optional(), significance: z.string().optional(),
  questions: z.string().optional(), nextActions: z.string().optional(), personalNotes: z.string().optional(),
  savedReason: z.string().optional(), starred: z.boolean().optional(), revisitDate: DateSchema.nullable().optional(),
}).passthrough();
const FieldsSchema = z.record(z.string().max(100), JSONValueSchema).superRefine((value, ctx) => {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 8192) ctx.addIssue({ code: "custom", message: "fields exceeds 8 KiB" });
  if (!withinDepth(value)) ctx.addIssue({ code: "custom", message: "fields exceeds depth 8" });
  const known = knownFields.safeParse(value);
  if (!known.success) for (const issue of known.error.issues) ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
});
export const TITLE_MAX_WIDTH = 40;
const pictographic = /^\p{Extended_Pictographic}$/u;
export function titleWidth(title: string): number {
  let width = 0;
  for (const char of title) {
    const c = char.codePointAt(0) ?? 0;
    const wide = (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3)
      || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60)
      || (c >= 0xffe0 && c <= 0xffe6) || pictographic.test(char);
    width += wide ? 2 : 1;
  }
  return width;
}
const inputShape = {
  kind: RecordKindSchema,
  title: z.string().trim().min(1).max(200),
  body: z.string().max(16000).default(""),
  status: z.string().trim().min(1).max(50).default("new"),
  projectId: z.string().uuid().nullable().default(null),
  taskId: z.string().uuid().nullable().default(null),
  dueDate: DateSchema.nullable().default(null),
  tags: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
  links: z.array(z.object({ label: z.string().max(200), url: z.url({ protocol: /^https?$/ }).max(2048) }).strict()).max(10).default([]),
  fields: FieldsSchema.default({}),
};
/** The statuses a project or task may take; other kinds keep "new". */
export const WORK_STATUSES = {
  project: ["new", "idea", "planning", "active", "paused", "done"],
  task: ["new", "todo", "active", "review", "paused", "done"],
} as const;
export const RecordInputSchema = z.object(inputShape).strict().superRefine((record, ctx) => {
  const statuses: readonly string[] | null = record.kind === "project" || record.kind === "task" ? WORK_STATUSES[record.kind] : null;
  if (statuses && !statuses.includes(record.status)) ctx.addIssue({ code: "custom", path: ["status"], message: "Invalid status for kind" });
});
export type RecordInput = z.infer<typeof RecordInputSchema>;

/**
 * The one record format every agent (codex, omo, chatgpt) must follow, whatever its own style. The server checks it on
 * create and answers 400 record_incomplete listing every item, so each agent converges on the same shape.
 */
export const AGENT_TAGS = { min: 1, max: 5, maxWidth: 20 } as const;
export const AGENT_TEXT = { summaryMaxLength: 500, summaryMaxLines: 3, conclusionMaxLength: 300, listPrefix: "- " } as const;
export const AGENT_RECORD_RULES = {
  project: { body: false, links: false, fields: ["nextAction"], required: [] },
  task: { body: false, links: false, fields: ["today", "evidenceIds"], required: [] },
  research: { body: true, links: false, fields: ["summary", "conclusion", "nextActions", "previousId"], required: ["summary", "conclusion", "nextActions"] },
  "work-report": { body: true, links: false, fields: ["summary", "conclusion", "nextActions", "previousId"], required: ["summary", "conclusion", "nextActions"] },
  note: { body: true, links: false, fields: ["summary", "previousId"], required: [] },
  social: { body: false, links: true, fields: ["summary", "previousId"], required: ["summary"] },
} as const satisfies Record<RecordKind, { body: boolean; links: boolean; fields: readonly string[]; required: readonly string[] }>;

export const AGENT_RECORD_GUIDE = "Every agent writes one shared format whatever its own style; other shapes are refused with 400 record_incomplete listing each item to fix. " +
  "research and work-report: body = the full content, fields.summary = 1-3 lines, fields.conclusion = one line, fields.nextActions = one action per line starting with \"- \" (\"- 없음\" when there is none). " +
  "note: body required, fields.summary optional. social: at least one link and fields.summary. task: fields.today and fields.evidenceIds (related record ids) only. project: only fields.nextAction. " +
  "A research, work-report, note or social record that continues an earlier one sets fields.previousId to that earlier record's id. " +
  "tags: 1-5 topic words from the content, without #, spaces or commas. links: every source URL with a label naming the site or document. " +
  "No other field keys and no status except on task and project. Write facts plainly in the user's language, with no persona, greetings or emoji, and never invent conclusions or links.";

export function agentRecordIssues(record: RecordInput): string[] {
  const rule = AGENT_RECORD_RULES[record.kind];
  const allowed: readonly string[] = rule.fields;
  const issues: string[] = [];
  if (rule.body && !record.body.trim()) issues.push("body: write the detailed content");
  if (record.kind !== "project" && record.kind !== "task" && record.status !== "new") issues.push("status: leave it unset for this kind");
  if (rule.links && record.links.length === 0) issues.push("links: include the original link");
  record.links.forEach((link, index) => { if (!link.label.trim()) issues.push(`links.${index}.label: name the site or document`); });
  if (record.tags.length < AGENT_TAGS.min || record.tags.length > AGENT_TAGS.max) issues.push(`tags: give ${AGENT_TAGS.min}-${AGENT_TAGS.max} topic tags`);
  const seen = new Set<string>();
  record.tags.forEach((tag, index) => {
    if (/[#\s,]/.test(tag) || titleWidth(tag) > AGENT_TAGS.maxWidth) issues.push(`tags.${index}: one word without #, spaces or commas, at most ${AGENT_TAGS.maxWidth} columns`);
    if (seen.has(tag.toLowerCase())) issues.push(`tags.${index}: duplicate tag`);
    seen.add(tag.toLowerCase());
  });
  for (const key of Object.keys(record.fields)) {
    if (!allowed.includes(key)) issues.push(`fields.${key}: not part of the ${record.kind} format (allowed: ${allowed.join(", ")})`);
  }
  for (const key of rule.required) {
    const value = record.fields[key];
    if (typeof value !== "string" || !value.trim()) issues.push(`fields.${key}: required`);
  }
  const text = (key: string) => { const value = record.fields[key]; return typeof value === "string" && value.trim() ? value.trim() : null; };
  const summary = text("summary");
  if (summary && (summary.length > AGENT_TEXT.summaryMaxLength || summary.split("\n").length > AGENT_TEXT.summaryMaxLines)) {
    issues.push(`fields.summary: at most ${AGENT_TEXT.summaryMaxLines} lines and ${AGENT_TEXT.summaryMaxLength} characters`);
  }
  for (const key of ["conclusion", "nextAction"]) {
    const value = text(key);
    if (value && (value.includes("\n") || value.length > AGENT_TEXT.conclusionMaxLength)) issues.push(`fields.${key}: one line of at most ${AGENT_TEXT.conclusionMaxLength} characters`);
  }
  const nextActions = text("nextActions");
  if (nextActions && !nextActions.split("\n").filter(line => line.trim()).every(line => line.startsWith(AGENT_TEXT.listPrefix))) {
    issues.push(`fields.nextActions: one action per line, each starting with "${AGENT_TEXT.listPrefix}" ("- 없음" when there is none)`);
  }
  return issues;
}
export const DashboardRecordSchema = z.object({
  ...inputShape, id: z.string().uuid(), source: SourceSchema, createdBy: z.string(),
  reviewState: ReviewStateSchema, archivedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), version: z.number().int().positive(),
}).strict();
export type DashboardRecord = z.infer<typeof DashboardRecordSchema>;
/** Deleted records wait in the owner's trash this many days, then are removed for good. */
export const TRASH_RETENTION_DAYS = 30;
/** One trashed record as it was when deleted; `purgeAt` = `deletedAt` + TRASH_RETENTION_DAYS. */
export const TrashItemSchema = z.object({ record: DashboardRecordSchema, deletedAt: z.iso.datetime(), purgeAt: z.iso.datetime() }).strict();
export type TrashItem = z.infer<typeof TrashItemSchema>;
export const RecordPatchSchema = z.object({
  expectedVersion: z.number().int().positive(),
  changes: z.object({
    title: inputShape.title, body: inputShape.body.unwrap(), status: inputShape.status.unwrap(),
    projectId: inputShape.projectId.unwrap(), taskId: inputShape.taskId.unwrap(),
    dueDate: inputShape.dueDate.unwrap(), tags: inputShape.tags.unwrap(),
    links: inputShape.links.unwrap(), fields: inputShape.fields.unwrap(),
  }).partial().extend({
    reviewState: ReviewStateSchema.optional(), archived: z.boolean().optional(),
  }).strict(),
}).strict();
export type RecordPatch = z.infer<typeof RecordPatchSchema>;

/**
 * One entry on a task or project timeline: an owner comment (source manual), or an agent report or reply.
 * `status` is the status this entry set on the item; seen/done are the agent's marks on an owner comment.
 */
export const CommentSchema = z.object({
  id: z.string().uuid(), recordId: z.string().uuid(), author: z.string(), source: SourceSchema,
  body: z.string(), replyTo: z.string().uuid().nullable(), status: z.string().nullable(), createdAt: z.iso.datetime(),
  seenAt: z.iso.datetime().nullable(), seenBy: z.string().nullable(), doneAt: z.iso.datetime().nullable(), doneBy: z.string().nullable(),
}).strict();
export type Comment = z.infer<typeof CommentSchema>;
/** An owner comment in an agent's queue, with the title of the item it is on. */
export const QueuedCommentSchema = CommentSchema.extend({ recordTitle: z.string() }).strict();
export type QueuedComment = z.infer<typeof QueuedCommentSchema>;
export const COMMENT_MAX_LENGTH = 4000;
/** new: not seen and not done; open: not done; all. */
export const CommentStateSchema = z.enum(["new", "open", "all"]);
export const CommentInputSchema = z.object({
  requestId: z.string().trim().min(1).max(128),
  recordId: z.string().uuid().optional(),
  replyTo: z.string().uuid().optional(),
  body: z.string().trim().max(COMMENT_MAX_LENGTH).default(""),
  status: z.string().trim().min(1).max(50).optional(),
  done: z.boolean().optional(),
}).strict()
  .refine(input => input.recordId !== undefined || input.replyTo !== undefined, { message: "recordId or replyTo is required", path: ["recordId"] })
  .refine(input => input.body !== "" || input.status !== undefined, { message: "Write a body or set a status", path: ["body"] });
export type CommentInput = z.infer<typeof CommentInputSchema>;

/** Record kinds that can be read aloud (듣기): the material kinds. */
export const NARRATABLE_KINDS = ["research", "work-report", "note", "social"] as const;
/**
 * Cost guards for narration: script length, TTS chunk length, model input, queued jobs, generations started per Seoul day,
 * and failed generations per content version before only the owner may try again.
 */
export const NARRATION_LIMITS = { scriptChars: 6000, chunkChars: 1500, sourceChars: 20000, queue: 20, dailyRuns: 20, attempts: 3 } as const;
/** queued -> scripting (listening script) -> speaking (TTS chunks) -> ready | failed. */
export const NarrationStatusSchema = z.enum(["queued", "scripting", "speaking", "ready", "failed"]);
export type NarrationStatus = z.infer<typeof NarrationStatusSchema>;
export const NarrationAudioSchema = z.object({
  url: z.string(), mime: z.string(), bytes: z.number().int().nonnegative(), durationMs: z.number().int().nonnegative(),
  model: z.string(), voice: z.string(), createdAt: z.iso.datetime(),
}).strict();
/**
 * A record's narration: the job state and the last finished audio, which stays playable while a new one is made.
 * `stale`: the audio was made from content (title, summary, conclusion, body, next actions) that has since changed.
 */
export const NarrationSchema = z.object({
  recordId: z.string().uuid(), status: NarrationStatusSchema, stale: z.boolean(),
  progress: z.object({ done: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).strict().nullable(),
  attempts: z.number().int().nonnegative(), error: z.string().nullable(),
  requestedBy: z.string(), requestedAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  audio: NarrationAudioSchema.nullable(), script: z.string().nullable(),
}).strict();
export type Narration = z.infer<typeof NarrationSchema>;
/** GET/POST narration response; `available` is false when no TTS key is configured. */
export const NarrationStateSchema = z.object({ narration: NarrationSchema.nullable(), available: z.boolean() }).strict();
export type NarrationState = z.infer<typeof NarrationStateSchema>;

/** Briefing sections in the order a briefing shows them: mail first, so what needs action is not buried under the news. */
export const BRIEFING_SECTIONS = ["mail", "domestic", "international", "aiDevelopment"] as const;
export const BriefingSectionKeySchema = z.enum(BRIEFING_SECTIONS);
export type BriefingSectionKey = z.infer<typeof BriefingSectionKeySchema>;
export const BRIEFING_SECTION_LABELS: Record<BriefingSectionKey, string> = { mail: "메일", domestic: "국내", international: "해외", aiDevelopment: "AI/개발" };
/** The 브리핑 tab reads a briefing as two parts, each with its own screen and read state: 뉴스 (the news sections) and 메일. */
export const BRIEFING_PARTS = ["news", "mail"] as const;
export const BriefingPartSchema = z.enum(BRIEFING_PARTS);
export type BriefingPart = z.infer<typeof BriefingPartSchema>;
export const BRIEFING_PART_LABELS: Record<BriefingPart, string> = { news: "뉴스", mail: "메일" };
export const NEWS_SECTIONS = ["domestic", "international", "aiDevelopment"] as const satisfies readonly BriefingSectionKey[];
export const PART_SECTIONS: Record<BriefingPart, readonly BriefingSectionKey[]> = { news: NEWS_SECTIONS, mail: ["mail"] };
export const partOfSection = (key: BriefingSectionKey): BriefingPart => key === "mail" ? "mail" : "news";
/**
 * The id a part is narrated (듣기) under: the news under the briefing's own id, the mail under the same UUID with its
 * version digit set to 8 (RFC 9562 custom). Briefing ids are version 4, so the two never collide and either maps back.
 */
export const briefingPartId = (id: string, part: BriefingPart) => part === "news" ? id : `${id.slice(0, 14)}8${id.slice(15)}`;
export const briefingOfPartId = (id: string): { readonly id: string; readonly part: BriefingPart } =>
  id[14] === "8" ? { id: `${id.slice(0, 14)}4${id.slice(15)}`, part: "mail" } : { id, part: "news" };
/** urgent 즉시 조치, todo 할 일, check 확인, info 참고. */
export const MAIL_IMPORTANCE = ["urgent", "todo", "check", "info"] as const;
export const MAIL_IMPORTANCE_LABELS: Record<(typeof MAIL_IMPORTANCE)[number], string> = { urgent: "즉시 조치", todo: "할 일", check: "확인", info: "참고" };
/** A briefing's slot within its Seoul day: morning (08:00), evening (21:00) or another time as HH:MM. */
export const BriefingSlotSchema = z.string().regex(/^(?:morning|evening|(?:[01]\d|2[0-3]):[0-5]\d)$/, "morning, evening or HH:MM");
export const BRIEFING_LIMITS = { items: 60, bodyBytes: 256 * 1024, rangeDays: 92 } as const;
const briefingUrl = z.url({ protocol: /^https?$/ }).max(2048);
const briefingKey = z.string().trim().min(1).max(200);
export const BriefingArticleSchema = z.object({
  key: briefingKey, title: z.string().trim().min(1).max(300), source: z.string().trim().max(100).default(""),
  summary: z.string().trim().max(2000).default(""),
  /** The verified link (Google News for domestic and international news, the original for AI/개발); `originalUrl` is the publisher's page. */
  url: briefingUrl, originalUrl: briefingUrl.nullable().default(null),
  publishedAt: z.iso.datetime({ offset: true }).nullable().default(null), publishedDate: DateSchema.nullable().default(null),
}).strict();
export type BriefingArticle = z.infer<typeof BriefingArticleSchema>;
export const BriefingMailSchema = z.object({
  key: briefingKey, importance: z.enum(MAIL_IMPORTANCE), from: z.string().trim().min(1).max(200), address: z.string().trim().max(320).default(""),
  subject: z.string().trim().min(1).max(300), summary: z.string().trim().max(2000).default(""), action: z.string().trim().max(1000).default(""),
  url: briefingUrl.nullable().default(null), merged: z.number().int().min(1).max(100).default(1),
}).strict();
export type BriefingMail = z.infer<typeof BriefingMailSchema>;
const shortfall = z.string().trim().min(1).max(500).nullable().default(null);
const NewsSectionSchema = z.object({ items: z.array(BriefingArticleSchema).max(BRIEFING_LIMITS.items), shortfall }).strict();
const MailSectionSchema = z.object({ items: z.array(BriefingMailSchema).max(BRIEFING_LIMITS.items), shortfall }).strict();
const sectionsShape = {
  mail: MailSectionSchema.optional(), domestic: NewsSectionSchema.optional(),
  international: NewsSectionSchema.optional(), aiDevelopment: NewsSectionSchema.optional(),
};
/**
 * One upload of a briefing: the sections it carries replace those sections of the (date, slot) briefing and the rest stay.
 * `scheduledAt` defaults to the slot's time in Seoul; `notify: false` keeps the upload silent (backfills).
 */
export const BriefingInputSchema = z.object({
  date: DateSchema, slot: BriefingSlotSchema, scheduledAt: z.iso.datetime({ offset: true }).optional(),
  sections: z.object(sectionsShape).strict().refine(sections => Object.keys(sections).length > 0, "Include at least one section"),
  notify: z.boolean().default(true),
}).strict();
export type BriefingInput = z.infer<typeof BriefingInputSchema>;
const storedSection = <T extends z.ZodTypeAny>(item: T) => z.object({ items: z.array(item), shortfall: z.string().nullable(), updatedAt: z.iso.datetime() }).strict();
export const BriefingSchema = z.object({
  id: z.string().uuid(), date: DateSchema, slot: BriefingSlotSchema, scheduledAt: z.iso.datetime(),
  sections: z.object({
    mail: storedSection(BriefingMailSchema).optional(), domestic: storedSection(BriefingArticleSchema).optional(),
    international: storedSection(BriefingArticleSchema).optional(), aiDevelopment: storedSection(BriefingArticleSchema).optional(),
  }).strict(),
  createdBy: z.string(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), version: z.number().int().positive(),
  /**
   * When each part was read; null while it waits to be read. A part with nothing to read (no items) counts as read.
   * `readAt` is when both were read (the later time), null while either waits.
   */
  newsReadAt: z.iso.datetime().nullable(), mailReadAt: z.iso.datetime().nullable(), readAt: z.iso.datetime().nullable(),
}).strict();
export type Briefing = z.infer<typeof BriefingSchema>;
/**
 * A briefing in the list: item counts per present section, the first three news headlines, the most important mail's
 * subject, and the numbers of 즉시 조치 (`urgent`) and 할 일 (`todo`) mails.
 */
export const BriefingSummarySchema = BriefingSchema.omit({ sections: true }).extend({
  counts: z.object({ mail: z.number().int().optional(), domestic: z.number().int().optional(), international: z.number().int().optional(), aiDevelopment: z.number().int().optional() }).strict(),
  headlines: z.array(z.string()), mailHeadline: z.string().nullable(), urgent: z.number().int().nonnegative(), todo: z.number().int().nonnegative(),
}).strict();
export type BriefingSummary = z.infer<typeof BriefingSummarySchema>;
export const BriefingHitSchema = z.object({
  briefingId: z.string().uuid(), date: DateSchema, slot: BriefingSlotSchema, scheduledAt: z.iso.datetime(), section: BriefingSectionKeySchema,
  item: z.union([BriefingMailSchema, BriefingArticleSchema]),
}).strict();
export type BriefingHit = z.infer<typeof BriefingHitSchema>;

/** What a device can be told about; each device turns each kind on or off. */
export const PUSH_KINDS = ["briefing", "review", "reply"] as const;
export const PushKindsSchema = z.object({ briefing: z.boolean(), review: z.boolean(), reply: z.boolean() }).strict();
export type PushKinds = z.infer<typeof PushKindsSchema>;
export const PushSubscriptionSchema = z.object({
  endpoint: z.string().max(2048), expirationTime: z.number().nullable().optional(),
  keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }).strict(),
}).strict();
export const PushDeviceSchema = z.object({ kinds: PushKindsSchema, createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() }).strict();
export type PushDevice = z.infer<typeof PushDeviceSchema>;
/** The JSON a notification carries; `url` is the in-app address the tap opens. */
export const PushPayloadSchema = z.object({
  kind: z.enum(["briefing", "review", "reply", "test"]), title: z.string(), body: z.string(), url: z.string(), tag: z.string(),
}).strict();
export type PushPayload = z.infer<typeof PushPayloadSchema>;

export const schemaInfo = {
  kinds: RecordKindSchema.options,
  weekStartsOn: "Monday", collections: { projects: ["project"], tasks: ["task"], records: ["research", "work-report", "note", "social"] },
  agentTitle: { maxWidth: TITLE_MAX_WIDTH, wideCharacterWidth: 2 },
  agentRecord: { tags: AGENT_TAGS, text: AGENT_TEXT, kinds: AGENT_RECORD_RULES },
  fields: {
    project: ["nextAction"],
    task: ["today", "evidenceIds"],
    record: ["summary", "conclusion", "nextActions", "previousId", "starred", "revisitDate"],
  },
  legacyFields: ["goal", "stage", "decisions", "priority", "taskType", "acceptance", "progress", "result", "origin", "significance", "questions", "personalNotes", "savedReason"],
  input: z.toJSONSchema(RecordInputSchema, { unrepresentable: "any" }),
} as const;
