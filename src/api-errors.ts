import { HTTPError, TimeoutError } from "ky";
import { z } from "zod";
import { getLocale, strings } from "./i18n";
import { rememberRateLimit, retryAfterMs } from "./rate-limit";
import { accountErrorMessage, accountErrorText } from "./account-errors";
import { config } from "./config";
const issueSchema = z.object({ path: z.array(z.union([z.string().regex(/^(?:[a-zA-Z][\w-]{0,63}|\d+)$/), z.number().int().nonnegative()])),
  message: z.string().max(500) });
const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(),
  details: z.array(z.unknown()).optional() }) });

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
  readonly offline: string; readonly failed: string; readonly badData: string; readonly fieldNames: Readonly<Record<string, string>>;
  readonly retry: (seconds: number) => string;
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
    const forbidden = "This operation isn't allowed for your account.";
    const validation = "Check what you entered.";
    return {
      conflict, forbidden, validation,
      codes: errorCodes(conflict, forbidden, validation, {
        csrf: "The page's security check failed. Refresh the page and try again.",
        origin: "This dashboard address isn't allowed by the server. Contact the server operator (origin).",
        invalid_host: "This dashboard address isn't allowed by the server. Contact the server operator (invalid_host).",
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
      badShape: fields => `Some values aren't valid: ${fields}. Fix them and save again.`,
      badData: "Couldn't read the data from the server. Refresh and try again.",
      fieldNames: { title: "Title", body: "Content", status: "Status", projectId: "Project", taskId: "Task", dueDate: "Due date", tags: "Tags", links: "Links", kind: "Type", summary: "Summary", conclusion: "Conclusion", nextActions: "Next steps", nextAction: "Next step", revisitDate: "Revisit date" },
      offline: "Couldn't reach the server. Check your network connection and try again.",
      failed: "The request couldn't be completed. Try again.",
      retry: seconds => `Too many requests. Try again in ${seconds} seconds.`,
    };
  })(),
  ko: (() => {
    const conflict = "다른 곳에서 먼저 바뀌었어요. 새로고침한 뒤 다시 시도해 주세요.";
    const forbidden = "이 계정으로는 이 작업을 할 수 없어요.";
    const validation = "입력값을 확인해 주세요.";
    return {
      conflict, forbidden, validation,
      codes: errorCodes(conflict, forbidden, validation, {
        csrf: "페이지 보안 확인에 실패했어요. 페이지를 새로고침한 뒤 다시 시도해 주세요.",
        origin: "서버에서 허용하지 않은 대시보드 주소예요. 서버 운영자에게 문의해 주세요 (origin).",
        invalid_host: "서버에서 허용하지 않은 대시보드 주소예요. 서버 운영자에게 문의해 주세요 (invalid_host).",
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
      badShape: fields => `형식이 맞지 않는 값이 있어요: ${fields}. 고쳐서 다시 저장해 주세요.`,
      badData: "서버에서 받은 데이터를 읽지 못했어요. 새로고침한 뒤 다시 시도해 주세요.",
      fieldNames: { title: "제목", body: "내용", status: "상태", projectId: "프로젝트", taskId: "할 일", dueDate: "마감일", tags: "태그", links: "링크", kind: "종류", summary: "요약", conclusion: "결론", nextActions: "다음 할 일", nextAction: "다음 할 일", revisitDate: "다시 볼 날짜" },
      offline: "서버에 연결하지 못했어요. 네트워크 연결을 확인하고 다시 시도해 주세요.",
      failed: "요청을 처리하지 못했어요. 다시 시도해 주세요.",
      retry: seconds => `요청이 너무 많아요. ${seconds}초 뒤 다시 시도해 주세요.`,
    };
  })(),
});
/** Hangul syllables: a server message already written in Korean is shown as it is to a Korean reader. */
const hangul = /[\uAC00-\uD7A3]/;

/** Text in the current language for every server error code the owner UI can meet. */
export async function errorMessage(error: unknown): Promise<string> {
  rememberRateLimit(error);
  const text = errorText();
  if (error instanceof HTTPError) {
    const status = error.response.status;
    if (status === 401) return config.authMode === "google" ? accountErrorText().reauth_required : text.signIn;
    const retry = retryAfterMs(error.response.headers.get("Retry-After"));
    if (status === 429 && retry > 0) return text.retry(Math.ceil(retry / 1000));
    const parsed = errorSchema.safeParse(await error.response.clone().json().catch(() => null));
    if (parsed.success) {
      const mapped = accountErrorMessage(parsed.data.error.code) ?? text.codes[parsed.data.error.code];
      if (mapped !== undefined) {
        const details = status === 400 ? (parsed.data.error.details ?? []).flatMap(value => {
          const issue = issueSchema.safeParse(value);
          return issue.success ? [`${issue.data.path.join(".")}: ${issue.data.message.replace(/[\u0000-\u001f\u007f]/g, " ")}`] : [];
        }).slice(0, 20) : [];
        return details.length ? `${mapped}\n${details.join("\n")}` : mapped;
      }
      if (getLocale() === "ko" && hangul.test(parsed.data.error.message)) return parsed.data.error.message;
    }
    if (status === 409) return text.conflict;
    if (status === 429) return text.codes.rate_limited ?? "";
    return text.failedStatus(status);
  }
  if (error instanceof z.ZodError) {
    const labels = error.issues.map(issue => text.fieldNames[String(issue.path[0] === "fields" ? issue.path[1] : issue.path[0])]);
    if (labels.some(label => label === undefined)) return text.badData;
    return text.badShape([...new Set(labels)].join(", "));
  }
  if (error instanceof TimeoutError || (error instanceof TypeError && /fetch|network|load failed/i.test(error.message))) return text.offline;
  return text.failed;
}

export const isUnauthorized = (error: unknown) => error instanceof HTTPError && error.response.status === 401;
