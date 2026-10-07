import { useMemo } from "react";
import type { MouseEvent } from "react";
import type { DigestSummary } from "../../shared/contracts";
import { Newspaper } from "lucide-react";
import { RecordList } from "../components/RecordList";
import { Chip, Time, SidebarOpen } from "../components/primitives";
import { SearchField, useSearch } from "../components/SearchField";
import { useListShortcuts } from "../hooks";
import { digestCounts, digestMatches, digestUnread, inboxDigestView, inboxStateOf, inboxStates, inboxView, listedDigestsFor, listedFor, matchesQuery, revisitDue, withDigestReads } from "../model";
import { formatRoute } from "../router";
import { strings } from "../i18n";
import { useDashboard } from "../state";
import { slotTitle } from "./Digest";

const text = strings({
  en: {
    empty: { pending: "Nothing to review", approved: "Nothing reviewed yet", all: "No items", starred: "No favorites yet. Tap ☆ Favorite on a record to collect it here." },
    unread: "Unread ", digest: "Digest", inbox: "Inbox",
    revisits: (count: number) => `${count} to revisit`,
    search: "Search inbox", placeholder: "Title, content, summary, tags", state: "Review status",
    noResults: "No results", clearSearch: "Clear search",
  },
  ko: {
    empty: { pending: "확인할 항목 없음", approved: "확인한 항목 없음", all: "항목 없음", starred: "즐겨찾기한 항목 없음. 기록에서 ☆ 즐겨찾기를 누르면 여기에 모여요." },
    unread: "미확인 ", digest: "다이제스트", inbox: "받은 항목",
    revisits: (count: number) => `다시 볼 항목 ${count}`,
    search: "받은 항목 검색", placeholder: "제목, 내용, 요약, 태그", state: "확인 상태",
    noResults: "검색 결과 없음", clearSearch: "검색 지우기",
  },
});

/** A digest in the inbox, set like a record row: slot title, first headline (else the message headline), "Digest" and counts. No swipe: digests are not archived or deleted. */
export function InboxDigestRow({ summary }: { readonly summary: DigestSummary }) {
  const t = text();
  const { route, open } = useDashboard();
  const unread = digestUnread(summary);
  const headline = summary.headlines[0] ?? summary.messageHeadline;
  const counts = digestCounts(summary);
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    open(summary.id);
  };
  return <li>
    <a id={`row-${summary.id}`} className={`row${unread ? " unread" : ""}`} href={formatRoute({ view: route.view, id: summary.id, params: route.params })}
      aria-current={route.id === summary.id ? "true" : undefined} onClick={onClick}>
      <span className="row-kind-icon kind-digest" aria-hidden="true"><Newspaper size={16} /></span>
      <span className="row-main">
        <span className="row-top">
          <span className="row-title">{unread && <span className="unread-dot" aria-hidden="true" />}{unread && <span className="visually-hidden">{t.unread}</span>}{slotTitle(summary.slot)}</span>
          <Time value={summary.scheduledAt} />
        </span>
        {headline && <span className="row-summary">{headline}</span>}
        <span className="row-meta">
          <span><span className="row-kind">{t.digest}</span>{counts && ` · ${counts}`}</span>
        </span>
      </span>
    </a>
  </li>;
}

export function InboxPane() {
  const t = text();
  const { records, route, setParams, digests, digestReads } = useDashboard();
  const search = useSearch();
  const { q } = search;
  const state = inboxStateOf(route.params);
  const summaries = useMemo(() => (digests?.items ?? []).map(item => withDigestReads(item, digestReads)), [digests, digestReads]);
  // Each chip counts what the search leaves (records and digests), so the numbers match the list.
  const byState = useMemo(() => Object.fromEntries(inboxStates.map(option => [option.id, {
    records: inboxView(records, option.id).filter(record => matchesQuery(record, q)),
    digests: inboxDigestView(summaries, option.id).filter(item => digestMatches(item, q, slotTitle(item.slot))),
  }])), [records, summaries, q]);
  const total = (id: string) => (byState[id]?.records.length ?? 0) + (byState[id]?.digests.length ?? 0);
  const queued = byState[state]?.records ?? [];
  // The same membership the keyboard and the app use: the list, plus the open item while it stays selected.
  const items = useMemo(() => listedFor(route, records), [route, records]);
  const listedDigests = useMemo(() => listedDigestsFor(route, summaries, slotTitle), [route, summaries]);
  const revisits = state === "pending" ? queued.filter(record => revisitDue(record)).length : 0;
  // j/k move through records only; digest rows are reached by pointer or Tab.
  useListShortcuts(items);

  return <>
    <header className="pane-head">
      <div className="pane-title-row"><SidebarOpen />
        <h1 className="pane-title">{t.inbox} <span className="count">{total(state)}</span></h1>
      </div>
      {revisits > 0 && <p className="pane-note">{t.revisits(revisits)}</p>}
      <div className="pane-toolbar">
        <SearchField search={search} label={t.search} placeholder={t.placeholder} />
        <div className="chip-row" role="group" aria-label={t.state}>
          {inboxStates.map(option => <Chip key={option.id} selected={state === option.id} count={total(option.id)}
            onClick={() => setParams({ state: option.id === "all" ? null : option.id }, { replace: true })}>
            {option.label}
          </Chip>)}
        </div>
      </div>
    </header>
    <RecordList grouped kinds records={items} empty={q ? t.noResults : t.empty[state]}
      extra={listedDigests.map(summary => ({ id: summary.id, at: summary.scheduledAt, row: <InboxDigestRow key={summary.id} summary={summary} /> }))}
      emptyAction={q ? <button type="button" className="btn btn-outline" onClick={() => search.clear({ q: null })}>{t.clearSearch}</button> : undefined} />
  </>;
}
