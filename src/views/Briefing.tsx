import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import { flushSync } from "react-dom";
import { CalendarDays, ChevronRight, Clock3, ExternalLink, Layers, Mail, Moon, Newspaper, Sun } from "lucide-react";
import { BRIEFING_PART_LABELS, BRIEFING_SECTION_LABELS, BriefingSectionKeySchema, briefingPartId, MAIL_IMPORTANCE, MAIL_IMPORTANCE_LABELS, PART_SECTIONS } from "../../shared/contracts";
import type { Briefing, BriefingArticle, BriefingHit, BriefingMail, BriefingPart, BriefingSectionKey, BriefingSummary } from "../../shared/contracts";
import { errorMessage, loadBriefing, loadBriefings, searchBriefings } from "../api";
import { useNarration } from "../components/Listen";
import { Menu } from "../components/Menu";
import { BackButton, Chip, Empty } from "../components/primitives";
import { SearchField, useSearch } from "../components/SearchField";
import { addDays, seoulDate } from "../model";
import { formatRoute } from "../router";
import type { Params } from "../router";
import { useDashboard } from "../state";

const SHORT_LABELS: Record<BriefingSectionKey, string> = { mail: "메일", domestic: "국내", international: "해외", aiDevelopment: "AI" };
const seoul = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", ...options });
const noon = (date: string) => new Date(`${date}T12:00:00+09:00`);

export const slotTitle = (slot: string) => slot === "morning" ? "아침 브리핑" : slot === "evening" ? "저녁 브리핑" : `${slot} 브리핑`;
export const clockOf = (iso: string) => seoul({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
export const dayTitle = (date: string) => seoul({ month: "long", day: "numeric", weekday: "long" }).format(noon(date));
export function dayHeading(date: string, today = seoulDate()) {
  const relative = date === today ? "오늘" : date === addDays(today, -1) ? "어제" : "";
  return relative ? `${relative} · ${dayTitle(date)}` : dayTitle(date);
}
export function publishedLabel(item: BriefingArticle, briefingDate: string) {
  if (item.publishedAt) {
    const at = new Date(item.publishedAt);
    return seoulDate(at) === briefingDate ? seoul({ hour: "numeric", minute: "2-digit" }).format(at) : seoul({ month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }).format(at);
  }
  return item.publishedDate ? seoul({ month: "long", day: "numeric" }).format(noon(item.publishedDate)) : "";
}
const hostOf = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } };
function SlotMark({ slot }: { readonly slot: string }) {
  const Icon = slot === "morning" ? Sun : slot === "evening" ? Moon : Clock3;
  return <span className={`briefing-mark slot-${slot === "morning" || slot === "evening" ? slot : "extra"}`} aria-hidden="true"><Icon size={16} /></span>;
}
/** What the 브리핑 tab shows: 전체 (both parts, the default), or only 뉴스 or 메일. */
export type BriefingFilter = "all" | BriefingPart;
export const BRIEFING_FILTERS = ["all", "news", "mail"] as const satisfies readonly BriefingFilter[];
const FILTER_LABELS: Record<BriefingFilter, string> = { all: "전체", ...BRIEFING_PART_LABELS };
/** The parts a filter covers, 메일 first (it carries what needs doing). */
export const filterParts = (filter: BriefingFilter): readonly BriefingPart[] => filter === "all" ? ["mail", "news"] : [filter];
const filterSections = (filter: BriefingFilter) => filterParts(filter).flatMap(part => PART_SECTIONS[part]);

const countsLine = (counts: BriefingSummary["counts"], part: BriefingFilter) => part === "mail"
  ? (counts.mail ?? 0) > 0 ? `메일 ${counts.mail}` : "새 메일 없음"
  : filterSections(part).filter(key => (counts[key] ?? 0) > 0).map(key => `${SHORT_LABELS[key]} ${counts[key]}`).join(" · ") || "내용 없음";
const sortedMail = (items: readonly BriefingMail[]) => [...items].sort((a, b) => MAIL_IMPORTANCE.indexOf(a.importance) - MAIL_IMPORTANCE.indexOf(b.importance));

/** The filter the 브리핑 tab shows: `part=news` is 뉴스, `part=mail` 메일, anything else 전체. */
export const briefingPart = (params: Params): BriefingFilter => params.part === "mail" ? "mail" : params.part === "news" ? "news" : "all";
export const partReadAt = (item: Pick<BriefingSummary, "newsReadAt" | "mailReadAt">, part: BriefingPart) => part === "mail" ? item.mailReadAt : item.newsReadAt;
const hasPart = (summary: BriefingSummary, part: BriefingFilter) => filterSections(part).some(key => summary.counts[key] !== undefined);
const summaryItems = (summary: BriefingSummary, part: BriefingPart) => PART_SECTIONS[part].reduce((sum, key) => sum + (summary.counts[key] ?? 0), 0);
const partItems = (briefing: Briefing, part: BriefingPart) => PART_SECTIONS[part].reduce((sum, key) => sum + (briefing.sections[key]?.items.length ?? 0), 0);

/** Collapsed section keys, shared by every briefing and kept on this device. */
export const COLLAPSED_KEY = "agentic:briefing-collapsed";
/** A stored JSON array of section keys; anything malformed means nothing is collapsed. */
export function parseCollapsed(raw: string | null): ReadonlySet<BriefingSectionKey> {
  try {
    const value: unknown = JSON.parse(raw ?? "[]");
    return new Set(Array.isArray(value) ? value.flatMap(key => { const parsed = BriefingSectionKeySchema.safeParse(key); return parsed.success ? [parsed.data] : []; }) : []);
  } catch { return new Set(); }
}
// Storage can be unavailable (private mode, blocked); collapsing then lasts only for this screen.
const storage = () => { try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; } };
function useCollapsed() {
  const [collapsed, setCollapsed] = useState(() => parseCollapsed(storage()?.getItem(COLLAPSED_KEY) ?? null));
  const setExpanded = (key: BriefingSectionKey, expanded: boolean) => setCollapsed(current => {
    if (current.has(key) !== expanded) return current;
    const next = new Set(current);
    if (expanded) next.delete(key); else next.add(key);
    try { storage()?.setItem(COLLAPSED_KEY, JSON.stringify([...next])); } catch { /* quota or blocked storage: keep the in-memory state */ }
    return next;
  });
  return [collapsed, setExpanded] as const;
}

/** One briefing in the list: unread dot (in 전체, any unread part with items), its headline (first news title, else the most important mail) and counts. */
export function BriefingRow({ summary, part, selected, href, onOpen }: {
  readonly summary: BriefingSummary; readonly part: BriefingFilter; readonly selected: boolean; readonly href: string;
  readonly onOpen: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const unread = part === "all"
    ? filterParts(part).some(each => summaryItems(summary, each) > 0 && partReadAt(summary, each) === null)
    : partReadAt(summary, part) === null;
  const headline = part === "mail" ? summary.mailHeadline : part === "news" ? summary.headlines[0] : summary.headlines[0] ?? summary.mailHeadline;
  return <li><a className={`briefing-row${unread ? " unread" : ""}`} href={href} aria-current={selected ? "true" : undefined} onClick={onOpen}>
    <SlotMark slot={summary.slot} />
    <span className="briefing-row-main">
      <span className="briefing-row-top">
        <span className="briefing-row-title">{unread && <span className="unread-dot" aria-hidden="true" />}{unread && <span className="visually-hidden">안 읽음 </span>}{slotTitle(summary.slot)}</span>
        <time className="briefing-row-time" dateTime={summary.scheduledAt}>{clockOf(summary.scheduledAt)}</time>
      </span>
      {headline && <span className="briefing-row-headline">{headline}</span>}
      <span className="briefing-row-meta">
        <span>{countsLine(summary.counts, part)}</span>
        {part !== "news" && summary.urgent > 0 && <span className="importance urgent">즉시 조치 {summary.urgent}</span>}
        {part !== "news" && summary.todo > 0 && <span className="importance todo">할 일 {summary.todo}</span>}
      </span>
    </span>
  </a></li>;
}

function ArticleCard({ item, index, date, section, focused }: {
  readonly item: BriefingArticle; readonly index: number; readonly date: string; readonly section: BriefingSectionKey; readonly focused: boolean;
}) {
  const href = item.originalUrl ?? item.url;
  const meta = [item.source, publishedLabel(item, date)].filter(Boolean).join(" · ");
  return <li id={`item-${section}-${item.key}`} className={focused ? "focused" : undefined}>
    <a className="briefing-card" href={href} target="_blank" rel="noopener noreferrer">
      <span className="briefing-card-meta"><span className="briefing-num">{String(index + 1).padStart(2, "0")}</span>{meta}</span>
      <span className="briefing-card-title">{item.title}</span>
      {item.summary && <span className="briefing-card-summary">{item.summary}</span>}
      <span className="briefing-card-foot">{hostOf(href)}<ExternalLink size={13} aria-hidden="true" /></span>
    </a>
  </li>;
}

function MailCard({ item, focused }: { readonly item: BriefingMail; readonly focused: boolean }) {
  const body = <>
    <span className="briefing-card-meta">
      <span className={`importance ${item.importance}`}>{MAIL_IMPORTANCE_LABELS[item.importance]}</span>
      <span className="mail-from">{item.from}{item.address && <span className="mail-address"> · {item.address}</span>}</span>
      {item.merged > 1 && <span>{item.merged}건 통합</span>}
    </span>
    <span className="briefing-card-title">{item.subject}</span>
    {item.summary && <span className="briefing-card-summary">{item.summary}</span>}
    {item.action && <span className="mail-action">{item.action}</span>}
    {item.url && <span className="briefing-card-foot">메일에서 열기<ExternalLink size={13} aria-hidden="true" /></span>}
  </>;
  return <li id={`item-mail-${item.key}`} className={focused ? "focused" : undefined}>
    {item.url ? <a className="briefing-card mail-card" href={item.url} target="_blank" rel="noopener noreferrer">{body}</a>
      : <div className="briefing-card mail-card">{body}</div>}
  </li>;
}

const NO_SECTIONS: ReadonlySet<BriefingSectionKey> = new Set();

/**
 * A briefing under a filter: date and slot, then the sections (메일 first) as cards; `listen` and `actions` slot in under the title.
 * Each section head is a disclosure button; `collapsed` sections keep their head and hide the body.
 */
export function BriefingView({ briefing, part, focus, actions, listen, collapsed = NO_SECTIONS, onExpand }: {
  readonly briefing: Briefing; readonly part: BriefingFilter; readonly focus?: string; readonly actions?: ReactNode; readonly listen?: ReactNode;
  readonly collapsed?: ReadonlySet<BriefingSectionKey>; readonly onExpand?: (key: BriefingSectionKey, expanded: boolean) => void;
}) {
  const sections = filterSections(part).filter(key => briefing.sections[key] !== undefined);
  const present = filterParts(part).filter(each => PART_SECTIONS[each].some(key => briefing.sections[key] !== undefined));
  const totals = part === "all" ? present.map(each => `${BRIEFING_PART_LABELS[each]} ${partItems(briefing, each)}건`).join(" · ") || "0건"
    : `${BRIEFING_PART_LABELS[part]} ${partItems(briefing, part)}건`;
  const mail = briefing.sections.mail;
  const mailCounts = MAIL_IMPORTANCE.map(level => [level, mail?.items.filter(item => item.importance === level).length ?? 0] as const).filter(([, count]) => count > 0);
  const updated = briefing.updatedAt !== briefing.createdAt;
  return <article className="reader briefing" aria-labelledby="briefing-title">
    <div className="reader-inner">
      <BackButton place="reader" />
      <p className="briefing-kicker"><SlotMark slot={briefing.slot} />{slotTitle(briefing.slot)} · {clockOf(briefing.scheduledAt)}</p>
      <h2 id="briefing-title" tabIndex={-1} className="reader-title">{dayTitle(briefing.date)}</h2>
      <p className="reader-dates">{totals}{updated && <> · 업데이트 {clockOf(briefing.updatedAt)}</>}</p>
      {actions && <div className="reader-actions" role="toolbar" aria-label="도구 모음">{actions}</div>}
      {listen}
      {sections.length === 0 && <p className="briefing-empty-section briefing-part-empty">{part === "mail" ? "이 회차에는 메일이 없어요" : part === "news" ? "이 회차에는 뉴스가 없어요" : "이 회차에는 내용이 없어요"}</p>}
      {sections.length > 1 && <nav className="briefing-jump" aria-label="섹션으로 이동">
        {sections.map(key => <a key={key} className="chip" href={`#section-${key}`} onClick={event => {
          event.preventDefault();
          // A collapsed section opens first, so the jump lands on its cards.
          if (collapsed.has(key)) flushSync(() => onExpand?.(key, true));
          document.getElementById(`section-${key}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
        }}>{BRIEFING_SECTION_LABELS[key]}<span className="chip-count">{briefing.sections[key]?.items.length ?? 0}</span></a>)}
      </nav>}
      {sections.map(key => {
        const section = briefing.sections[key];
        if (!section) return null;
        const expanded = !collapsed.has(key);
        const Icon = key === "mail" ? Mail : Newspaper;
        return <section key={key} id={`section-${key}`} className="briefing-section" aria-labelledby={`section-${key}-title`}>
          <header className="briefing-section-head">
            <h3 id={`section-${key}-title`}>
              <button type="button" className="briefing-section-toggle" aria-expanded={expanded} aria-controls={`section-${key}-body`}
                onClick={() => onExpand?.(key, !expanded)}>
                <ChevronRight className="briefing-chevron" size={16} aria-hidden="true" />
                <span className="briefing-section-icon" aria-hidden="true"><Icon size={15} /></span>
                <span className="briefing-section-label">{BRIEFING_SECTION_LABELS[key]}</span>
                <span className="count">{section.items.length}</span>
              </button>
            </h3>
            {key === "mail" && mailCounts.length > 0 && <span className="briefing-section-note">{mailCounts.map(([level, count]) => `${MAIL_IMPORTANCE_LABELS[level]} ${count}`).join(" · ")}</span>}
          </header>
          <div id={`section-${key}-body`} className="briefing-section-body" hidden={!expanded}>
            {section.shortfall && <p className="briefing-shortfall">{section.shortfall}</p>}
            {section.items.length === 0 ? <p className="briefing-empty-section">이번 회차에는 없음</p>
              : <ol className="briefing-cards">{key === "mail"
                ? sortedMail(briefing.sections.mail?.items ?? []).map(item => <MailCard key={item.key} item={item} focused={focus === `mail:${item.key}`} />)
                : (briefing.sections[key]?.items ?? []).map((item, index) => <ArticleCard key={item.key} item={item} index={index} date={briefing.date} section={key}
                  focused={focus === `${key}:${item.key}`} />)}</ol>}
          </div>
        </section>;
      })}
    </div>
  </article>;
}

const cache = new Map<string, Briefing>();

/**
 * The reader pane of 브리핑: loads the briefing, shows the filter's parts, marks each unread part with items read once,
 * and offers 듣기 per part.
 */
export function BriefingReader({ id, part }: { readonly id: string; readonly part: BriefingFilter }) {
  const d = useDashboard();
  const [briefing, setBriefing] = useState<Briefing | null>(() => cache.get(id) ?? null);
  const [failed, setFailed] = useState<string | null>(null);
  const [collapsed, setExpanded] = useCollapsed();
  const marked = useRef(false);
  const scrolledTo = useRef<string | null>(null);
  const known = d.briefings?.items.find(item => item.id === id);
  const readAtOf = (each: BriefingPart) => {
    const readKey = `${id}:${each}`;
    return d.briefingReads.has(readKey) ? d.briefingReads.get(readKey) ?? null
      : known ? partReadAt(known, each) : briefing ? partReadAt(briefing, each) : null;
  };
  // Only a part with something to read has a read state to change and something to narrate.
  const filled = briefing ? filterParts(part).filter(each => partItems(briefing, each) > 0) : [];
  const narrationOf = (each: BriefingPart) => briefing && filled.includes(each)
    ? { id: briefingPartId(id, each), title: `${dayTitle(briefing.date)} ${slotTitle(briefing.slot)} · ${BRIEFING_PART_LABELS[each]}`, version: briefing.version }
    : null;
  const label = (each: BriefingPart) => part === "all" ? BRIEFING_PART_LABELS[each] : undefined;
  const mailNarration = useNarration({ record: narrationOf("mail"), collection: "briefings", label: label("mail") });
  const newsNarration = useNarration({ record: narrationOf("news"), collection: "briefings", label: label("news") });
  useEffect(() => {
    let alive = true;
    loadBriefing(id).then(next => { cache.set(id, next); if (alive) setBriefing(next); },
      async (error: unknown) => { if (alive) setFailed(await errorMessage(error)); });
    return () => { alive = false; };
  }, [id, known?.version]);
  useEffect(() => {
    if (!briefing || marked.current) return;
    marked.current = true;
    document.getElementById("briefing-title")?.closest(".pane")?.scrollTo({ top: 0 });
    if (window.matchMedia("(max-width: 767px)").matches) document.getElementById("briefing-title")?.focus({ preventScroll: true });
    for (const each of filled) if (readAtOf(each) === null) void d.markBriefing(id, each, true, true);
  }, [briefing]);
  const focus = d.route.params.focus;
  useEffect(() => {
    if (!briefing || !focus || scrolledTo.current === focus) return;
    // A search hit inside a collapsed section opens that section, then scrolls once it renders.
    const section = BriefingSectionKeySchema.safeParse(focus.split(":")[0]);
    if (section.success && collapsed.has(section.data)) { setExpanded(section.data, true); return; }
    scrolledTo.current = focus;
    document.getElementById(`item-${focus.replace(":", "-")}`)?.scrollIntoView({ block: "center" });
  }, [briefing, focus, collapsed]);
  if (failed) return <div className="reader-empty"><Empty>{failed}</Empty></div>;
  if (!briefing) return <div className="reader-empty" role="status"><Empty icon={<Newspaper size={20} aria-hidden="true" />}>불러오는 중</Empty></div>;
  const unread = filled.some(each => readAtOf(each) === null);
  /** 읽음 marks every unread part; 안 읽음 (only when all are read) marks them all unread. One toast for the whole change. */
  const toggleRead = () => {
    const targets = filled.filter(each => (readAtOf(each) === null) === unread);
    targets.forEach((each, index) => { void d.markBriefing(id, each, unread, index < targets.length - 1); });
  };
  const narrationItems = [...mailNarration.items, ...newsNarration.items];
  const actions = filled.length > 0 && <>
    <button type="button" className="btn btn-outline" onClick={toggleRead}>
      {unread ? "읽음으로 표시" : "안 읽음으로 표시"}
    </button>
    {narrationItems.length > 0 && <Menu label="더보기" items={narrationItems} />}
  </>;
  return <BriefingView briefing={briefing} part={part} actions={actions} collapsed={collapsed} onExpand={setExpanded} {...(focus ? { focus } : {})}
    listen={<>{mailNarration.bar}{newsNarration.bar}</>} />;
}

const groupByDate = (items: readonly BriefingSummary[]) => {
  const groups: { date: string; items: BriefingSummary[] }[] = [];
  for (const item of items) {
    const last = groups.at(-1);
    if (last?.date === item.date) last.items.push(item); else groups.push({ date: item.date, items: [item] });
  }
  return groups;
};

/**
 * 브리핑 list: a 전체·뉴스·메일 switch (`part`, none = 전체), then the briefings with that part from the last two weeks by day
 * (or one chosen day), newest first; a search lists the matching articles and/or mail.
 */
export function BriefingPane() {
  const d = useDashboard();
  const search = useSearch();
  const { route, setParams } = d;
  const part = briefingPart(route.params);
  const date = route.params.date ?? "";
  const q = route.params.q ?? "";
  const today = seoulDate();
  const [day, setDay] = useState<{ date: string; items: BriefingSummary[] } | null>(null);
  const [older, setOlder] = useState<{ to: string; items: BriefingSummary[] }>({ to: "", items: [] });
  const [hits, setHits] = useState<{ q: string; part: BriefingFilter; items: BriefingHit[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const page = d.briefings;
  useEffect(() => { setOlder({ to: "", items: [] }); }, [page]);
  useEffect(() => {
    if (!date) return;
    let alive = true;
    loadBriefings({ from: date, to: date }).then(next => { if (alive) setDay({ date, items: next.items }); },
      async (cause: unknown) => { if (alive) setError(await errorMessage(cause)); });
    return () => { alive = false; };
  }, [date, page]);
  useEffect(() => {
    if (!q) return;
    let alive = true;
    searchBriefings(q, part === "all" ? undefined : part).then(items => { if (alive) setHits({ q, part, items }); }, async (cause: unknown) => { if (alive) setError(await errorMessage(cause)); });
    return () => { alive = false; };
  }, [q, part, page]);
  /** The App's per-part read overlay (`<id>:<part>`) wins over the loaded summaries. */
  const withReads = (items: readonly BriefingSummary[]) => items.filter(item => part === "all" || hasPart(item, part)).map(item => {
    const news = d.briefingReads.has(`${item.id}:news`) ? { newsReadAt: d.briefingReads.get(`${item.id}:news`) ?? null } : {};
    const mail = d.briefingReads.has(`${item.id}:mail`) ? { mailReadAt: d.briefingReads.get(`${item.id}:mail`) ?? null } : {};
    return { ...item, ...news, ...mail };
  });
  const items = useMemo(() => withReads(date ? day?.date === date ? day.items : [] : [...(page?.items ?? []), ...older.items]),
    [date, day, page, older, part, d.briefingReads]);
  const partEarliest = filterParts(part).map(each => page?.parts[each].earliestDate ?? null)
    .reduce<string | null>((first, each) => each !== null && (first === null || each < first) ? each : first, null);
  const earliest = older.to ? addDays(older.to, -13) : page?.from ?? "";
  const canLoadOlder = !date && partEarliest !== null && partEarliest < earliest;
  const loadOlder = async () => {
    const to = addDays(earliest, -1);
    try {
      const next = await loadBriefings({ from: addDays(to, -13), to });
      setOlder(current => ({ to, items: [...current.items, ...next.items] }));
    } catch (cause) { setError(await errorMessage(cause)); }
  };
  const open = (id: string, params: Record<string, string | null> = {}) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    d.open(id, params);
  };
  const pickDate = (value: string) => setParams({ date: value || null, q: null }, { replace: true });
  /** Switching replaces the entry like a filter; an open briefing stays open when it has the chosen part (전체 always keeps it). */
  const pickPart = (next: BriefingFilter) => {
    if (next === part) return;
    const known = [...(page?.items ?? []), ...older.items, ...(day?.items ?? [])].find(item => item.id === route.id);
    const params: Record<string, string> = { ...route.params };
    delete params.focus;
    if (next === "all") delete params.part; else params.part = next;
    d.navigate({ view: "briefing", id: next === "all" || (known && hasPart(known, next)) ? route.id : null, params }, { replace: true });
  };
  const dateChoices = [{ id: "", label: "최근 2주" }, { id: today, label: "오늘" }, { id: addDays(today, -1), label: "어제" }];
  const custom = date && !dateChoices.some(choice => choice.id === date);
  const searched = hits !== null && hits.q === q && hits.part === part;
  const loading = (date && day?.date !== date) || (q && !searched);
  const label = part === "all" ? "" : `${BRIEFING_PART_LABELS[part]} `;

  return <>
    <header className="pane-head">
      <BackButton place="list" />
      <div className="pane-title-row">
        <h1 className="pane-title">브리핑 <span className="count">{q ? searched ? hits.items.length : "" : items.length}</span></h1>
      </div>
      <div className="pane-toolbar">
        <div className="segmented" role="group" aria-label="전체·뉴스·메일">
          {BRIEFING_FILTERS.map(each => {
            const unread = (each === "all" ? page?.unread : page?.parts[each].unread) ?? 0;
            const Icon = each === "mail" ? Mail : each === "news" ? Newspaper : Layers;
            return <button key={each} type="button" aria-pressed={part === each} onClick={() => pickPart(each)}>
              <Icon size={15} aria-hidden="true" />{FILTER_LABELS[each]}
              {unread > 0 && <span className="segment-count"><span className="visually-hidden">안 읽음 </span>{unread}</span>}
            </button>;
          })}
        </div>
        <SearchField search={search} label={`${part === "all" ? "브리핑" : BRIEFING_PART_LABELS[part]} 검색`}
          placeholder={part === "mail" ? "메일 검색" : part === "news" ? "기사 검색" : "기사·메일 검색"} />
        {!q && <div className="chip-row" role="group" aria-label="날짜">
          {dateChoices.map(choice => <Chip key={choice.label} selected={date === choice.id} onClick={() => pickDate(choice.id)}>{choice.label}</Chip>)}
          <label className="chip date-chip" aria-pressed={custom ? true : undefined}>
            <CalendarDays size={14} aria-hidden="true" />{custom ? dayTitle(date) : "날짜"}
            <input type="date" aria-label="날짜 고르기" value={date} max={today} min={partEarliest ?? undefined}
              onChange={event => pickDate(event.currentTarget.value)} />
          </label>
        </div>}
      </div>
    </header>
    {error && <p className="pane-error" role="alert">{error}</p>}
    {q ? !searched ? <div role="status" className="empty">검색하는 중</div>
      : hits.items.length === 0 ? <Empty action={<button type="button" className="btn btn-outline" onClick={() => search.clear({ q: null })}>검색 지우기</button>}>검색 결과 없음</Empty>
        : <ul className="briefing-hits">{hits.items.map(hit => {
          const mail = "subject" in hit.item;
          const title = "subject" in hit.item ? hit.item.subject : hit.item.title;
          return <li key={`${hit.briefingId}-${hit.section}-${hit.item.key}`}>
            <a className="briefing-hit" href={formatRoute({ view: "briefing", id: hit.briefingId, params: { ...route.params, focus: `${hit.section}:${hit.item.key}` } })}
              aria-current={route.id === hit.briefingId && route.params.focus === `${hit.section}:${hit.item.key}` ? "true" : undefined}
              onClick={open(hit.briefingId, { focus: `${hit.section}:${hit.item.key}` })}>
              <span className="briefing-hit-meta">{dayTitle(hit.date)} {slotTitle(hit.slot).replace(" 브리핑", "")} · {BRIEFING_SECTION_LABELS[hit.section]}{mail && "from" in hit.item ? ` · ${hit.item.from}` : ""}</span>
              <span className="briefing-hit-title">{title}</span>
              {hit.item.summary && <span className="briefing-hit-summary">{hit.item.summary}</span>}
            </a>
          </li>;
        })}</ul>
      : loading ? <div role="status" className="empty">불러오는 중</div>
        : items.length === 0 ? date
          ? <Empty icon={<Newspaper size={20} aria-hidden="true" />} action={<button type="button" className="btn btn-outline" onClick={() => pickDate("")}>최근 2주 보기</button>}>{`이 날짜의 ${label}브리핑 없음`}</Empty>
          : <Empty icon={<Newspaper size={20} aria-hidden="true" />}>{`아직 ${label}브리핑 없음`}</Empty>
          : <div className="record-groups">
            {groupByDate(items).map(group => <section key={group.date} className="day-group" aria-label={dayHeading(group.date, today)}>
              <h2 className="day-label">{dayHeading(group.date, today)}</h2>
              <ul className="briefing-list">{group.items.map(summary => <BriefingRow key={summary.id} summary={summary} part={part}
                selected={route.id === summary.id} onOpen={open(summary.id, { focus: null })}
                href={formatRoute({ view: "briefing", id: summary.id, params: route.params })} />)}</ul>
            </section>)}
            {canLoadOlder && <div className="briefing-more"><button type="button" className="btn btn-outline" onClick={() => { void loadOlder(); }}>이전 2주 보기</button></div>}
          </div>}
  </>;
}
