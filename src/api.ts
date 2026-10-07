import ky, { HTTPError } from "ky";
import { z } from "zod";
import {
  DigestHitSchema,
  DigestSchema,
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
import { getLocale, strings } from "./i18n";

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
const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

export async function session(token?: string) {
  const response = token === undefined
    ? http.get("auth/session")
    : http.post("auth/session", { json: { token } });
  return sessionSchema.parse(await response.json());
}

export async function logout(csrfToken: string) {
  await http.delete("auth/session", { headers: { "X-CSRF-Token": csrfToken } });
}

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
export async function loadDigest(id: string): Promise<Digest> {
  return z.object({ digest: DigestSchema }).parse(await http.get(`digests/${id}`).json()).digest;
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

/** The server's error code, when the response carries one. */
export async function errorCode(error: unknown): Promise<string | null> {
  if (!(error instanceof HTTPError)) return null;
  const parsed = errorSchema.safeParse(await error.response.clone().json().catch(() => null));
  return parsed.success ? parsed.data.error.code : null;
}

type ErrorText = {
  readonly conflict: string; readonly forbidden: string; readonly validation: string;
  readonly codes: Readonly<Record<string, string>>;
  readonly signIn: string; readonly failedStatus: (status: number) => string; readonly badShape: (issues: string) => string;
  readonly offline: string; readonly failed: string;
};
const errorCodes = (conflict: string, forbidden: string, validation: string, own: Readonly<Record<string, string>>) => ({
  version_conflict: conflict, conflict, idempotency_conflict: conflict,
  forbidden, csrf: forbidden, origin: forbidden, invalid_host: forbidden,
  validation, invalid_json: validation, invalid_query: validation, invalid_cursor: validation, invalid_relationship: validation,
  invalid_target: validation, invalid_status: validation, invalid_subscription: validation, record_incomplete: validation,
  unsupported_media_type: validation,
  ...own,
});
const errorText = strings<ErrorText>({
  en: (() => {
    const conflict = "This changed somewhere else first. Refresh and try again.";
    const forbidden = "You don't have permission. Sign in again.";
    const validation = "Check what you entered.";
    return {
      conflict, forbidden, validation,
      codes: errorCodes(conflict, forbidden, validation, {
        rate_limited: "Too many requests. Try again in a moment.",
        not_found: "That item couldn't be found.",
        invalid_input: "Some values aren't in the right format. Check what you entered.",
        title_too_long: "The title is too long. Shorten it and save again.",
        too_large: "The content is too large. Shorten it and try again.",
        narration_unsupported: "This item can't be turned into audio.",
        narration_unavailable: "Audio narration isn't set up.",
        narration_attempts_exhausted: "Making the audio failed several times. Change the content or try Make again.",
        narration_daily_limit: "Today's audio limit has been reached. Try again tomorrow.",
        narration_queue_full: "Too much audio is waiting. Try again in a moment.",
        narration_busy: "Audio is being made. Try again when it's done.",
        demo_read_only: "This is a read-only demo, so changes aren't saved.",
      }),
      signIn: "Sign-in is required or the session expired. Sign in again with the owner key.",
      failedStatus: status => `The request couldn't be completed (${status}).`,
      badShape: issues => `The input or the server's data isn't in the expected format: ${issues}`,
      offline: "Couldn't reach the server. Check your network connection and try again.",
      failed: "The request couldn't be completed. Try again.",
    };
  })(),
  ko: (() => {
    const conflict = "다른 곳에서 먼저 바뀌었어요. 새로고침한 뒤 다시 시도해 주세요.";
    const forbidden = "권한이 없어요. 다시 로그인해 주세요.";
    const validation = "입력값을 확인해 주세요.";
    return {
      conflict, forbidden, validation,
      codes: errorCodes(conflict, forbidden, validation, {
        rate_limited: "요청이 너무 많아요. 잠시 뒤 다시 시도해 주세요.",
        not_found: "항목을 찾을 수 없어요.",
        invalid_input: "형식에 맞지 않는 값이 있어요. 입력한 내용을 확인해 주세요.",
        title_too_long: "제목이 너무 길어요. 줄여서 다시 저장해 주세요.",
        too_large: "내용이 너무 커요. 줄여서 다시 시도해 주세요.",
        narration_unsupported: "이 항목은 음성으로 만들 수 없어요.",
        narration_unavailable: "음성 생성이 설정되어 있지 않아요.",
        narration_attempts_exhausted: "음성 생성이 여러 번 실패했어요. 내용을 바꾸거나 다시 만들기로 시도해 주세요.",
        narration_daily_limit: "오늘 만들 수 있는 음성 한도에 도달했어요. 내일 다시 시도해 주세요.",
        narration_queue_full: "대기 중인 음성이 너무 많아요. 잠시 뒤 다시 시도해 주세요.",
        narration_busy: "음성을 만드는 중이에요. 끝난 뒤 다시 시도해 주세요.",
        demo_read_only: "읽기 전용 데모라서 바꾼 내용은 저장되지 않아요.",
      }),
      signIn: "로그인이 필요하거나 세션이 만료됐어요. 소유자 토큰으로 다시 연결해 주세요.",
      failedStatus: status => `요청을 처리하지 못했어요 (${status}).`,
      badShape: issues => `입력값이나 서버 데이터의 형식이 맞지 않아요: ${issues}`,
      offline: "서버에 연결하지 못했어요. 네트워크 연결을 확인하고 다시 시도해 주세요.",
      failed: "요청을 처리하지 못했어요. 다시 시도해 주세요.",
    };
  })(),
});
/** Hangul syllables: a server message already written in Korean is shown as it is to a Korean reader. */
const hangul = /[\uAC00-\uD7A3]/;

/** Text in the current language for every server error code the owner UI can meet. */
export async function errorMessage(error: unknown): Promise<string> {
  const text = errorText();
  if (error instanceof HTTPError) {
    const status = error.response.status;
    if (status === 401) return text.signIn;
    const parsed = errorSchema.safeParse(await error.response.clone().json().catch(() => null));
    if (parsed.success) {
      const mapped = text.codes[parsed.data.error.code];
      if (mapped !== undefined) return mapped;
      if (getLocale() === "ko" && hangul.test(parsed.data.error.message)) return parsed.data.error.message;
    }
    if (status === 409) return text.conflict;
    if (status === 429) return text.codes.rate_limited ?? "";
    return text.failedStatus(status);
  }
  if (error instanceof z.ZodError) return text.badShape(error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join(", "));
  if (error instanceof Error) return text.offline;
  return text.failed;
}

export { recordInputSchema };
