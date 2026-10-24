import { strings } from "../i18n";
import { config } from "../config";
import { audioRecovery, accountErrorText } from "../account-errors";
/** A part's name ("Articles") inside an English command: "articles audio", or just "audio" without a part. */
const audioOf = (part: string) => part ? `${String(part).toLowerCase()} audio` : "audio";
/** A part's name in front of a Korean command, as Korean word order puts it. */
const prefixOf = (part: string) => part ? `${part} ` : "";

export type Failures = Readonly<Record<string, string>>;
type Text = { readonly failures: Failures; readonly requests: Failures; readonly [key: string]: unknown };
export const text = strings({
  en: {
    failures: {
      no_key: "No Gemini API key is set.",
      http_400: "Gemini rejected the request.",
      http_401: "Gemini rejected the API key.",
      http_403: "Gemini rejected the API key.",
      http_402: "Gemini's prepaid credits ran out, so the audio couldn't be generated.",
      http_429: "Gemini's per-minute limit was reached. Please try again in about a minute.",
      quota_daily: "Today's free Gemini quota is used up. Please try again tomorrow.",
      vertex_auth: "The Vertex AI login has expired or is missing. Run gcloud auth application-default login on the server again.",
      vertex_disabled: "Billing or the Vertex AI API is off for the Google Cloud project. Check them in the Google Cloud console.",
      vertex_quota: "The Vertex AI usage limit was reached. Please try again in a few minutes.",
      timeout: "Generating the audio took too long.",
      stalled: "Gemini stopped responding while writing the script. Try again shortly.",
      network: "Couldn't connect to Gemini.",
      record_missing: "The record was deleted, so the audio couldn't be generated.",
    },
    serverError: "Gemini's servers were busy and several retries didn't get through. Please try again in a moment.",
    failed: "Couldn't generate the audio.",
    requests: {
      narration_unavailable: "No Gemini API key is set, so audio can't be generated.",
      narration_daily_limit: "You've used today's audio limit. Try again tomorrow.",
      narration_queue_full: "Many audio jobs are waiting. Please try again in a moment.",
      narration_attempts_exhausted: "This content has failed several times.",
      narration_busy: "The audio is still being generated, so it can't be deleted yet.",
      narration_style_unsupported: "Digests can only be read aloud.",
    },
    spoken: (minutes: number, seconds: number) => `${minutes} min ${seconds} sec`,
    seconds: (value: number) => `${value} sec`, minutes: (value: number) => `${value} min`,
    pause: "Pause", play: "Play", position: (part: string) => part ? `${part} playback position` : "Playback position", speed: (rate: number) => `Playback speed ${rate}x`,
    fold: "Collapse player", listen: (part: string) => part ? `${part} audio` : "Listen", outdated: "Outdated",
    listenTo: (part: string) => part ? `Play ${audioOf(part)}` : "Listen",
    cancelMake: (part: string) => `Stop generating ${audioOf(part)}`, retry: "Try again", retryAudio: (part: string) => `Retry ${audioOf(part)}`,
    make: (part: string) => `Generate ${audioOf(part)}`, keyNeeded: " · key needed",
    makeNew: (part: string) => `Update ${audioOf(part)}`, makeAgain: (part: string) => `Regenerate ${audioOf(part)}`,
    viewScript: (part: string) => part ? `View ${String(part).toLowerCase()} script` : "View script",
    deleteAudio: "Delete audio", deleteAudioOf: (part: string) => `Delete ${audioOf(part)}`,
    cancelling: "Cancelling…", progress: (part: string) => part ? `${part} audio progress` : "Audio progress", dismiss: "Dismiss", remakeFailed: "Couldn't regenerate the audio",
    confirmRemake: "Regenerating the audio costs another Gemini charge. Regenerate it?",
    confirmDelete: "Delete the audio and its script? To listen again, you'll need to generate it again.",
    cancelled: "Stopped generating the audio.", deleted: "Audio deleted.", script: "Script",
    read: "Read aloud", readHint: "One voice reads the record clearly.",
    podcast: "Podcast", podcastHint: "Two hosts talk it through like a conversation.",
    styleLegend: "Audio style", remakeCost: "Regenerating costs another Gemini charge.",
    cancel: "Cancel", create: "Generate", makeTitle: "Generate audio", remakeTitle: "Regenerate audio",
  },
  ko: {
    failures: {
      no_key: "Gemini API 키가 설정되지 않았어요.",
      http_400: "Gemini가 요청을 거절했어요.",
      http_401: "Gemini가 API 키를 거절했어요.",
      http_403: "Gemini가 API 키를 거절했어요.",
      http_402: "Gemini 선불 크레딧이 바닥나 만들지 못했어요.",
      http_429: "Gemini 분당 사용 한도에 걸렸어요. 1분쯤 뒤 다시 시도해 주세요.",
      quota_daily: "오늘 Gemini 무료 한도를 다 썼어요. 내일 다시 시도해 주세요.",
      vertex_auth: "Vertex AI 로그인이 끝났거나 없어요. 서버에서 gcloud auth application-default login을 다시 해 주세요.",
      vertex_disabled: "Google Cloud 프로젝트의 결제나 Vertex AI API가 꺼져 있어요. Google Cloud 콘솔에서 확인해 주세요.",
      vertex_quota: "Vertex AI 사용 한도에 걸렸어요. 몇 분 뒤 다시 시도해 주세요.",
      timeout: "시간이 너무 오래 걸렸어요.",
      stalled: "Gemini가 원고를 쓰다 응답을 멈췄어요. 잠시 뒤 다시 시도해 주세요.",
      network: "Gemini에 연결하지 못했어요.",
      record_missing: "기록이 삭제되어 만들지 못했어요.",
    },
    serverError: "Gemini 서버가 붐비어 여러 번 다시 해 봤지만 만들지 못했어요. 잠시 뒤 다시 시도해 주세요.",
    failed: "음성을 만들지 못했어요.",
    requests: {
      narration_unavailable: "Gemini API 키가 설정되지 않아 음성을 만들 수 없어요.",
      narration_daily_limit: "오늘 만들 수 있는 음성 수를 다 썼어요. 내일 다시 시도해 주세요.",
      narration_queue_full: "기다리는 음성이 많아요. 잠시 뒤 다시 시도해 주세요.",
      narration_attempts_exhausted: "이 내용으로 여러 번 실패했어요.",
      narration_busy: "음성을 만드는 중이라 지금은 삭제할 수 없어요.",
      narration_style_unsupported: "다이제스트는 낭독으로만 만들 수 있어요.",
    },
    spoken: (minutes: number, seconds: number) => `${minutes}분 ${seconds}초`,
    seconds: (value: number) => `${value}초`, minutes: (value: number) => `${value}분`,
    pause: "일시정지", play: "재생", position: (part: string) => `${prefixOf(part)}재생 위치`, speed: (rate: number) => `재생 속도 ${rate}배`,
    fold: "플레이어 접기", listen: (part: string) => `${prefixOf(part)}듣기`, outdated: "예전 내용",
    listenTo: (part: string) => `${prefixOf(part)}듣기`,
    cancelMake: (part: string) => `${prefixOf(part)}음성 만들기 취소`, retry: "다시 시도", retryAudio: (part: string) => `${prefixOf(part)}다시 시도`,
    make: (part: string) => `${prefixOf(part)}음성 만들기`, keyNeeded: " · 키 필요",
    makeNew: (part: string) => `${prefixOf(part)}새로 만들기`, makeAgain: (part: string) => `${prefixOf(part)}다시 만들기`,
    viewScript: (part: string) => `${prefixOf(part)}원고 보기`,
    deleteAudio: "음성 삭제", deleteAudioOf: (part: string) => `${prefixOf(part)}음성 삭제`,
    cancelling: "취소하고 있어요", progress: (part: string) => `${prefixOf(part)}음성 만드는 진행`, dismiss: "알림 닫기", remakeFailed: "새 음성을 만들지 못했어요",
    confirmRemake: "음성을 다시 만들면 Gemini 요금이 한 번 더 들어요. 다시 만들까요?",
    confirmDelete: "음성 파일과 원고를 삭제할까요? 다시 들으려면 새로 만들어야 해요.",
    cancelled: "음성 만들기를 취소했어요.", deleted: "음성을 삭제했어요.", script: "원고",
    read: "낭독", readHint: "한 목소리가 기록을 또렷하게 읽어 줘요.",
    podcast: "팟캐스트", podcastHint: "두 진행자가 대화하듯 풀어 설명해 줘요.",
    styleLegend: "음성 스타일", remakeCost: "다시 만들면 Gemini 요금이 한 번 더 들어요.",
    cancel: "취소", create: "만들기", makeTitle: "음성 만들기", remakeTitle: "음성 다시 만들기",
  },
} satisfies { readonly en: Text; readonly ko: Text });

export function narrationFailure(code: string | null): string {
  const recovery = audioRecovery(code, config.authMode);
  switch (recovery) {
    case "operator": return accountErrorText().operator;
    case "key": return code === "no_key" || code === "gemini_key_required"
      ? accountErrorText().gemini_key_required : accountErrorText().gemini_key_invalid;
    case "permission": return accountErrorText().permission;
    case "model": return accountErrorText().model;
    case "admin": case null: break;
    default: { const exhaustive: never = recovery; return exhaustive; }
  }
  const failures: Failures = text().failures;
  const known = code ? failures[code] : undefined;
  if (known) return known;
  if (code?.startsWith("http_5")) return text().serverError;
  return text().failed;
}
