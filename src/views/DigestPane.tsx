import { useEffect, useMemo, useState } from "react";
import type { MouseEvent } from "react";
import { CalendarDays, Layers, Mail, Newspaper } from "lucide-react";
import type { DigestHit, DigestSummary } from "../../shared/contracts";
import { errorMessage, loadDigests, searchDigests } from "../api";
import { BackButton, Chip, Empty, SidebarOpen } from "../components/primitives";
import { SearchField, useSearch } from "../components/SearchField";
import { addDays, digestHasPart, localDate } from "../model";
import { formatRoute } from "../router";
import { useDashboard } from "../state";
import { text, digestPart, type DigestFilter, filterParts, DIGEST_FILTERS, filterLabel, partLabel, dayTitle, slotName, sectionTitle, dayHeading } from "./digest-common";
import { splitUpdate } from "./digest-interaction";
import { DigestRow } from "./DigestCards";
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
function ListSkeleton({ label }: { readonly label: string }) {
  return <div className="record-groups" role="status">
    <p className="day-label">{label}</p>
    <ul className="digest-list" aria-hidden="true">{[0, 1].map(index => <li key={index} className="digest-row skeleton-row">
      <span className="digest-mark" /><span className="digest-row-main"><span className="skeleton-line short" /><span className="skeleton-line" /><span className="skeleton-line" /><span className="skeleton-line tiny" /></span>
    </li>)}</ul>
  </div>;
}


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
      <div className="pane-title-row"><SidebarOpen />
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
              <span className="digest-hit-meta">{dayTitle(hit.date)} {slotName(hit.slot)} · {sectionTitle({ key: hit.section, title: hit.sectionTitle })}{"from" in hit.item ? ` · ${hit.item.from}` : ""}</span>
              <span className="digest-hit-title">{title}</span>
              {hit.item.summary && <span className="digest-hit-summary">{splitUpdate(hit.item.summary).text}</span>}
            </a>
          </li>;
        })}</ul>
      : loading ? <ListSkeleton label={t.loadingList} />
        : items.length === 0 ? date
          ? <Empty icon={<Newspaper size={20} aria-hidden="true" />} action={<button type="button" className="btn btn-outline" onClick={() => pickDate("")}>{t.showLast2Weeks}</button>}>{t.noneOnDate[part]}</Empty>
          : <Empty icon={<Newspaper size={20} aria-hidden="true" />} action={<div className="account-stack">
            <p className="setting-note">{t.uploadHelp}</p><div className="account-actions">
              <a className="btn btn-outline" href="#/channels">{t.connectAgent}</a>
              <a href="https://github.com/floweredao/agentic-dashboard/blob/main/docs/agents.md" target="_blank" rel="noreferrer">{t.uploadGuide}</a>
            </div></div>}>{t.noneYet[part]}</Empty>
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
