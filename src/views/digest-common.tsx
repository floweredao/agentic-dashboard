import { Clock3, Moon, Sun } from "lucide-react";
import { MESSAGE_IMPORTANCE } from "../../shared/contracts";
import type { DigestArticle, DigestMessage, DigestPart, DigestSummary, MessageImportance } from "../../shared/contracts";
import { formatDateTime, strings } from "../i18n";
import { addDays, localDate } from "../model";
import type { Params } from "../router";
export const text = strings({
  en: {
    uploadHelp: "Your agent supplies these digests. It must collect the sources and upload a digest or briefing folder; this app does not subscribe to news or read your mailbox automatically.",
    uploadGuide: "Agent upload instructions", connectAgent: "Connect an agent",
    fullscreen: "Full screen", fullscreenTitle: "Read in full screen", exitFullscreen: "Close", loadingList: "Loading digests",
    parts: { articles: "Articles", messages: "Messages" }, social: "Social",
    importance: { urgent: "Act now", todo: "To do", check: "Review", info: "FYI" },
    all: "All", today: "Today", yesterday: "Yesterday", morning: "Morning", evening: "Evening",
    digestOf: (name: string) => `${name} digest`,
    count: (n: number) => `${n}`, countedIn: (label: string, n: number) => `${label} ${n}`,
    noNewMessages: "No new messages", noContent: "Nothing here", unread: "Unread ", merged: (n: number) => `${n} stories combined`,
    openOriginal: "Open original", updated: "Updated", toolbar: "Tools", jumpTo: "Jump to section",
    emptyPart: { all: "This digest has no content", articles: "This digest has no articles", messages: "This digest has no messages" },
    nothingThisTime: "None this time", loading: "Loading", markRead: "Mark as read", markUnread: "Mark as unread", more: "More",
    digests: "Digests", filterGroup: "All, articles, messages", searchIn: (name: string) => `Search ${name.toLowerCase()}`,
    placeholder: { all: "Search articles and messages", articles: "Search articles", messages: "Search messages" },
    dateGroup: "Date", last2Weeks: "Last 2 weeks", date: "Date", pickDate: "Pick a date",
    searching: "Searching", clearSearch: "Clear search", noResults: "No results", showLast2Weeks: "Show last 2 weeks",
    noneOnDate: { all: "No digests on this date", articles: "No article digests on this date", messages: "No message digests on this date" },
    noneYet: { all: "No digests yet", articles: "No article digests yet", messages: "No message digests yet" },
    earlier2Weeks: "Show the 2 weeks before",
    wholeDigest: "Whole digest", digestAudio: "Digest", makeAudio: "Generate audio", voiceLegend: "Audio to generate", cancel: "Cancel", create: "Generate",
    voiceHints: { all: "Reads the articles, then the messages, in one audio.", messages: "Reads only the messages.", articles: "Reads only the articles." },
    voiceNotes: { cannotNow: "Can't generate it right now", keyNeeded: "Needs a Gemini key", ready: "Audio is ready · listen from More",
      failed: "Couldn't generate it · try again from More", making: "Generating audio…" },
    updateTag: "Update", titlesOnly: "Titles only", end: (n: number) => `End of digest · ${n} ${n === 1 ? "item" : "items"}`,
    reaction: { like: "Like", dislike: "Not for me", seen: "Seen it" }, reactTo: (title: string) => `Your take on: ${title}`,
  },
  ko: {
    uploadHelp: "에이전트가 올린 다이제스트를 보여 줘요. 에이전트가 소스를 모아 다이제스트나 브리핑 폴더를 업로드해야 하며, 앱이 뉴스를 구독하거나 메일함을 자동으로 읽지는 않아요.",
    uploadGuide: "에이전트 업로드 안내", connectAgent: "에이전트 연결",
    fullscreen: "전체화면", fullscreenTitle: "전체화면으로 보기", exitFullscreen: "닫기", loadingList: "다이제스트 불러오는 중",
    parts: { articles: "기사", messages: "메시지" }, social: "소셜",
    importance: { urgent: "즉시 조치", todo: "할 일", check: "확인", info: "참고" },
    all: "전체", today: "오늘", yesterday: "어제", morning: "아침", evening: "저녁",
    digestOf: (name: string) => `${name} 다이제스트`,
    count: (n: number) => `${n}건`, countedIn: (label: string, n: number) => `${label} ${n}건`,
    noNewMessages: "새 메시지 없음", noContent: "내용 없음", unread: "안 읽음 ", merged: (n: number) => `${n}건 통합`,
    openOriginal: "원문 열기", updated: "업데이트", toolbar: "도구 모음", jumpTo: "섹션으로 이동",
    emptyPart: { all: "이 회차에는 내용이 없어요", articles: "이 회차에는 기사가 없어요", messages: "이 회차에는 메시지가 없어요" },
    nothingThisTime: "이번 회차에는 없음", loading: "불러오는 중", markRead: "읽음으로 표시", markUnread: "안 읽음으로 표시", more: "더보기",
    digests: "다이제스트", filterGroup: "전체·기사·메시지", searchIn: (name: string) => `${name} 검색`,
    placeholder: { all: "기사·메시지 검색", articles: "기사 검색", messages: "메시지 검색" },
    dateGroup: "날짜", last2Weeks: "최근 2주", date: "날짜", pickDate: "날짜 고르기",
    searching: "검색하는 중", clearSearch: "검색 지우기", noResults: "검색 결과 없음", showLast2Weeks: "최근 2주 보기",
    noneOnDate: { all: "이 날짜의 다이제스트 없음", articles: "이 날짜의 기사 다이제스트 없음", messages: "이 날짜의 메시지 다이제스트 없음" },
    noneYet: { all: "아직 다이제스트 없음", articles: "아직 기사 다이제스트 없음", messages: "아직 메시지 다이제스트 없음" },
    earlier2Weeks: "이전 2주 보기",
    wholeDigest: "전체", digestAudio: "전체", makeAudio: "음성 만들기", voiceLegend: "만들 음성", cancel: "취소", create: "만들기",
    voiceHints: { all: "기사와 메시지를 한 번에 이어서 읽어요.", messages: "메시지만 읽어요.", articles: "기사만 읽어요." },
    voiceNotes: { cannotNow: "지금은 만들 수 없어요", keyNeeded: "Gemini 키가 필요해요", ready: "만들어 둔 음성이 있어요 · 더보기에서 듣기",
      failed: "만들지 못했어요 · 더보기에서 다시 시도", making: "만드는 중이에요" },
    updateTag: "업데이트", titlesOnly: "제목만 보기", end: (n: number) => `다이제스트 끝 · ${n}건`,
    reaction: { like: "좋아요", dislike: "별로예요", seen: "이미 봤어요" }, reactTo: (title: string) => `이 기사 반응: ${title}`,
  },
});

export const partLabel = (part: DigestPart) => text().parts[part];

export const importanceLabel = (level: MessageImportance) => text().importance[level];

/** A section's name: the `social` section (posts from social networks) reads Social / 소셜 in the app's language, any other its own title. */
export const sectionTitle = (section: { readonly key: string; readonly title: string }) => section.key === "social" ? text().social : section.title;

/** A calendar day (YYYY-MM-DD) has no time zone: format it at noon UTC, read back in UTC. */
const noon = (date: string) => new Date(`${date}T12:00:00Z`);

const calendarDay = (date: string, options: Intl.DateTimeFormatOptions) => formatDateTime(noon(date), { ...options, timeZone: "UTC" });

export const slotName = (slot: string) => slot === "morning" ? text().morning : slot === "evening" ? text().evening : slot;


export const slotTitle = (slot: string) => text().digestOf(slotName(slot));

export const clockOf = (iso: string) => formatDateTime(iso, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

export const dayTitle = (date: string) => calendarDay(date, { month: "long", day: "numeric", weekday: "long" });

export function dayHeading(date: string, today = localDate()) {
  const relative = date === today ? text().today : date === addDays(today, -1) ? text().yesterday : "";
  return relative ? `${relative} · ${dayTitle(date)}` : dayTitle(date);
}

export function publishedLabel(item: DigestArticle, digestDate: string) {
  if (item.publishedAt) {
    const at = new Date(item.publishedAt);
    return localDate(at) === digestDate ? formatDateTime(at, { hour: "numeric", minute: "2-digit" }) : formatDateTime(at, { month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
  }
  return item.publishedDate ? calendarDay(item.publishedDate, { month: "long", day: "numeric" }) : "";
}

export function SlotMark({ slot }: { readonly slot: string }) {
  const Icon = slot === "morning" ? Sun : slot === "evening" ? Moon : Clock3;
  return <span className={`digest-mark slot-${slot === "morning" || slot === "evening" ? slot : "extra"}`} aria-hidden="true"><Icon size={16} /></span>;
}

/** What the digest tab shows: all (both parts, the default), or only articles or messages. */
export type DigestFilter = "all" | DigestPart;

export const DIGEST_FILTERS = ["all", "articles", "messages"] as const satisfies readonly DigestFilter[];

export const filterLabel = (filter: DigestFilter) => filter === "all" ? text().all : partLabel(filter);

/** The parts a filter covers. */
export const filterParts = (filter: DigestFilter): readonly DigestPart[] => filter === "all" ? ["messages", "articles"] : [filter];

export const inFilter = (filter: DigestFilter, kind: DigestPart) => filter === "all" || filter === kind;


export const countsLine = (summary: DigestSummary, filter: DigestFilter) =>
  summary.outline.filter(section => inFilter(filter, section.kind) && section.items > 0).map(section => `${sectionTitle(section)} ${section.items}`).join(" · ")
  || (filter === "messages" ? text().noNewMessages : text().noContent);

export const sortedMessages = (items: readonly DigestMessage[]) => [...items].sort((a, b) => MESSAGE_IMPORTANCE.indexOf(a.importance) - MESSAGE_IMPORTANCE.indexOf(b.importance));


/** The filter the digest tab shows: `part=articles` is articles, `part=messages` messages, anything else all. */
export const digestPart = (params: Params): DigestFilter => params.part === "messages" ? "messages" : params.part === "articles" ? "articles" : "all";
