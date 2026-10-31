import { useMemo, useState } from "react";
import { RecordList } from "../components/RecordList";
import { SearchField, useSearch } from "../components/SearchField";
import { Chip, SidebarOpen } from "../components/primitives";
import { useListShortcuts } from "../hooks";
import { libraryStateOf, libraryStates, libraryView, listedFor, matchesQuery, revisitDue } from "../model";
import { strings } from "../i18n";
import { useDashboard } from "../state";

const text = strings({
  en: {
    more: (count: number) => `Show ${count} more`, shown: (count: number, total: number) => `${count} of ${total} records shown`,
    title: "Library", search: "Search library", placeholder: "Title, content, summary, tags", state: "Record status",
    empty: { all: "No records", pending: "Nothing to review", starred: "No favorites yet. Tap ☆ Favorite on a record to collect it here.", archived: "Nothing archived" },
    revisits: (count: number) => `${count} to revisit`, noResults: "No results", clearSearch: "Clear search",
  },
  ko: {
    more: (count: number) => `${count}개 더 보기`, shown: (count: number, total: number) => `${total}개 중 ${count}개 표시`,
    title: "기록", search: "기록 검색", placeholder: "제목, 내용, 요약, 태그", state: "기록 상태",
    empty: { all: "기록 없음", pending: "확인할 기록 없음", starred: "즐겨찾기한 기록 없음. 기록에서 ☆ 즐겨찾기를 누르면 여기에 모여요.", archived: "보관한 항목 없음" },
    revisits: (count: number) => `다시 볼 기록 ${count}`, noResults: "검색 결과 없음", clearSearch: "검색 지우기",
  },
});

/** The Library: every saved record in one list, filtered by state (All · To review · Favorites · Archived) and the search. */
export function LibraryPane() {
  const t = text();
  const { records, route, setParams } = useDashboard();
  const search = useSearch();
  const { q } = search;
  const state = libraryStateOf(route.params);
  // Each chip counts what the search leaves, so the numbers match the list.
  const byState = useMemo(() => Object.fromEntries(libraryStates.map(option => [option.id,
    libraryView(records, option.id).filter(record => matchesQuery(record, q))])), [records, q]);
  const total = (id: string) => byState[id]?.length ?? 0;
  // The same membership the keyboard and the app use: the list, plus the open item while it stays selected.
  const items = useMemo(() => listedFor(route, records), [route, records]);
  const filter = `${state}:${q}`;
  const [page, setPage] = useState({ filter, limit: 50 });
  const limit = page.filter === filter ? page.limit : 50;
  const batch = items.slice(0, limit);
  const selected = items.find(record => record.id === route.id);
  const visible = selected && !batch.some(record => record.id === selected.id) ? [...batch, selected] : batch;
  const revisits = state === "pending" ? (byState.pending ?? []).filter(record => revisitDue(record)).length : 0;
  useListShortcuts(visible);

  return <>
    <header className="pane-head">
      <div className="pane-title-row"><SidebarOpen />
        <h1 className="pane-title">{t.title} <span className="count">{total(state)}</span></h1>
      </div>
      {revisits > 0 && <p className="pane-note">{t.revisits(revisits)}</p>}
      <div className="pane-toolbar">
        <SearchField search={search} label={t.search} placeholder={t.placeholder} />
        <div className="chip-row" role="group" aria-label={t.state}>
          {libraryStates.map(option => <Chip key={option.id} selected={state === option.id} count={total(option.id)}
            onClick={() => setParams({ state: option.id === "all" ? null : option.id }, { replace: true })}>
            {option.label}
          </Chip>)}
        </div>
      </div>
    </header>
    <RecordList grouped={state !== "archived"} kinds={state === "archived"} fold={state === "all" && !q} records={visible}
      empty={q ? t.noResults : t.empty[state]}
      emptyAction={q ? <button type="button" className="btn btn-outline" onClick={() => search.clear({ q: null })}>{t.clearSearch}</button> : undefined} />
    {limit < items.length && <footer className="account-stack list-page-action">
      <p className="setting-note">{t.shown(visible.length, items.length)}</p>
      <button className="btn btn-outline" onClick={() => setPage({ filter, limit: limit + 50 })}>{t.more(Math.min(50, items.length - limit))}</button>
    </footer>}
  </>;
}
