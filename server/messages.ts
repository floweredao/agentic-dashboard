import type { MessageImportance } from "../shared/contracts";

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
  digestLabel: (slot: string) => slot === "morning" ? "Morning digest" : slot === "evening" ? "Evening digest" : `${slot} digest`,
  digestMessageCount: (count: number) => `${count} ${count === 1 ? "message" : "messages"}`,
  digestArticleCount: (count: number) => `${count} ${count === 1 ? "article" : "articles"}`,
  /** Appended to the title when sections arrive after the digest itself. */
  digestAdded: " added",
  digestMore: (count: number) => ` +${count} more`,
  importance: { urgent: "Urgent", todo: "To do", check: "Check", info: "FYI" } as Record<MessageImportance, string>,
};
const ko: typeof en = {
  owner: "나",
  reviewTitle: title => `확인 필요 · ${title}`,
  reviewAsked: "확인을 요청했어요",
  replyTitle: (agent, title) => `${agent} 답글 · ${title}`,
  statusChanged: "상태를 바꿨어요",
  testTitle: "대시보드 알림",
  testBody: "이 기기에서 알림을 받을 수 있어요.",
  digestLabel: slot => slot === "morning" ? "아침 다이제스트" : slot === "evening" ? "저녁 다이제스트" : `${slot} 다이제스트`,
  digestMessageCount: count => `메시지 ${count}`,
  digestArticleCount: count => `기사 ${count}`,
  digestAdded: " 추가",
  digestMore: count => ` 외 ${count}건`,
  importance: { urgent: "즉시 조치", todo: "할 일", check: "확인", info: "참고" },
};
export const messages = (locale: Locale = "en") => locale === "ko" ? ko : en;
