import ky from "ky";
import { z } from "zod";
import {
  DigestHitSchema,
  DigestReactionsSchema,
  DigestSchema,
  type ArticleReaction,
  type DigestReactions,
  DigestSummarySchema,
  PushDeviceSchema,
  type Digest,
  type DigestHit,
  type DigestPart,
  type DigestSummary,
  type PushDevice,
  type PushKinds,
  type PushLocale,
  CommentSchema as commentSchema,
  DashboardRecordSchema as dashboardRecordSchema,
  DocumentStateSchema,
  type RecordDocument,
  NarrationStateSchema as narrationStateSchema,
  NarrationVoiceSettingsSchema,
  NarrationAutoSchema,
  type NarrationVoiceSettings,
  type NarrationVoices,
  type NarrationAuto,
  RecordInputSchema as recordInputSchema,
  TrashItemSchema as trashItemSchema,
  type Comment,
  type DashboardRecord,
  type NarrationState,
  type NarrationStyle,
  type RecordInput,
  type RecordPatch,
  type TrashItem,
} from "../shared/contracts";
export { retryAfterMs } from "./rate-limit";

const http = ky.create({ prefixUrl: "/api/v1", credentials: "same-origin", retry: 0 });
const sessionSchema = z.object({ csrfToken: z.string(), expiresAt: z.string() });
const pageSchema = z.object({
  items: z.array(dashboardRecordSchema),
  nextCursor: z.string().nullable(),
});
const recordResponseSchema = z.object({ record: dashboardRecordSchema });
const trashSchema = z.object({ items: z.array(trashItemSchema) });
const shareSchema = z.object({ code: z.string(), url: z.string(), createdAt: z.string() });
const shareCreatedSchema = z.object({ share: shareSchema });
/** A record's one active share: `url` is `${origin}/s/${code}`. */
export type Share = z.infer<typeof shareSchema>;
export async function session(token?: string) {
  const response = token === undefined
    ? http.get("auth/session")
    : http.post("auth/session", { json: { token } });
  return sessionSchema.parse(await response.json());
}

export { logout } from "./account-session";

const agentSchema = z.object({ name: z.string(), createdAt: z.string().nullable(), lastUsedAt: z.string().nullable(), revokedAt: z.string().nullable() });
/** A registered agent: `lastUsedAt` is null until it first connects, `revokedAt` is set once its key is removed. */
export type AgentInfo = z.infer<typeof agentSchema>;
/** Every registered agent, revoked ones included (their records still name them). Owner session only. */
export async function listAgents(): Promise<AgentInfo[]> {
  return z.object({ items: z.array(agentSchema) }).parse(await http.get("agents").json()).items;
}
/** Names of every registered agent, revoked ones included. */
export async function loadAgents(): Promise<string[]> {
  return (await listAgents()).map(agent => agent.name);
}

export async function loadRecords(): Promise<DashboardRecord[]> {
  const records: DashboardRecord[] = [];
  let cursor: string | null = null;
  do {
    const searchParams: Record<string, string> = { archived: "all", limit: "50" };
    if (cursor !== null) searchParams.cursor = cursor;
    const page = pageSchema.parse(await http.get("records", { searchParams }).json());
    records.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return records;
}

export async function createRecord(input: RecordInput, csrfToken: string, requestId: string) {
  const record = recordInputSchema.parse(input);
  return recordResponseSchema.parse(await http.post("records", {
    json: { requestId, record },
    headers: { "X-CSRF-Token": csrfToken },
  }).json()).record;
}

export async function patchRecord(record: DashboardRecord, changes: RecordPatch["changes"], csrfToken: string) {
  return recordResponseSchema.parse(await http.patch(`records/${record.id}`, {
    json: { expectedVersion: record.version, changes },
    headers: { "X-CSRF-Token": csrfToken },
  }).json()).record;
}

/** Version-checked DELETE (204) into the 30-day trash. A stale version fails with 409, reported by errorMessage. */
export async function deleteRecord(record: DashboardRecord, csrfToken: string): Promise<void> {
  await http.delete(`records/${record.id}`, {
    json: { expectedVersion: record.version },
    headers: { "X-CSRF-Token": csrfToken },
  });
}

/** The owner's trash, most recently deleted first. */
export async function loadTrash(): Promise<TrashItem[]> {
  return trashSchema.parse(await http.get("trash").json()).items;
}

/** POST without a body: the record leaves the trash and comes back as it was deleted (404 when it is not there). */
export async function restoreRecord(id: string, csrfToken: string): Promise<DashboardRecord> {
  return recordResponseSchema.parse(await http.post(`trash/${id}/restore`, { headers: { "X-CSRF-Token": csrfToken } }).json()).record;
}

/** Permanent DELETE (204) of one trashed record. */
export async function purgeRecord(id: string, csrfToken: string): Promise<void> {
  await http.delete(`trash/${id}`, { headers: { "X-CSRF-Token": csrfToken } });
}

/** Permanent DELETE (204) of everything in the trash. */
export async function emptyTrash(csrfToken: string): Promise<void> {
  await http.delete("trash", { headers: { "X-CSRF-Token": csrfToken } });
}

/** Every timeline entry on items that are not in the trash, oldest first. */
export async function loadComments(): Promise<Comment[]> {
  return z.object({ items: z.array(commentSchema) }).parse(await http.get("comments").json()).items;
}

/** The owner's comment on a task or project; `requestId` makes a resend return the same entry. */
export async function createComment(recordId: string, body: string, requestId: string, csrfToken: string): Promise<Comment> {
  return z.object({ comment: commentSchema }).parse(await http.post("comments", {
    json: { requestId, recordId, body },
    headers: { "X-CSRF-Token": csrfToken },
  }).json()).comment;
}

/** POST without a body: 201 creates the share, 200 returns the existing one with the same code. */
export async function createShare(recordId: string, csrfToken: string): Promise<Share> {
  return shareCreatedSchema.parse(await http.post(`records/${recordId}/share`, { headers: { "X-CSRF-Token": csrfToken } }).json()).share;
}

/** 204 whether or not a share existed. */
export async function deleteShare(recordId: string, csrfToken: string): Promise<void> {
  await http.delete(`records/${recordId}/share`, { headers: { "X-CSRF-Token": csrfToken } });
}

/** The record's attached HTML document (full document), or null when it has none. */
export async function loadDocument(recordId: string): Promise<RecordDocument | null> {
  return DocumentStateSchema.parse(await http.get(`records/${recordId}/document`).json()).document;
}

/** What can be narrated: a record, or a digest part (owner only). */
export type NarrationCollection = "records" | "digests";

/** A record's narration state and whether the server has a TTS key. */
export async function loadNarration(recordId: string, collection: NarrationCollection = "records"): Promise<NarrationState> {
  return narrationStateSchema.parse(await http.get(`${collection}/${recordId}/narration`).json());
}

/**
 * Starts a narration (202) or returns the current one (200); `force` makes a new one even for unchanged content.
 * `style` (read aloud or podcast, records only) defaults on the server to the style last chosen.
 */
export async function requestNarration(recordId: string, force: boolean, csrfToken: string, collection: NarrationCollection = "records",
  style?: NarrationStyle): Promise<NarrationState> {
  return narrationStateSchema.parse(await http.post(`${collection}/${recordId}/narration`, {
    json: { ...(force ? { force: true } : {}), ...(style ? { style } : {}) },
    headers: { "X-CSRF-Token": csrfToken },
  }).json());
}

/** Settings › Narration voices (owner): the voices and speaking styles in use, the defaults and the voices to choose from. */
export async function loadVoiceSettings(): Promise<NarrationVoiceSettings> {
  return NarrationVoiceSettingsSchema.parse(await http.get("narration/voices").json());
}

/** Saves the voices and styles the next narrations use; audio already made keeps its voice. */
export async function saveVoiceSettings(voices: NarrationVoices, csrfToken: string): Promise<NarrationVoiceSettings> {
  return NarrationVoiceSettingsSchema.parse(await http.put("narration/voices", { json: voices, headers: { "X-CSRF-Token": csrfToken } }).json());
}

/** A few seconds of `voice` reading a sample sentence; made once on the server (a small paid call), then served from its file. */
/** Settings › Automatic audio (owner): which audio is made without asking, and what a record's audio reads. */
export async function loadNarrationAuto(): Promise<NarrationAuto> {
  return NarrationAutoSchema.parse(await http.get("narration/auto").json());
}

/** Saves the automatic audio choice; it applies to audio made from now on. */
export async function saveNarrationAuto(auto: NarrationAuto, csrfToken: string): Promise<NarrationAuto> {
  return NarrationAutoSchema.parse(await http.put("narration/auto", { json: auto, headers: { "X-CSRF-Token": csrfToken } }).json());
}

export const voicePreviewUrl = (voice: string) => `/api/v1/narration/voices/${encodeURIComponent(voice)}/preview`;

/** Stops a narration that is waiting or being made, so no further paid call starts; the state after it (the earlier audio, if any). */
export async function cancelNarration(recordId: string, csrfToken: string, collection: NarrationCollection = "records"): Promise<NarrationState> {
  return narrationStateSchema.parse(await http.post(`${collection}/${recordId}/narration/cancel`, {
    json: {}, headers: { "X-CSRF-Token": csrfToken },
  }).json());
}

/** Deletes the audio file and script (204); 409 while one is being made. */
export async function deleteNarration(recordId: string, csrfToken: string, collection: NarrationCollection = "records"): Promise<void> {
  await http.delete(`${collection}/${recordId}/narration`, { headers: { "X-CSRF-Token": csrfToken } });
}

const partTotalsSchema = z.object({ unread: z.number(), earliestDate: z.string().nullable() });
const digestPageSchema = z.object({
  items: z.array(DigestSummarySchema), from: z.string(), to: z.string(), unread: z.number(),
  earliestDate: z.string().nullable(), latestDate: z.string().nullable(),
  parts: z.object({ articles: partTotalsSchema, messages: partTotalsSchema }),
});
/**
 * Digest summaries from `from` to `to` (the server defaults to the last 14 days), newest first, with the unread parts in
 * total and per part (articles, messages).
 */
export type DigestPage = z.infer<typeof digestPageSchema>;
export async function loadDigests(range: { readonly from?: string; readonly to?: string } = {}): Promise<DigestPage> {
  const searchParams: Record<string, string> = {};
  if (range.from) searchParams.from = range.from;
  if (range.to) searchParams.to = range.to;
  return digestPageSchema.parse(await http.get("digests", { searchParams }).json());
}
/** One digest with the owner's reactions to its articles (`section:key` -> like | dislike | seen). */
export async function loadDigest(id: string): Promise<{ digest: Digest; reactions: DigestReactions }> {
  return z.object({ digest: DigestSchema, reactions: DigestReactionsSchema.default({}) }).parse(await http.get(`digests/${id}`).json());
}
/** Sets (or with null takes back) the owner's reaction to one article; answers the digest's reactions. */
export async function reactToArticle(id: string, section: string, key: string, reaction: ArticleReaction | null, csrfToken: string): Promise<DigestReactions> {
  return z.object({ reactions: DigestReactionsSchema }).parse(await http.put(`digests/${id}/reactions`, {
    json: { section, key, reaction }, headers: { "X-CSRF-Token": csrfToken },
  }).json()).reactions;
}
/** Articles and messages matching `q`; without `part` both. */
export async function searchDigests(q: string, part?: DigestPart): Promise<DigestHit[]> {
  return z.object({ items: z.array(DigestHitSchema) }).parse(await http.get("digests/search", { searchParams: { q, ...(part ? { part } : {}), limit: "50" } }).json()).items;
}
/** Marks one part read or unread; without `part` both. */
export async function markDigest(id: string, part: DigestPart | undefined, read: boolean, csrfToken: string): Promise<DigestSummary> {
  return z.object({ digest: DigestSummarySchema }).parse(await http.post(`digests/${id}/read`, {
    json: part ? { read, part } : { read }, headers: { "X-CSRF-Token": csrfToken },
  }).json()).digest;
}

const pushStateSchema = z.object({ publicKey: z.string(), device: PushDeviceSchema.nullable(), devices: z.number() });
/** The server's VAPID public key and, for `endpoint`, what that device is subscribed to. */
export async function loadPush(endpoint?: string) {
  return pushStateSchema.parse(await http.get("push", { searchParams: endpoint ? { endpoint } : {} }).json());
}
/** Without `kinds` an existing device keeps its choice and a new one gets every kind. */
export async function savePushSubscription(subscription: PushSubscriptionJSON & { readonly locale?: PushLocale }, kinds: PushKinds | undefined, csrfToken: string): Promise<PushDevice> {
  return z.object({ device: PushDeviceSchema }).parse(await http.put("push/subscription", {
    json: { subscription, ...(kinds ? { kinds } : {}) }, headers: { "X-CSRF-Token": csrfToken },
  }).json()).device;
}
export async function deletePushSubscription(endpoint: string, csrfToken: string): Promise<void> {
  await http.delete("push/subscription", { json: { endpoint }, headers: { "X-CSRF-Token": csrfToken } });
}
export async function sendTestPush(endpoint: string, csrfToken: string) {
  return z.object({ delivered: z.boolean(), status: z.number().nullable() }).parse(await http.post("push/test", {
    json: { endpoint }, headers: { "X-CSRF-Token": csrfToken },
  }).json());
}

export { errorCode, errorMessage, isUnauthorized } from "./api-errors";

export { recordInputSchema };
