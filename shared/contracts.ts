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
/** The body may hold a whole document's text, which is what is worth listening to, so it may run far past a note's length; record requests may be this large. */
export const RECORD_LIMITS = { bodyChars: 120000, requestBytes: 512 * 1024 } as const;
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
  body: z.string().max(RECORD_LIMITS.bodyChars).default(""),
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
 * The one record format every registered agent must follow, whatever its own style. The server checks it on
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
  "research and work-report: body = the full content, fields.summary = 1-3 lines, fields.conclusion = one line, fields.nextActions = one action per line starting with \"- \" (\"- none\" when there is none). " +
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
    issues.push(`fields.nextActions: one action per line, each starting with "${AGENT_TEXT.listPrefix}" ("- none" when there is none)`);
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

/** Record kinds that can be read aloud (Listen): the material kinds. */
export const NARRATABLE_KINDS = ["research", "work-report", "note", "social"] as const;
/**
 * Cost guards for narration: script length, TTS chunk length, model input, queued jobs, generations started per Seoul day,
 * and failed generations per content version before only the owner may try again.
 */
export const NARRATION_LIMITS = { scriptChars: 6000, partScriptChars: 18000, digestScriptChars: 10000, chunkChars: 1500, sourceChars: 120000, partChars: 5000, queue: 20, dailyRuns: 20, attempts: 3, retries: 4 } as const;
/** queued -> scripting (listening script) -> speaking (TTS chunks) -> ready | failed. */
export const NarrationStatusSchema = z.enum(["queued", "scripting", "speaking", "ready", "failed"]);
export type NarrationStatus = z.infer<typeof NarrationStatusSchema>;
/** read: one voice reads a listening script. podcast: two hosts talk the record through; records only, digests are always read aloud. */
export const NarrationStyleSchema = z.enum(["read", "podcast"]);
export type NarrationStyle = z.infer<typeof NarrationStyleSchema>;
export const NarrationAudioSchema = z.object({
  url: z.string(), mime: z.string(), bytes: z.number().int().nonnegative(), durationMs: z.number().int().nonnegative(),
  model: z.string(), voice: z.string(), style: NarrationStyleSchema, createdAt: z.iso.datetime(),
}).strict();
/**
 * A record's narration: the job state and the last finished audio, which stays playable while a new one is made.
 * `stale`: the audio was made from content (title, summary, conclusion, body, next actions) that has since changed.
 * `style`: the style last chosen for this record, the default for the next request.
 * `waitUntil`: while the running job waits out a busy or rate-limited provider, when its next try starts; null otherwise.
 * `progress`: while scripting, the script characters received so far and the expected length; while speaking, chunks done and total.
 * `stepAt`: when the current step began (waiting its turn, writing the script, the chunk being spoken, saving); null when no job runs.
 */
export const NarrationSchema = z.object({
  recordId: z.string().uuid(), status: NarrationStatusSchema, style: NarrationStyleSchema, stale: z.boolean(),
  progress: z.object({ done: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).strict().nullable(),
  waitUntil: z.iso.datetime().nullable(),
  stepAt: z.iso.datetime().nullable(),
  attempts: z.number().int().nonnegative(), error: z.string().nullable(),
  requestedBy: z.string(), requestedAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  audio: NarrationAudioSchema.nullable(), script: z.string().nullable(),
}).strict();
export type Narration = z.infer<typeof NarrationSchema>;
/** GET/POST narration response; `available` is false when no TTS key is configured. */
export const NarrationStateSchema = z.object({ narration: NarrationSchema.nullable(), available: z.boolean() }).strict();
export type NarrationState = z.infer<typeof NarrationStateSchema>;
/** At most this many characters of speaking style per narration style. */
export const NARRATION_STYLE_TEXT_MAX = 300;
const voiceId = z.string().trim().min(1).max(64);
const styleText = z.string().trim().min(1).max(NARRATION_STYLE_TEXT_MAX);
/**
 * The voices and speaking style the next narrations use: `readVoice` reads aloud (and digests), `hostA` and `hostB` are the
 * two podcast hosts and must differ. Audio already made keeps the voice it was made with.
 */
export const NarrationVoicesSchema = z.object({
  readVoice: voiceId, hostA: voiceId, hostB: voiceId, readStyle: styleText, podcastStyle: styleText,
}).strict().refine(voices => voices.hostA !== voices.hostB, { message: "The two podcast hosts need different voices", path: ["hostB"] });
export type NarrationVoices = z.infer<typeof NarrationVoicesSchema>;
export const VoiceSchema = z.object({
  id: z.string(), name: z.string(), gender: z.enum(["male", "female", "neutral"]), pitch: z.enum(["low", "medium", "high"]).nullable(),
}).strict();
/** GET and PUT /api/v1/narration/voices: what is in use, what the server starts with, and the voices to choose from. */
export const NarrationVoiceSettingsSchema = z.object({
  settings: NarrationVoicesSchema, defaults: NarrationVoicesSchema, voices: z.array(VoiceSchema),
}).strict();
export type NarrationVoiceSettings = z.infer<typeof NarrationVoiceSettingsSchema>;

/**
 * A record's attached HTML document (full document), for research, work-report, note and social records. The dashboard shows
 * it in a sandboxed frame where no script runs; the body keeps the same content as text for search and narration.
 */
export const DOCUMENT_LIMITS = { htmlBytes: 1024 * 1024, requestBytes: 2 * 1024 * 1024 } as const;
export const DocumentInputSchema = z.object({
  html: z.string().min(1).refine(html => new TextEncoder().encode(html).byteLength <= DOCUMENT_LIMITS.htmlBytes, "html exceeds 1 MiB"),
}).strict();
export const RecordDocumentSchema = z.object({ html: z.string(), bytes: z.number().int().nonnegative(), updatedBy: z.string(), updatedAt: z.iso.datetime() }).strict();
export type RecordDocument = z.infer<typeof RecordDocumentSchema>;
/** GET/PUT document response; `document` is null when none is attached. */
export const DocumentStateSchema = z.object({ document: RecordDocumentSchema.nullable() }).strict();
export type DocumentState = z.infer<typeof DocumentStateSchema>;

/** The two kinds of digest section; each kind is also a part of a digest that is read and narrated on its own. */
export const DIGEST_KINDS = ["articles", "messages"] as const;
export const DigestKindSchema = z.enum(DIGEST_KINDS);
export type DigestKind = z.infer<typeof DigestKindSchema>;
/** A part of a digest: the sections of one kind. */
export const DIGEST_PARTS = DIGEST_KINDS;
export const DigestPartSchema = DigestKindSchema;
export type DigestPart = DigestKind;
/** An agent-chosen section key: lowercase letters, digits and dashes, starting with a letter. */
export const DigestSectionKeySchema = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, "lowercase letters, digits and dashes, starting with a letter");
/** What of a digest can be narrated: one part, or `all` (the articles, then the messages, in one audio). */
export type DigestNarration = DigestPart | "all";
/**
 * The id a part is narrated under: the articles under the digest's own id, the messages under the same UUID with its
 * version digit set to 8 (RFC 9562 custom), the whole digest with it set to 7. Digest and record ids are version 4,
 * so none of them collide and each maps back.
 */
export const digestPartId = (id: string, part: DigestNarration) => part === "articles" ? id : `${id.slice(0, 14)}${part === "messages" ? "8" : "7"}${id.slice(15)}`;
export const digestOfPartId = (id: string): { readonly id: string; readonly part: DigestNarration } =>
  id[14] === "8" ? { id: `${id.slice(0, 14)}4${id.slice(15)}`, part: "messages" }
    : id[14] === "7" ? { id: `${id.slice(0, 14)}4${id.slice(15)}`, part: "all" } : { id, part: "articles" };
/** Message importance, most pressing first: urgent (act now), todo, check, info. */
export const MESSAGE_IMPORTANCE = ["urgent", "todo", "check", "info"] as const;
export type MessageImportance = (typeof MESSAGE_IMPORTANCE)[number];
/** A digest's slot within its day: morning (08:00), evening (21:00) or another time as HH:MM. */
export const DigestSlotSchema = z.string().regex(/^(?:morning|evening|(?:[01]\d|2[0-3]):[0-5]\d)$/, "morning, evening or HH:MM");
export const DIGEST_LIMITS = { items: 60, sections: 12, bodyBytes: 256 * 1024, rangeDays: 92 } as const;
const digestUrl = z.url({ protocol: /^https?$/ }).max(2048);
const itemKey = z.string().trim().min(1).max(200);
export const DigestArticleSchema = z.object({
  key: itemKey, title: z.string().trim().min(1).max(300), source: z.string().trim().max(100).default(""),
  summary: z.string().trim().max(2000).default(""),
  /** The verified link to open; `originalUrl` is the publisher's page when `url` is an aggregator's. */
  url: digestUrl, originalUrl: digestUrl.nullable().default(null),
  publishedAt: z.iso.datetime({ offset: true }).nullable().default(null), publishedDate: DateSchema.nullable().default(null),
}).strict();
export type DigestArticle = z.infer<typeof DigestArticleSchema>;
export const DigestMessageSchema = z.object({
  key: itemKey, importance: z.enum(MESSAGE_IMPORTANCE), from: z.string().trim().min(1).max(200), address: z.string().trim().max(320).default(""),
  subject: z.string().trim().min(1).max(300), summary: z.string().trim().max(2000).default(""), action: z.string().trim().max(1000).default(""),
  url: digestUrl.nullable().default(null), merged: z.number().int().min(1).max(100).default(1),
}).strict();
export type DigestMessage = z.infer<typeof DigestMessageSchema>;
const sectionHead = { key: DigestSectionKeySchema, title: z.string().trim().min(1).max(60), shortfall: z.string().trim().min(1).max(500).nullable().default(null) };
export const DigestSectionInputSchema = z.discriminatedUnion("kind", [
  z.object({ ...sectionHead, kind: z.literal("articles"), items: z.array(DigestArticleSchema).max(DIGEST_LIMITS.items) }).strict(),
  z.object({ ...sectionHead, kind: z.literal("messages"), items: z.array(DigestMessageSchema).max(DIGEST_LIMITS.items) }).strict(),
]);
export type DigestSectionInput = z.infer<typeof DigestSectionInputSchema>;
/**
 * One upload of a digest: each section replaces the stored section with the same key in place, the others stay and new keys
 * are appended. `scheduledAt` defaults to the slot's time in the dashboard's time zone; `notify: false` keeps it silent (backfills).
 */
export const DigestInputSchema = z.object({
  date: DateSchema, slot: DigestSlotSchema, scheduledAt: z.iso.datetime({ offset: true }).optional(),
  sections: z.array(DigestSectionInputSchema).min(1).max(DIGEST_LIMITS.sections).superRefine((sections, ctx) => {
    const seen = new Set<string>();
    sections.forEach((section, index) => {
      if (seen.has(section.key)) ctx.addIssue({ code: "custom", path: [index, "key"], message: "Section keys must be unique" });
      seen.add(section.key);
    });
  }),
  notify: z.boolean().default(true),
}).strict();
export type DigestInput = z.infer<typeof DigestInputSchema>;
const storedHead = { key: DigestSectionKeySchema, title: z.string(), shortfall: z.string().nullable(), updatedAt: z.iso.datetime() };
export const DigestSectionSchema = z.discriminatedUnion("kind", [
  z.object({ ...storedHead, kind: z.literal("articles"), items: z.array(DigestArticleSchema) }).strict(),
  z.object({ ...storedHead, kind: z.literal("messages"), items: z.array(DigestMessageSchema) }).strict(),
]);
export type DigestSection = z.infer<typeof DigestSectionSchema>;
export const DigestSchema = z.object({
  id: z.string().uuid(), date: DateSchema, slot: DigestSlotSchema, scheduledAt: z.iso.datetime(),
  /** In upload order: a replaced section keeps its place, a new key goes last. */
  sections: z.array(DigestSectionSchema),
  createdBy: z.string(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), version: z.number().int().positive(),
  /**
   * When each part was read; null while it waits to be read. A part with nothing to read (no items) counts as read.
   * `readAt` is when both were read (the later time), null while either waits.
   */
  articlesReadAt: z.iso.datetime().nullable(), messagesReadAt: z.iso.datetime().nullable(), readAt: z.iso.datetime().nullable(),
}).strict();
export type Digest = z.infer<typeof DigestSchema>;
/** A section as the list sees it: its key, title, kind and number of items. */
export const DigestOutlineSchema = z.object({ key: DigestSectionKeySchema, title: z.string(), kind: DigestKindSchema, items: z.number().int().nonnegative() }).strict();
export type DigestOutline = z.infer<typeof DigestOutlineSchema>;
/**
 * A digest in the list: item counts per section key, the outline of its sections in order, the first three headlines taken
 * round-robin across the article sections, the most important message's subject, and the numbers of urgent and todo messages.
 */
export const DigestSummarySchema = DigestSchema.omit({ sections: true }).extend({
  counts: z.record(z.string(), z.number().int().nonnegative()), outline: z.array(DigestOutlineSchema),
  headlines: z.array(z.string()), messageHeadline: z.string().nullable(), urgent: z.number().int().nonnegative(), todo: z.number().int().nonnegative(),
}).strict();
export type DigestSummary = z.infer<typeof DigestSummarySchema>;
export const DigestHitSchema = z.object({
  digestId: z.string().uuid(), date: DateSchema, slot: DigestSlotSchema, scheduledAt: z.iso.datetime(),
  section: DigestSectionKeySchema, sectionTitle: z.string(), kind: DigestKindSchema,
  item: z.union([DigestMessageSchema, DigestArticleSchema]),
}).strict();
export type DigestHit = z.infer<typeof DigestHitSchema>;

/** What a device can be told about; each device turns each kind on or off. */
export const PUSH_KINDS = ["digest", "review", "reply"] as const;
export const PushKindsSchema = z.object({ digest: z.boolean(), review: z.boolean(), reply: z.boolean() }).strict();
export type PushKinds = z.infer<typeof PushKindsSchema>;
/** The language a device wants its notifications in; a device that never said uses the server's default language. */
export const PUSH_LOCALES = ["en", "ko"] as const;
export const PushLocaleSchema = z.enum(PUSH_LOCALES);
export type PushLocale = z.infer<typeof PushLocaleSchema>;
export const PushSubscriptionSchema = z.object({
  endpoint: z.string().max(2048), expirationTime: z.number().nullable().optional(), locale: PushLocaleSchema.optional(),
  keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }).strict(),
}).strict();
export const PushDeviceSchema = z.object({ kinds: PushKindsSchema, locale: PushLocaleSchema, createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() }).strict();
export type PushDevice = z.infer<typeof PushDeviceSchema>;
/** The JSON a notification carries; `url` is the in-app address the tap opens. */
export const PushPayloadSchema = z.object({
  kind: z.enum(["digest", "review", "reply", "test"]), title: z.string(), body: z.string(), url: z.string(), tag: z.string(),
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
