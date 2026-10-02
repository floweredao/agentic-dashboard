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
  digestArrived: (label: string) => `${label} arrived`,
  digestAdded: (label: string, sections: string) => `${label}: ${sections} added`,
  digestMessages: (count: number, urgent: number) => `${count} ${count === 1 ? "message" : "messages"}${urgent ? ` · ${urgent} urgent` : ""}`,
};
/** 이 after a final consonant, 가 after a vowel (Hangul only; anything else reads as a vowel). */
function subjectParticle(word: string) {
  const code = (word.at(-1) ?? "").charCodeAt(0);
  return code >= 0xac00 && code <= 0xd7a3 && (code - 0xac00) % 28 !== 0 ? "이" : "가";
}
const ko: typeof en = {
  owner: "나",
  reviewTitle: title => `확인 필요 · ${title}`,
  reviewAsked: "확인을 요청했어요",
  replyTitle: (agent, title) => `${agent} 답글 · ${title}`,
  statusChanged: "상태를 바꿨어요",
  testTitle: "대시보드 알림",
  testBody: "이 기기에서 알림을 받을 수 있어요.",
  digestLabel: slot => slot === "morning" ? "아침 다이제스트" : slot === "evening" ? "저녁 다이제스트" : `${slot} 다이제스트`,
  digestArrived: label => `${label} 왔어요`,
  digestAdded: (label, sections) => `${label}에 ${sections}${subjectParticle(sections)} 추가됐어요`,
  digestMessages: (count, urgent) => `메시지 ${count}건${urgent ? ` · 즉시 조치 ${urgent}건` : ""}`,
};
export const messages = (locale: Locale = "en") => locale === "ko" ? ko : en;
