import { useMemo } from "react";
import { RecordList } from "../components/RecordList";
import { Chip, SidebarOpen } from "../components/primitives";
import { SearchField, useSearch } from "../components/SearchField";
import { useListShortcuts } from "../hooks";
import { inboxStateOf, inboxStates, inboxView, listedFor, matchesQuery, revisitDue } from "../model";
import { strings } from "../i18n";
import { useDashboard } from "../state";

const text = strings({
  en: {
    empty: { pending: "Nothing to review", approved: "Nothing reviewed yet", all: "No items", starred: "No favorites yet. Tap ☆ Favorite on a record to collect it here." },
    inbox: "Inbox",
    revisits: (count: number) => `${count} to revisit`,
    search: "Search inbox", placeholder: "Title, content, summary, tags", state: "Review status",
    noResults: "No results", clearSearch: "Clear search",
  },
  ko: {
    empty: { pending: "확인할 항목 없음", approved: "확인한 항목 없음", all: "항목 없음", starred: "즐겨찾기한 항목 없음. 기록에서 ☆ 즐겨찾기를 누르면 여기에 모여요." },
    inbox: "받은 항목",
    revisits: (count: number) => `다시 볼 항목 ${count}`,
    search: "받은 항목 검색", placeholder: "제목, 내용, 요약, 태그", state: "확인 상태",
    noResults: "검색 결과 없음", clearSearch: "검색 지우기",
  },
});

export function InboxPane() {
  const t = text();
  const { records, route, setParams } = useDashboard();
  const search = useSearch();
  const { q } = search;
  const state = inboxStateOf(route.params);
  // Each chip counts what the search leaves, so the numbers match the list. Digests live in the Digest tab only.
  const byState = useMemo(() => Object.fromEntries(inboxStates.map(option => [option.id,
    inboxView(records, option.id).filter(record => matchesQuery(record, q))])), [records, q]);
  const total = (id: string) => byState[id]?.length ?? 0;
  const queued = byState[state] ?? [];
  // The same membership the keyboard and the app use: the list, plus the open item while it stays selected.
  const items = useMemo(() => listedFor(route, records), [route, records]);
  const revisits = state === "pending" ? queued.filter(record => revisitDue(record)).length : 0;
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
      emptyAction={q ? <button type="button" className="btn btn-outline" onClick={() => search.clear({ q: null })}>{t.clearSearch}</button> : undefined} />
  </>;
}
