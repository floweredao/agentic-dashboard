/** Text the server writes for people (push notifications), in the dashboard's LOCALE. The UI has its own dictionaries in src/i18n. */
export type Locale = "en" | "ko";
export const LOCALES: readonly Locale[] = ["en", "ko"];

const en = {
  owner: "You",
  reviewTitle: (title: string) => `Needs review · ${title}`,
  reviewAsked: "asked for a review",
  replyTitle: (agent: string, title: string) => `${agent} replied · ${title}`,
  statusChanged: "changed the status",
  testTitle: "Dashboard notifications",
  testBody: "This device can receive notifications.",
};
const ko: typeof en = {
  owner: "나",
  reviewTitle: title => `확인 필요 · ${title}`,
  reviewAsked: "확인을 요청했어요",
  replyTitle: (agent, title) => `${agent} 답글 · ${title}`,
  statusChanged: "상태를 바꿨어요",
  testTitle: "대시보드 알림",
  testBody: "이 기기에서 알림을 받을 수 있어요.",
};
export const messages = (locale: Locale = "en") => locale === "ko" ? ko : en;
