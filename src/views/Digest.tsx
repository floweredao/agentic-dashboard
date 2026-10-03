import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import { flushSync } from "react-dom";
import { ArrowRight, CalendarDays, ChevronRight, Clock3, ExternalLink, Layers, Mail, Moon, Newspaper, Sun } from "lucide-react";
import { DigestSectionKeySchema, digestPartId, MESSAGE_IMPORTANCE } from "../../shared/contracts";
import type { Digest, DigestArticle, DigestHit, DigestMessage, DigestPart, DigestSummary, MessageImportance } from "../../shared/contracts";
import { errorMessage, loadDigest, loadDigests, searchDigests } from "../api";
import { useNarration } from "../components/Listen";
import { Menu } from "../components/Menu";
import { BackButton, Chip, Empty } from "../components/primitives";
import { SearchField, useSearch } from "../components/SearchField";
import { formatDateTime, strings } from "../i18n";
import { addDays, digestHasPart, digestPartItems, partReadAt, localDate } from "../model";
import { formatRoute } from "../router";
import type { Params } from "../router";
import { useDashboard } from "../state";

const text = strings({
  en: {
    parts: { articles: "Articles", messages: "Messages" },
    importance: { urgent: "Act now", todo: "To do", check: "Review", info: "FYI" },
    all: "All", today: "Today", yesterday: "Yesterday", morning: "Morning", evening: "Evening",
    digestOf: (name: string) => `${name} digest`,
    count: (n: number) => `${n}`, countedIn: (label: string, n: number) => `${label} ${n}`,
    noNewMessages: "No new messages", noContent: "Nothing here", unread: "Unread ", merged: (n: number) => `${n} merged`,
    openOriginal: "Open original", updated: "Updated", toolbar: "Tools", jumpTo: "Jump to section",
    emptyPart: { all: "This digest has no content", articles: "This digest has no articles", messages: "This digest has no messages" },
    nothingThisTime: "None this time", loading: "Loading", markRead: "Mark as read", markUnread: "Mark as unread", more: "More",
    digests: "Digests", filterGroup: "All, articles, messages", searchIn: (name: string) => `Search ${name.toLowerCase()}`,
    placeholder: { all: "Search articles and messages", articles: "Search articles", messages: "Search messages" },
    dateGroup: "Date", last2Weeks: "Last 2 weeks", date: "Date", pickDate: "Pick a date",
    searching: "Searching", clearSearch: "Clear search", noResults: "No results", showLast2Weeks: "Show last 2 weeks",
    noneOnDate: { all: "No digests on this date", articles: "No article digests on this date", messages: "No message digests on this date" },
    noneYet: { all: "No digests yet", articles: "No article digests yet", messages: "No message digests yet" },
    earlier2Weeks: "Show earlier 2 weeks",
    updateTag: "Update", titlesOnly: "Titles only", end: (n: number) => `End of digest · ${n} ${n === 1 ? "item" : "items"}`,
  },
  ko: {
    parts: { articles: "기사", messages: "메시지" },
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
    updateTag: "업데이트", titlesOnly: "제목만", end: (n: number) => `다이제스트 끝 · ${n}건`,
  },
});
const partLabel = (part: DigestPart) => text().parts[part];
const importanceLabel = (level: MessageImportance) => text().importance[level];
/** A calendar day (YYYY-MM-DD) has no time zone: format it at noon UTC, read back in UTC. */
const noon = (date: string) => new Date(`${date}T12:00:00Z`);
const calendarDay = (date: string, options: Intl.DateTimeFormatOptions) => formatDateTime(noon(date), { ...options, timeZone: "UTC" });
const slotName = (slot: string) => slot === "morning" ? text().morning : slot === "evening" ? text().evening : slot;

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
function SlotMark({ slot }: { readonly slot: string }) {
  const Icon = slot === "morning" ? Sun : slot === "evening" ? Moon : Clock3;
  return <span className={`digest-mark slot-${slot === "morning" || slot === "evening" ? slot : "extra"}`} aria-hidden="true"><Icon size={16} /></span>;
}
/** What the digest tab shows: all (both parts, the default), or only articles or messages. */
export type DigestFilter = "all" | DigestPart;
export const DIGEST_FILTERS = ["all", "articles", "messages"] as const satisfies readonly DigestFilter[];
const filterLabel = (filter: DigestFilter) => filter === "all" ? text().all : partLabel(filter);
/** The parts a filter covers. */
export const filterParts = (filter: DigestFilter): readonly DigestPart[] => filter === "all" ? ["messages", "articles"] : [filter];
const inFilter = (filter: DigestFilter, kind: DigestPart) => filter === "all" || filter === kind;

const countsLine = (summary: DigestSummary, filter: DigestFilter) =>
  summary.outline.filter(section => inFilter(filter, section.kind) && section.items > 0).map(section => `${section.title} ${section.items}`).join(" · ")
  || (filter === "messages" ? text().noNewMessages : text().noContent);
const sortedMessages = (items: readonly DigestMessage[]) => [...items].sort((a, b) => MESSAGE_IMPORTANCE.indexOf(a.importance) - MESSAGE_IMPORTANCE.indexOf(b.importance));

/** The filter the digest tab shows: `part=articles` is articles, `part=messages` messages, anything else all. */
export const digestPart = (params: Params): DigestFilter => params.part === "messages" ? "messages" : params.part === "articles" ? "articles" : "all";

/** Collapsed section keys, shared by every digest and kept on this device. */
export const COLLAPSED_KEY = "agentic:digest-collapsed";
/** A stored JSON array of section keys; anything malformed means nothing is collapsed. */
export function parseCollapsed(raw: string | null): ReadonlySet<string> {
  try {
    const value: unknown = JSON.parse(raw ?? "[]");
    return new Set(Array.isArray(value) ? value.flatMap(key => { const parsed = DigestSectionKeySchema.safeParse(key); return parsed.success ? [parsed.data] : []; }) : []);
  } catch { return new Set(); }
}
// Storage can be unavailable (private mode, blocked); collapsing then lasts only for this screen.
const storage = () => { try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; } };
function useCollapsed() {
  const [collapsed, setCollapsed] = useState(() => parseCollapsed(storage()?.getItem(COLLAPSED_KEY) ?? null));
  const setExpanded = (key: string, expanded: boolean) => setCollapsed(current => {
    if (current.has(key) !== expanded) return current;
    const next = new Set(current);
    if (expanded) next.delete(key); else next.add(key);
    try { storage()?.setItem(COLLAPSED_KEY, JSON.stringify([...next])); } catch { /* quota or blocked storage: keep the in-memory state */ }
    return next;
  });
  return [collapsed, setExpanded] as const;
}

/** Summary (every summary shown, the default) or titles (titles, sources and message actions only), kept on this device. */
export type DigestDensity = "summary" | "titles";
export const DENSITY_KEY = "agentic:digest-density";
function useDensity() {
  const [density, setDensity] = useState<DigestDensity>(() => storage()?.getItem(DENSITY_KEY) === "titles" ? "titles" : "summary");
  const choose = (next: DigestDensity) => {
    setDensity(next);
    try { if (next === "titles") storage()?.setItem(DENSITY_KEY, next); else storage()?.removeItem(DENSITY_KEY); } catch { /* blocked storage: keep it for this screen */ }
  };
  return [density, choose] as const;
}

/** An agent marks a revised item with a leading "Update:" (in English or Korean); the view shows one tag instead. */
const UPDATE_PREFIX = /^\s*(?:update[sd]?|업데이트) *[:：]/i; // i18n-allow: agents write this prefix into content in either language
export function splitUpdate(text: string): { readonly updated: boolean; readonly text: string } {
  const match = UPDATE_PREFIX.exec(text);
  if (!match) return { updated: false, text };
  const rest = text.slice(match[0].length).trimStart();
  return rest ? { updated: true, text: rest } : { updated: false, text };
}
/** A summary's first sentence and the rest. A sentence ends at . ! ? 。 … (with closing quotes or brackets) before a space, so "2.5" never splits. */
export function splitLede(summary: string): readonly [lede: string, rest: string] {
  const end = /[.!?。…]["'”’)\]]*(?=\s)/.exec(summary);
  if (!end) return [summary.trim(), ""];
  const cut = end.index + end[0].length;
  return [summary.slice(0, cut).trim(), summary.slice(cut).trim()];
}

/** The scroll owner of the open digest: the reader pane on split layouts, the document on phones. */
function scrollerOf(element: Element): Element {
  const pane = element.closest(".pane");
  return pane && getComputedStyle(pane).overflowY !== "visible" && pane.scrollHeight > pane.clientHeight ? pane : document.scrollingElement ?? document.documentElement;
}
/** Where the section bar's bottom edge sits once it is stuck: the line a section has to reach to be the current one. */
function stuckLine(bar: HTMLElement, scroller: Element) {
  const top = scroller === document.scrollingElement ? 0 : scroller.getBoundingClientRect().top;
  return top + (Number.parseFloat(getComputedStyle(bar).top) || 0) + bar.offsetHeight;
}
/** Scrolls a section's head to just under the stuck section bar. */
function jumpTo(key: string) {
  const section = document.getElementById(`section-${key}`);
  const bar = document.querySelector<HTMLElement>(".digest-bar");
  if (!section || !bar) return;
  const scroller = scrollerOf(section);
  const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  const top = section.getBoundingClientRect().top - stuckLine(bar, scroller) - 12;
  if (scroller === document.scrollingElement) window.scrollBy({ top, behavior }); else scroller.scrollBy({ top, behavior });
}
/** The section being read: the last one whose head has reached the stuck bar, the last one once the end is reached. */
function useCurrentSection(keys: readonly string[], layout: unknown) {
  const [current, setCurrent] = useState<string | undefined>(keys[0]);
  const joined = keys.join(",");
  useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      const bar = document.querySelector<HTMLElement>(".digest-bar");
      const first = keys[0] && document.getElementById(`section-${keys[0]}`);
      if (!bar || !first) return;
      const scroller = scrollerOf(first);
      const line = stuckLine(bar, scroller) + 16;
      const atEnd = scroller.scrollTop > 0 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
      let next = keys[0];
      for (const key of keys) {
        const section = document.getElementById(`section-${key}`);
        if (section && section.getBoundingClientRect().top <= line) next = key;
      }
      setCurrent(atEnd ? keys.at(-1) : next);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    measure();
    document.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      document.removeEventListener("scroll", schedule, { capture: true });
      window.removeEventListener("resize", schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [joined, layout]);
  return current;
}

/** A summary as its first sentence (what is new, body colour) and the rest (context, muted), without a leading update prefix. */
function Summary({ text: value }: { readonly text: string }) {
  const [lede, rest] = splitLede(splitUpdate(value).text);
  return <span className="digest-card-summary"><span className="digest-lede">{lede}</span>{rest && <> <span className="digest-rest">{rest}</span></>}</span>;
}

/** One digest in the list: unread dot (in all, any unread part with items), its headline (first article title, else the most important message) and counts. */
export function DigestRow({ summary, part, selected, href, onOpen }: {
  readonly summary: DigestSummary; readonly part: DigestFilter; readonly selected: boolean; readonly href: string;
  readonly onOpen: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const t = text();
  const unread = part === "all"
    ? filterParts(part).some(each => digestPartItems(summary, each) > 0 && partReadAt(summary, each) === null)
    : partReadAt(summary, part) === null;
  const first = part === "messages" ? summary.messageHeadline : part === "articles" ? summary.headlines[0] : summary.headlines[0] ?? summary.messageHeadline;
  const headline = first && splitUpdate(first).text;
  return <li><a className={`digest-row${unread ? " unread" : ""}`} href={href} aria-current={selected ? "true" : undefined} onClick={onOpen}>
    <SlotMark slot={summary.slot} />
    <span className="digest-row-main">
      <span className="digest-row-top">
        <span className="digest-row-title">{unread && <span className="unread-dot" aria-hidden="true" />}{unread && <span className="visually-hidden">{t.unread}</span>}{slotTitle(summary.slot)}</span>
        <time className="digest-row-time" dateTime={summary.scheduledAt}>{clockOf(summary.scheduledAt)}</time>
      </span>
      {headline && <span className="digest-row-headline">{headline}</span>}
      <span className="digest-row-meta">
        <span>{countsLine(summary, part)}</span>
        {part !== "articles" && summary.urgent > 0 && <span className="importance urgent">{importanceLabel("urgent")} {summary.urgent}</span>}
        {part !== "articles" && summary.todo > 0 && <span className="importance todo">{importanceLabel("todo")} {summary.todo}</span>}
      </span>
    </span>
  </a></li>;
}

/**
 * One article as a list item: number · source · time and an external-link mark, the title (a leading update prefix becomes a
 * small tag), then the summary unless only titles are shown. The whole item opens the original in a new tab.
 */
function ArticleCard({ item, index, date, section, focused, titles }: {
  readonly item: DigestArticle; readonly index: number; readonly date: string; readonly section: string; readonly focused: boolean;
  readonly titles: boolean;
}) {
  const t = text();
  const href = item.originalUrl ?? item.url;
  const meta = [item.source, publishedLabel(item, date)].filter(Boolean).join(" · ");
  const title = splitUpdate(item.title);
  const updated = title.updated || Boolean(item.summary && splitUpdate(item.summary).updated);
  return <li id={`item-${section}-${item.key}`} className={focused ? "focused" : undefined}>
    <a className="digest-card" href={href} target="_blank" rel="noopener noreferrer">
      <span className="digest-card-meta"><span className="digest-num">{String(index + 1).padStart(2, "0")}</span>
        <span className="digest-meta-end">{meta}<ExternalLink className="digest-card-out" size={12} aria-hidden="true" /></span></span>
      <span className="digest-card-title">{updated && <span className="digest-update">{t.updateTag}</span>}{title.text}</span>
      {!titles && item.summary && <Summary text={item.summary} />}
    </a>
  </li>;
}

/** One message as a list item: importance, sender, subject, summary (unless only titles are shown) and what to do, which always shows. */
function MessageCard({ item, section, focused, titles }: { readonly item: DigestMessage; readonly section: string; readonly focused: boolean; readonly titles: boolean }) {
  const t = text();
  const subject = splitUpdate(item.subject);
  // The external mark rides on the last meta piece so a narrow screen never wraps it onto a line of its own.
  const out = item.url && <><ExternalLink className="digest-card-out" size={12} aria-hidden="true" /><span className="visually-hidden">{t.openOriginal}</span></>;
  const body = <>
    <span className="digest-card-meta">
      <span className={`importance ${item.importance}`}>{importanceLabel(item.importance)}</span>
      <span className="message-from">{item.from}{item.address && <span className="message-address"> · {item.address}</span>}{item.merged <= 1 && out}</span>
      {item.merged > 1 && <span className="digest-meta-end">{t.merged(item.merged)}{out}</span>}
    </span>
    <span className="digest-card-title">{subject.updated && <span className="digest-update">{t.updateTag}</span>}{subject.text}</span>
    {!titles && item.summary && <Summary text={item.summary} />}
    {item.action && <span className="message-action"><ArrowRight size={15} aria-hidden="true" />{item.action}</span>}
  </>;
  return <li id={`item-${section}-${item.key}`} className={focused ? "focused" : undefined}>
    {item.url ? <a className="digest-card message-card" href={item.url} target="_blank" rel="noopener noreferrer">{body}</a>
      : <div className="digest-card message-card">{body}</div>}
  </li>;
}

const NO_SECTIONS: ReadonlySet<string> = new Set();

/**
 * A digest under a filter: date and slot, then its sections in stored order under their own titles, as lists; `listen` and
 * `actions` slot in under the title. A section bar stays stuck above the content: jump chips (the section being read marked
 * `aria-current="location"`) and titles only. Each section head is a disclosure button; `collapsed` sections keep their head
 * and hide the body. The end line counts the items shown.
 */
export function DigestView({ digest, part, focus, actions, listen, collapsed = NO_SECTIONS, onExpand, density = "summary", onDensity }: {
  readonly digest: Digest; readonly part: DigestFilter; readonly focus?: string; readonly actions?: ReactNode; readonly listen?: ReactNode;
  readonly collapsed?: ReadonlySet<string>; readonly onExpand?: (key: string, expanded: boolean) => void;
  readonly density?: DigestDensity; readonly onDensity?: (density: DigestDensity) => void;
}) {
  const t = text();
  const sections = digest.sections.filter(section => inFilter(part, section.kind));
  const titles = density === "titles";
  const current = useCurrentSection(sections.map(section => section.key), `${[...collapsed].join()}|${density}`);
  const shown = sections.reduce((sum, section) => sum + section.items.length, 0);
  const present = filterParts(part).filter(each => digest.sections.some(section => section.kind === each));
  const totals = part === "all" ? present.map(each => t.countedIn(partLabel(each), digestPartItems(digest, each))).join(" · ") || t.count(0)
    : t.countedIn(partLabel(part), digestPartItems(digest, part));
  const updated = digest.updatedAt !== digest.createdAt;
  return <article className={`reader digest${titles ? " titles" : ""}`} aria-labelledby="digest-title">
    <div className="reader-inner">
      <BackButton place="reader" />
      <p className="digest-kicker"><SlotMark slot={digest.slot} />{slotTitle(digest.slot)} · {clockOf(digest.scheduledAt)}</p>
      <h2 id="digest-title" tabIndex={-1} className="reader-title">{dayTitle(digest.date)}</h2>
      <p className="reader-dates">{totals}{updated && <> · {t.updated} {clockOf(digest.updatedAt)}</>}</p>
      {actions && <div className="reader-actions" role="toolbar" aria-label={t.toolbar}>{actions}</div>}
      {listen}
      {sections.length === 0 && <p className="digest-empty-section digest-part-empty">{t.emptyPart[part]}</p>}
      {sections.length > 0 && <div className="digest-bar">
        {sections.length > 1 && <nav className="digest-jump" aria-label={t.jumpTo}>
          {sections.map(section => <a key={section.key} className="chip" href={`#section-${section.key}`}
            aria-current={current === section.key ? "location" : undefined} onClick={event => {
              event.preventDefault();
              // A collapsed section opens first, so the jump lands on its items.
              if (collapsed.has(section.key)) flushSync(() => onExpand?.(section.key, true));
              jumpTo(section.key);
            }}>{section.title}<span className="chip-count">{section.items.length}</span></a>)}
        </nav>}
        <button type="button" className="chip digest-density" aria-pressed={titles} onClick={() => onDensity?.(titles ? "summary" : "titles")}>{t.titlesOnly}</button>
      </div>}
      {sections.map(section => {
        const { key } = section;
        const expanded = !collapsed.has(key);
        const Icon = section.kind === "messages" ? Mail : Newspaper;
        const levels = section.kind === "messages"
          ? MESSAGE_IMPORTANCE.map(level => [level, section.items.filter(item => item.importance === level).length] as const).filter(([, count]) => count > 0) : [];
        return <section key={key} id={`section-${key}`} className="digest-section" aria-labelledby={`section-${key}-title`}>
          <header className="digest-section-head">
            <h3 id={`section-${key}-title`}>
              <button type="button" className="digest-section-toggle" aria-expanded={expanded} aria-controls={`section-${key}-body`}
                onClick={() => onExpand?.(key, !expanded)}>
                <ChevronRight className="digest-chevron" size={16} aria-hidden="true" />
                <span className="digest-section-icon" aria-hidden="true"><Icon size={15} /></span>
                <span className="digest-section-label">{section.title}</span>
                <span className="count">{section.items.length}</span>
              </button>
            </h3>
            {levels.length > 0 && <span className="digest-section-note">{levels.map(([level, count]) => `${importanceLabel(level)} ${count}`).join(" · ")}</span>}
          </header>
          <div id={`section-${key}-body`} className="digest-section-body" hidden={!expanded}>
            {section.shortfall && <p className="digest-shortfall">{section.shortfall}</p>}
            {section.items.length === 0 ? <p className="digest-empty-section">{t.nothingThisTime}</p>
              : <ol className="digest-cards">{section.kind === "messages"
                ? sortedMessages(section.items).map(item => <MessageCard key={item.key} item={item} section={key} focused={focus === `${key}:${item.key}`} titles={titles} />)
                : section.items.map((item, index) => <ArticleCard key={item.key} item={item} index={index} date={digest.date} section={key}
                  focused={focus === `${key}:${item.key}`} titles={titles} />)}</ol>}
          </div>
        </section>;
      })}
      {sections.length > 0 && <p className="digest-end">{t.end(shown)}</p>}
    </div>
  </article>;
}

const cache = new Map<string, Digest>();

/**
 * The reader pane of the digest tab: loads the digest, shows the filter's parts, marks each unread part with items read once,
 * and offers listening per part.
 */
export function DigestReader({ id, part }: { readonly id: string; readonly part: DigestFilter }) {
  const t = text();
  const d = useDashboard();
  const [digest, setDigest] = useState<Digest | null>(() => cache.get(id) ?? null);
  const [failed, setFailed] = useState<string | null>(null);
  const [collapsed, setExpanded] = useCollapsed();
  const [density, setDensity] = useDensity();
  const marked = useRef(false);
  const scrolledTo = useRef<string | null>(null);
  const known = d.digests?.items.find(item => item.id === id);
  const readAtOf = (each: DigestPart) => {
    const readKey = `${id}:${each}`;
    return d.digestReads.has(readKey) ? d.digestReads.get(readKey) ?? null
      : known ? partReadAt(known, each) : digest ? partReadAt(digest, each) : null;
  };
  // Only a part with something to read has a read state to change and something to narrate.
  const filled = digest ? filterParts(part).filter(each => digestPartItems(digest, each) > 0) : [];
  const narrationOf = (each: DigestPart) => digest && filled.includes(each)
    ? { id: digestPartId(id, each), title: `${dayTitle(digest.date)} ${slotTitle(digest.slot)} · ${partLabel(each)}`, version: digest.version }
    : null;
  const label = (each: DigestPart) => part === "all" ? partLabel(each) : undefined;
  const messagesNarration = useNarration({ record: narrationOf("messages"), collection: "digests", label: label("messages") });
  const articlesNarration = useNarration({ record: narrationOf("articles"), collection: "digests", label: label("articles") });
  useEffect(() => {
    let alive = true;
    loadDigest(id).then(next => { cache.set(id, next); if (alive) setDigest(next); },
      async (error: unknown) => { if (alive) setFailed(await errorMessage(error)); });
    return () => { alive = false; };
  }, [id, known?.version]);
  useEffect(() => {
    if (!digest || marked.current) return;
    marked.current = true;
    document.getElementById("digest-title")?.closest(".pane")?.scrollTo({ top: 0 });
    if (window.matchMedia("(max-width: 767px)").matches) document.getElementById("digest-title")?.focus({ preventScroll: true });
    for (const each of filled) if (readAtOf(each) === null) void d.markDigest(id, each, true, true);
  }, [digest]);
  const focus = d.route.params.focus;
  useEffect(() => {
    if (!digest || !focus || scrolledTo.current === focus) return;
    // A search hit inside a collapsed section opens that section, then scrolls once it renders.
    const section = focus.split(":")[0] ?? "";
    if (collapsed.has(section)) { setExpanded(section, true); return; }
    scrolledTo.current = focus;
    document.getElementById(`item-${focus.replace(":", "-")}`)?.scrollIntoView({ block: "center" });
  }, [digest, focus, collapsed]);
  if (failed) return <div className="reader-empty"><Empty>{failed}</Empty></div>;
  if (!digest) return <div className="reader-empty" role="status"><Empty icon={<Newspaper size={20} aria-hidden="true" />}>{t.loading}</Empty></div>;
  const unread = filled.some(each => readAtOf(each) === null);
  /** Mark as read marks every unread part; mark as unread (only when all are read) marks them all unread. One toast for the whole change. */
  const toggleRead = () => {
    const targets = filled.filter(each => (readAtOf(each) === null) === unread);
    targets.forEach((each, index) => { void d.markDigest(id, each, unread, index < targets.length - 1); });
  };
  const narrationItems = [...messagesNarration.items, ...articlesNarration.items];
  const actions = filled.length > 0 && <>
    <button type="button" className="btn btn-outline" onClick={toggleRead}>
      {unread ? t.markRead : t.markUnread}
    </button>
    {narrationItems.length > 0 && <Menu label={t.more} items={narrationItems} />}
  </>;
  return <DigestView digest={digest} part={part} actions={actions} collapsed={collapsed} onExpand={setExpanded} density={density} onDensity={setDensity}
    {...(focus ? { focus } : {})}
    listen={<>{messagesNarration.bar}{articlesNarration.bar}</>} />;
}

const groupByDate = (items: readonly DigestSummary[]) => {
  const groups: { date: string; items: DigestSummary[] }[] = [];
  for (const item of items) {
    const last = groups.at(-1);
    if (last?.date === item.date) last.items.push(item); else groups.push({ date: item.date, items: [item] });
  }
  return groups;
};

/**
 * Digest list: an all/articles/messages switch (`part`, none = all), then the digests with that part from the last two weeks by
 * day (or one chosen day), newest first; a search lists the matching articles and/or messages.
 */
export function DigestPane() {
  const t = text();
  const d = useDashboard();
  const search = useSearch();
  const { route, setParams } = d;
  const part = digestPart(route.params);
  const date = route.params.date ?? "";
  const q = route.params.q ?? "";
  const today = localDate();
  const [day, setDay] = useState<{ date: string; items: DigestSummary[] } | null>(null);
  const [older, setOlder] = useState<{ to: string; items: DigestSummary[] }>({ to: "", items: [] });
  const [hits, setHits] = useState<{ q: string; part: DigestFilter; items: DigestHit[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const page = d.digests;
  useEffect(() => { setOlder({ to: "", items: [] }); }, [page]);
  useEffect(() => {
    if (!date) return;
    let alive = true;
    loadDigests({ from: date, to: date }).then(next => { if (alive) setDay({ date, items: next.items }); },
      async (cause: unknown) => { if (alive) setError(await errorMessage(cause)); });
    return () => { alive = false; };
  }, [date, page]);
  useEffect(() => {
    if (!q) return;
    let alive = true;
    searchDigests(q, part === "all" ? undefined : part).then(items => { if (alive) setHits({ q, part, items }); }, async (cause: unknown) => { if (alive) setError(await errorMessage(cause)); });
    return () => { alive = false; };
  }, [q, part, page]);
  /** The App's per-part read overlay (`<id>:<part>`) wins over the loaded summaries. */
  const withReads = (items: readonly DigestSummary[]) => items.filter(item => part === "all" || digestHasPart(item, part)).map(item => {
    const articles = d.digestReads.has(`${item.id}:articles`) ? { articlesReadAt: d.digestReads.get(`${item.id}:articles`) ?? null } : {};
    const messages = d.digestReads.has(`${item.id}:messages`) ? { messagesReadAt: d.digestReads.get(`${item.id}:messages`) ?? null } : {};
    return { ...item, ...articles, ...messages };
  });
  const items = useMemo(() => withReads(date ? day?.date === date ? day.items : [] : [...(page?.items ?? []), ...older.items]),
    [date, day, page, older, part, d.digestReads]);
  const partEarliest = filterParts(part).map(each => page?.parts[each].earliestDate ?? null)
    .reduce<string | null>((first, each) => each !== null && (first === null || each < first) ? each : first, null);
  const earliest = older.to ? addDays(older.to, -13) : page?.from ?? "";
  const canLoadOlder = !date && partEarliest !== null && partEarliest < earliest;
  const loadOlder = async () => {
    const to = addDays(earliest, -1);
    try {
      const next = await loadDigests({ from: addDays(to, -13), to });
      setOlder(current => ({ to, items: [...current.items, ...next.items] }));
    } catch (cause) { setError(await errorMessage(cause)); }
  };
  const open = (id: string, params: Record<string, string | null> = {}) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    d.open(id, params);
  };
  const pickDate = (value: string) => setParams({ date: value || null, q: null }, { replace: true });
  /** Switching replaces the entry like a filter; an open digest stays open when it has the chosen part (all always keeps it). */
  const pickPart = (next: DigestFilter) => {
    if (next === part) return;
    const known = [...(page?.items ?? []), ...older.items, ...(day?.items ?? [])].find(item => item.id === route.id);
    const params: Record<string, string> = { ...route.params };
    delete params.focus;
    if (next === "all") delete params.part; else params.part = next;
    d.navigate({ view: "digest", id: next === "all" || (known && digestHasPart(known, next)) ? route.id : null, params }, { replace: true });
  };
  const dateChoices = [{ id: "", label: t.last2Weeks }, { id: today, label: t.today }, { id: addDays(today, -1), label: t.yesterday }];
  const custom = date && !dateChoices.some(choice => choice.id === date);
  const searched = hits !== null && hits.q === q && hits.part === part;
  const loading = (date && day?.date !== date) || (q && !searched);

  return <>
    <header className="pane-head">
      <BackButton place="list" />
      <div className="pane-title-row">
        <h1 className="pane-title">{t.digests} <span className="count">{q ? searched ? hits.items.length : "" : items.length}</span></h1>
      </div>
      <div className="pane-toolbar">
        <div className="segmented" role="group" aria-label={t.filterGroup}>
          {DIGEST_FILTERS.map(each => {
            const unread = (each === "all" ? page?.unread : page?.parts[each].unread) ?? 0;
            const Icon = each === "messages" ? Mail : each === "articles" ? Newspaper : Layers;
            return <button key={each} type="button" aria-pressed={part === each} onClick={() => pickPart(each)}>
              <Icon size={15} aria-hidden="true" />{filterLabel(each)}
              {unread > 0 && <span className="segment-count"><span className="visually-hidden">{t.unread}</span>{unread}</span>}
            </button>;
          })}
        </div>
        <SearchField search={search} label={t.searchIn(part === "all" ? t.digests : partLabel(part))}
          placeholder={t.placeholder[part]} />
        {!q && <div className="chip-row" role="group" aria-label={t.dateGroup}>
          {dateChoices.map(choice => <Chip key={choice.label} selected={date === choice.id} onClick={() => pickDate(choice.id)}>{choice.label}</Chip>)}
          <label className="chip date-chip" aria-pressed={custom ? true : undefined}>
            <CalendarDays size={14} aria-hidden="true" />{custom ? dayTitle(date) : t.date}
            <input type="date" aria-label={t.pickDate} value={date} max={today} min={partEarliest ?? undefined}
              onChange={event => pickDate(event.currentTarget.value)} />
          </label>
        </div>}
      </div>
    </header>
    {error && <p className="pane-error" role="alert">{error}</p>}
    {q ? !searched ? <div role="status" className="empty">{t.searching}</div>
      : hits.items.length === 0 ? <Empty action={<button type="button" className="btn btn-outline" onClick={() => search.clear({ q: null })}>{t.clearSearch}</button>}>{t.noResults}</Empty>
        : <ul className="digest-hits">{hits.items.map(hit => {
          const title = splitUpdate("subject" in hit.item ? hit.item.subject : hit.item.title).text;
          const focusKey = `${hit.section}:${hit.item.key}`;
          return <li key={`${hit.digestId}-${focusKey}`}>
            <a className="digest-hit" href={formatRoute({ view: "digest", id: hit.digestId, params: { ...route.params, focus: focusKey } })}
              aria-current={route.id === hit.digestId && route.params.focus === focusKey ? "true" : undefined}
              onClick={open(hit.digestId, { focus: focusKey })}>
              <span className="digest-hit-meta">{dayTitle(hit.date)} {slotName(hit.slot)} · {hit.sectionTitle}{"from" in hit.item ? ` · ${hit.item.from}` : ""}</span>
              <span className="digest-hit-title">{title}</span>
              {hit.item.summary && <span className="digest-hit-summary">{splitUpdate(hit.item.summary).text}</span>}
            </a>
          </li>;
        })}</ul>
      : loading ? <div role="status" className="empty">{t.loading}</div>
        : items.length === 0 ? date
          ? <Empty icon={<Newspaper size={20} aria-hidden="true" />} action={<button type="button" className="btn btn-outline" onClick={() => pickDate("")}>{t.showLast2Weeks}</button>}>{t.noneOnDate[part]}</Empty>
          : <Empty icon={<Newspaper size={20} aria-hidden="true" />}>{t.noneYet[part]}</Empty>
          : <div className="record-groups">
            {groupByDate(items).map(group => <section key={group.date} className="day-group" aria-label={dayHeading(group.date, today)}>
              <h2 className="day-label">{dayHeading(group.date, today)}</h2>
              <ul className="digest-list">{group.items.map(summary => <DigestRow key={summary.id} summary={summary} part={part}
                selected={route.id === summary.id} onOpen={open(summary.id, { focus: null })}
                href={formatRoute({ view: "digest", id: summary.id, params: route.params })} />)}</ul>
            </section>)}
            {canLoadOlder && <div className="digest-more"><button type="button" className="btn btn-outline" onClick={() => { void loadOlder(); }}>{t.earlier2Weeks}</button></div>}
          </div>}
  </>;
}
