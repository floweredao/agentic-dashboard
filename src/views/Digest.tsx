import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import { flushSync } from "react-dom";
import { CalendarDays, ChevronRight, Clock3, ExternalLink, Layers, Mail, Moon, Newspaper, Sun } from "lucide-react";
import { DigestSectionKeySchema, digestPartId, MESSAGE_IMPORTANCE } from "../../shared/contracts";
import type { Digest, DigestArticle, DigestHit, DigestMessage, DigestPart, DigestSummary, MessageImportance } from "../../shared/contracts";
import { errorMessage, loadDigest, loadDigests, searchDigests } from "../api";
import { useNarration } from "../components/Listen";
import { Menu } from "../components/Menu";
import { BackButton, Chip, Empty } from "../components/primitives";
import { SearchField, useSearch } from "../components/SearchField";
import { addDays, digestHasPart, digestPartItems, partReadAt, seoulDate } from "../model";
import { formatRoute } from "../router";
import type { Params } from "../router";
import { useDashboard } from "../state";

export const PART_LABELS: Record<DigestPart, string> = { articles: "기사", messages: "메시지" };
export const IMPORTANCE_LABELS: Record<MessageImportance, string> = { urgent: "즉시 조치", todo: "할 일", check: "확인", info: "참고" };
const seoul = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", ...options });
const noon = (date: string) => new Date(`${date}T12:00:00+09:00`);

export const slotTitle = (slot: string) => slot === "morning" ? "아침 다이제스트" : slot === "evening" ? "저녁 다이제스트" : `${slot} 다이제스트`;
export const clockOf = (iso: string) => seoul({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
export const dayTitle = (date: string) => seoul({ month: "long", day: "numeric", weekday: "long" }).format(noon(date));
export function dayHeading(date: string, today = seoulDate()) {
  const relative = date === today ? "오늘" : date === addDays(today, -1) ? "어제" : "";
  return relative ? `${relative} · ${dayTitle(date)}` : dayTitle(date);
}
export function publishedLabel(item: DigestArticle, digestDate: string) {
  if (item.publishedAt) {
    const at = new Date(item.publishedAt);
    return seoulDate(at) === digestDate ? seoul({ hour: "numeric", minute: "2-digit" }).format(at) : seoul({ month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }).format(at);
  }
  return item.publishedDate ? seoul({ month: "long", day: "numeric" }).format(noon(item.publishedDate)) : "";
}
const hostOf = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } };
function SlotMark({ slot }: { readonly slot: string }) {
  const Icon = slot === "morning" ? Sun : slot === "evening" ? Moon : Clock3;
  return <span className={`digest-mark slot-${slot === "morning" || slot === "evening" ? slot : "extra"}`} aria-hidden="true"><Icon size={16} /></span>;
}
/** What the 다이제스트 tab shows: 전체 (both parts, the default), or only 기사 or 메시지. */
export type DigestFilter = "all" | DigestPart;
export const DIGEST_FILTERS = ["all", "articles", "messages"] as const satisfies readonly DigestFilter[];
const FILTER_LABELS: Record<DigestFilter, string> = { all: "전체", ...PART_LABELS };
/** The parts a filter covers. */
export const filterParts = (filter: DigestFilter): readonly DigestPart[] => filter === "all" ? ["messages", "articles"] : [filter];
const inFilter = (filter: DigestFilter, kind: DigestPart) => filter === "all" || filter === kind;

const countsLine = (summary: DigestSummary, filter: DigestFilter) =>
  summary.outline.filter(section => inFilter(filter, section.kind) && section.items > 0).map(section => `${section.title} ${section.items}`).join(" · ")
  || (filter === "messages" ? "새 메시지 없음" : "내용 없음");
const sortedMessages = (items: readonly DigestMessage[]) => [...items].sort((a, b) => MESSAGE_IMPORTANCE.indexOf(a.importance) - MESSAGE_IMPORTANCE.indexOf(b.importance));

/** The filter the 다이제스트 tab shows: `part=articles` is 기사, `part=messages` 메시지, anything else 전체. */
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

/** One digest in the list: unread dot (in 전체, any unread part with items), its headline (first article title, else the most important message) and counts. */
export function DigestRow({ summary, part, selected, href, onOpen }: {
  readonly summary: DigestSummary; readonly part: DigestFilter; readonly selected: boolean; readonly href: string;
  readonly onOpen: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const unread = part === "all"
    ? filterParts(part).some(each => digestPartItems(summary, each) > 0 && partReadAt(summary, each) === null)
    : partReadAt(summary, part) === null;
  const headline = part === "messages" ? summary.messageHeadline : part === "articles" ? summary.headlines[0] : summary.headlines[0] ?? summary.messageHeadline;
  return <li><a className={`digest-row${unread ? " unread" : ""}`} href={href} aria-current={selected ? "true" : undefined} onClick={onOpen}>
    <SlotMark slot={summary.slot} />
    <span className="digest-row-main">
      <span className="digest-row-top">
        <span className="digest-row-title">{unread && <span className="unread-dot" aria-hidden="true" />}{unread && <span className="visually-hidden">안 읽음 </span>}{slotTitle(summary.slot)}</span>
        <time className="digest-row-time" dateTime={summary.scheduledAt}>{clockOf(summary.scheduledAt)}</time>
      </span>
      {headline && <span className="digest-row-headline">{headline}</span>}
      <span className="digest-row-meta">
        <span>{countsLine(summary, part)}</span>
        {part !== "articles" && summary.urgent > 0 && <span className="importance urgent">{IMPORTANCE_LABELS.urgent} {summary.urgent}</span>}
        {part !== "articles" && summary.todo > 0 && <span className="importance todo">{IMPORTANCE_LABELS.todo} {summary.todo}</span>}
      </span>
    </span>
  </a></li>;
}

function ArticleCard({ item, index, date, section, focused }: {
  readonly item: DigestArticle; readonly index: number; readonly date: string; readonly section: string; readonly focused: boolean;
}) {
  const href = item.originalUrl ?? item.url;
  const meta = [item.source, publishedLabel(item, date)].filter(Boolean).join(" · ");
  return <li id={`item-${section}-${item.key}`} className={focused ? "focused" : undefined}>
    <a className="digest-card" href={href} target="_blank" rel="noopener noreferrer">
      <span className="digest-card-meta"><span className="digest-num">{String(index + 1).padStart(2, "0")}</span>{meta}</span>
      <span className="digest-card-title">{item.title}</span>
      {item.summary && <span className="digest-card-summary">{item.summary}</span>}
      <span className="digest-card-foot">{hostOf(href)}<ExternalLink size={13} aria-hidden="true" /></span>
    </a>
  </li>;
}

function MessageCard({ item, section, focused }: { readonly item: DigestMessage; readonly section: string; readonly focused: boolean }) {
  const body = <>
    <span className="digest-card-meta">
      <span className={`importance ${item.importance}`}>{IMPORTANCE_LABELS[item.importance]}</span>
      <span className="message-from">{item.from}{item.address && <span className="message-address"> · {item.address}</span>}</span>
      {item.merged > 1 && <span>{item.merged}건 통합</span>}
    </span>
    <span className="digest-card-title">{item.subject}</span>
    {item.summary && <span className="digest-card-summary">{item.summary}</span>}
    {item.action && <span className="message-action">{item.action}</span>}
    {item.url && <span className="digest-card-foot">원문 열기<ExternalLink size={13} aria-hidden="true" /></span>}
  </>;
  return <li id={`item-${section}-${item.key}`} className={focused ? "focused" : undefined}>
    {item.url ? <a className="digest-card message-card" href={item.url} target="_blank" rel="noopener noreferrer">{body}</a>
      : <div className="digest-card message-card">{body}</div>}
  </li>;
}

const NO_SECTIONS: ReadonlySet<string> = new Set();

/**
 * A digest under a filter: date and slot, then its sections in stored order under their own titles, as cards; `listen` and
 * `actions` slot in under the title. Each section head is a disclosure button; `collapsed` sections keep their head and hide the body.
 */
export function DigestView({ digest, part, focus, actions, listen, collapsed = NO_SECTIONS, onExpand }: {
  readonly digest: Digest; readonly part: DigestFilter; readonly focus?: string; readonly actions?: ReactNode; readonly listen?: ReactNode;
  readonly collapsed?: ReadonlySet<string>; readonly onExpand?: (key: string, expanded: boolean) => void;
}) {
  const sections = digest.sections.filter(section => inFilter(part, section.kind));
  const present = filterParts(part).filter(each => digest.sections.some(section => section.kind === each));
  const totals = part === "all" ? present.map(each => `${PART_LABELS[each]} ${digestPartItems(digest, each)}건`).join(" · ") || "0건"
    : `${PART_LABELS[part]} ${digestPartItems(digest, part)}건`;
  const updated = digest.updatedAt !== digest.createdAt;
  return <article className="reader digest" aria-labelledby="digest-title">
    <div className="reader-inner">
      <BackButton place="reader" />
      <p className="digest-kicker"><SlotMark slot={digest.slot} />{slotTitle(digest.slot)} · {clockOf(digest.scheduledAt)}</p>
      <h2 id="digest-title" tabIndex={-1} className="reader-title">{dayTitle(digest.date)}</h2>
      <p className="reader-dates">{totals}{updated && <> · 업데이트 {clockOf(digest.updatedAt)}</>}</p>
      {actions && <div className="reader-actions" role="toolbar" aria-label="도구 모음">{actions}</div>}
      {listen}
      {sections.length === 0 && <p className="digest-empty-section digest-part-empty">{part === "messages" ? "이 회차에는 메시지가 없어요" : part === "articles" ? "이 회차에는 기사가 없어요" : "이 회차에는 내용이 없어요"}</p>}
      {sections.length > 1 && <nav className="digest-jump" aria-label="섹션으로 이동">
        {sections.map(section => <a key={section.key} className="chip" href={`#section-${section.key}`} onClick={event => {
          event.preventDefault();
          // A collapsed section opens first, so the jump lands on its cards.
          if (collapsed.has(section.key)) flushSync(() => onExpand?.(section.key, true));
          document.getElementById(`section-${section.key}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
        }}>{section.title}<span className="chip-count">{section.items.length}</span></a>)}
      </nav>}
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
            {levels.length > 0 && <span className="digest-section-note">{levels.map(([level, count]) => `${IMPORTANCE_LABELS[level]} ${count}`).join(" · ")}</span>}
          </header>
          <div id={`section-${key}-body`} className="digest-section-body" hidden={!expanded}>
            {section.shortfall && <p className="digest-shortfall">{section.shortfall}</p>}
            {section.items.length === 0 ? <p className="digest-empty-section">이번 회차에는 없음</p>
              : <ol className="digest-cards">{section.kind === "messages"
                ? sortedMessages(section.items).map(item => <MessageCard key={item.key} item={item} section={key} focused={focus === `${key}:${item.key}`} />)
                : section.items.map((item, index) => <ArticleCard key={item.key} item={item} index={index} date={digest.date} section={key}
                  focused={focus === `${key}:${item.key}`} />)}</ol>}
          </div>
        </section>;
      })}
    </div>
  </article>;
}

const cache = new Map<string, Digest>();

/**
 * The reader pane of 다이제스트: loads the digest, shows the filter's parts, marks each unread part with items read once,
 * and offers 듣기 per part.
 */
export function DigestReader({ id, part }: { readonly id: string; readonly part: DigestFilter }) {
  const d = useDashboard();
  const [digest, setDigest] = useState<Digest | null>(() => cache.get(id) ?? null);
  const [failed, setFailed] = useState<string | null>(null);
  const [collapsed, setExpanded] = useCollapsed();
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
    ? { id: digestPartId(id, each), title: `${dayTitle(digest.date)} ${slotTitle(digest.slot)} · ${PART_LABELS[each]}`, version: digest.version }
    : null;
  const label = (each: DigestPart) => part === "all" ? PART_LABELS[each] : undefined;
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
  if (!digest) return <div className="reader-empty" role="status"><Empty icon={<Newspaper size={20} aria-hidden="true" />}>불러오는 중</Empty></div>;
  const unread = filled.some(each => readAtOf(each) === null);
  /** 읽음 marks every unread part; 안 읽음 (only when all are read) marks them all unread. One toast for the whole change. */
  const toggleRead = () => {
    const targets = filled.filter(each => (readAtOf(each) === null) === unread);
    targets.forEach((each, index) => { void d.markDigest(id, each, unread, index < targets.length - 1); });
  };
  const narrationItems = [...messagesNarration.items, ...articlesNarration.items];
  const actions = filled.length > 0 && <>
    <button type="button" className="btn btn-outline" onClick={toggleRead}>
      {unread ? "읽음으로 표시" : "안 읽음으로 표시"}
    </button>
    {narrationItems.length > 0 && <Menu label="더보기" items={narrationItems} />}
  </>;
  return <DigestView digest={digest} part={part} actions={actions} collapsed={collapsed} onExpand={setExpanded} {...(focus ? { focus } : {})}
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
 * 다이제스트 list: a 전체·기사·메시지 switch (`part`, none = 전체), then the digests with that part from the last two weeks by
 * day (or one chosen day), newest first; a search lists the matching articles and/or messages.
 */
export function DigestPane() {
  const d = useDashboard();
  const search = useSearch();
  const { route, setParams } = d;
  const part = digestPart(route.params);
  const date = route.params.date ?? "";
  const q = route.params.q ?? "";
  const today = seoulDate();
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
  /** Switching replaces the entry like a filter; an open digest stays open when it has the chosen part (전체 always keeps it). */
  const pickPart = (next: DigestFilter) => {
    if (next === part) return;
    const known = [...(page?.items ?? []), ...older.items, ...(day?.items ?? [])].find(item => item.id === route.id);
    const params: Record<string, string> = { ...route.params };
    delete params.focus;
    if (next === "all") delete params.part; else params.part = next;
    d.navigate({ view: "digest", id: next === "all" || (known && digestHasPart(known, next)) ? route.id : null, params }, { replace: true });
  };
  const dateChoices = [{ id: "", label: "최근 2주" }, { id: today, label: "오늘" }, { id: addDays(today, -1), label: "어제" }];
  const custom = date && !dateChoices.some(choice => choice.id === date);
  const searched = hits !== null && hits.q === q && hits.part === part;
  const loading = (date && day?.date !== date) || (q && !searched);
  const label = part === "all" ? "" : `${PART_LABELS[part]} `;

  return <>
    <header className="pane-head">
      <BackButton place="list" />
      <div className="pane-title-row">
        <h1 className="pane-title">다이제스트 <span className="count">{q ? searched ? hits.items.length : "" : items.length}</span></h1>
      </div>
      <div className="pane-toolbar">
        <div className="segmented" role="group" aria-label="전체·기사·메시지">
          {DIGEST_FILTERS.map(each => {
            const unread = (each === "all" ? page?.unread : page?.parts[each].unread) ?? 0;
            const Icon = each === "messages" ? Mail : each === "articles" ? Newspaper : Layers;
            return <button key={each} type="button" aria-pressed={part === each} onClick={() => pickPart(each)}>
              <Icon size={15} aria-hidden="true" />{FILTER_LABELS[each]}
              {unread > 0 && <span className="segment-count"><span className="visually-hidden">안 읽음 </span>{unread}</span>}
            </button>;
          })}
        </div>
        <SearchField search={search} label={`${part === "all" ? "다이제스트" : PART_LABELS[part]} 검색`}
          placeholder={part === "messages" ? "메시지 검색" : part === "articles" ? "기사 검색" : "기사·메시지 검색"} />
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
        : <ul className="digest-hits">{hits.items.map(hit => {
          const title = "subject" in hit.item ? hit.item.subject : hit.item.title;
          const focusKey = `${hit.section}:${hit.item.key}`;
          return <li key={`${hit.digestId}-${focusKey}`}>
            <a className="digest-hit" href={formatRoute({ view: "digest", id: hit.digestId, params: { ...route.params, focus: focusKey } })}
              aria-current={route.id === hit.digestId && route.params.focus === focusKey ? "true" : undefined}
              onClick={open(hit.digestId, { focus: focusKey })}>
              <span className="digest-hit-meta">{dayTitle(hit.date)} {slotTitle(hit.slot).replace(" 다이제스트", "")} · {hit.sectionTitle}{"from" in hit.item ? ` · ${hit.item.from}` : ""}</span>
              <span className="digest-hit-title">{title}</span>
              {hit.item.summary && <span className="digest-hit-summary">{hit.item.summary}</span>}
            </a>
          </li>;
        })}</ul>
      : loading ? <div role="status" className="empty">불러오는 중</div>
        : items.length === 0 ? date
          ? <Empty icon={<Newspaper size={20} aria-hidden="true" />} action={<button type="button" className="btn btn-outline" onClick={() => pickDate("")}>최근 2주 보기</button>}>{`이 날짜의 ${label}다이제스트 없음`}</Empty>
          : <Empty icon={<Newspaper size={20} aria-hidden="true" />}>{`아직 ${label}다이제스트 없음`}</Empty>
          : <div className="record-groups">
            {groupByDate(items).map(group => <section key={group.date} className="day-group" aria-label={dayHeading(group.date, today)}>
              <h2 className="day-label">{dayHeading(group.date, today)}</h2>
              <ul className="digest-list">{group.items.map(summary => <DigestRow key={summary.id} summary={summary} part={part}
                selected={route.id === summary.id} onOpen={open(summary.id, { focus: null })}
                href={formatRoute({ view: "digest", id: summary.id, params: route.params })} />)}</ul>
            </section>)}
            {canLoadOlder && <div className="digest-more"><button type="button" className="btn btn-outline" onClick={() => { void loadOlder(); }}>이전 2주 보기</button></div>}
          </div>}
  </>;
}
