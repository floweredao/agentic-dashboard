import { useMemo } from "react";
import { RecordList } from "../components/RecordList";
import { SearchField, useSearch } from "../components/SearchField";
import { ChannelMark, Chip, SidebarOpen } from "../components/primitives";
import { useListShortcuts } from "../hooks";
import { channelKeys, channelOf, channelLabel, libraryItems } from "../model";
import { strings } from "../i18n";
import { useDashboard } from "../state";

const text = strings({
  en: {
    types: { research: "Research", "work-report": "Work report", social: "Link", note: "Note" },
    title: "Library", search: "Search library", placeholder: "Title, content, summary, tags",
    kind: "Record type", all: "All", channel: "Channel", status: "Record status", starred: "Starred",
    noResults: "No results", noMatches: "No records match", none: "No records",
    clearAll: "Clear all filters", clearSearch: "Clear search",
  },
  ko: {
    types: { research: "조사 보고", "work-report": "작업 보고", social: "링크", note: "메모" },
    title: "기록", search: "기록 검색", placeholder: "제목, 내용, 요약, 태그",
    kind: "기록 종류", all: "전체", channel: "채널", status: "기록 상태", starred: "별표",
    noResults: "검색 결과 없음", noMatches: "조건에 맞는 기록 없음", none: "기록 없음",
    clearAll: "조건 모두 지우기", clearSearch: "검색 지우기",
  },
});
const typeValues = ["research", "work-report", "social", "note"] as const;

export function LibraryPane() {
  const t = text();
  const { records, route, setParams } = useDashboard();
  const type = route.params.type ?? "";
  const channel = route.params.channel ?? "";
  const starred = route.params.starred === "1";
  const search = useSearch();
  const { q, clear } = search;
  // Each chip group counts what the other conditions (search included) leave, so numbers match the list.
  const anyType = useMemo(() => libraryItems(records, { channel, starred, q }), [records, channel, starred, q]);
  const anyChannel = useMemo(() => libraryItems(records, { type, starred, q }), [records, type, starred, q]);
  const items = useMemo(() => anyType.filter(record => !type || record.kind === type), [anyType, type]);
  const filtered = type !== "" || channel !== "" || starred;
  useListShortcuts(items);

  const pick = (key: string, value: string, selected: boolean) =>
    setParams({ [key]: selected ? null : value }, { replace: true });

  return <>
    <header className="pane-head">
      <div className="pane-title-row"><SidebarOpen />
        <h1 className="pane-title">{t.title} <span className="count">{items.length}</span></h1>
      </div>
      <div className="pane-toolbar">
        <SearchField search={search} label={t.search} placeholder={t.placeholder} />
        <div className="chip-row" role="group" aria-label={t.kind}>
          <Chip selected={type === ""} count={anyType.length} onClick={() => setParams({ type: null }, { replace: true })}>{t.all}</Chip>
          {typeValues.map(value => <Chip key={value} selected={type === value}
            count={anyType.filter(record => record.kind === value).length}
            onClick={() => pick("type", value, type === value)}>
            {t.types[value]}
          </Chip>)}
        </div>
        <div className="chip-row" role="group" aria-label={t.channel}>
          {channelKeys.map(key => {
            const count = anyChannel.filter(record => channelOf(record) === key).length;
            return count > 0 || channel === key
              ? <Chip key={key} selected={channel === key} count={count} onClick={() => pick("channel", key, channel === key)}>
                <ChannelMark channel={key} />{channelLabel(key)}
              </Chip>
              : null;
          })}
        </div>
        <div className="chip-row" role="group" aria-label={t.status}>
          <Chip selected={starred} onClick={() => pick("starred", "1", starred)}>{t.starred}</Chip>
        </div>
      </div>
    </header>
    <RecordList grouped records={items} empty={q ? t.noResults : filtered ? t.noMatches : t.none}
      emptyAction={filtered
        ? <button type="button" className="btn btn-outline" onClick={() => clear({ q: null, type: null, channel: null, starred: null })}>{t.clearAll}</button>
        : q ? <button type="button" className="btn btn-outline" onClick={() => clear({ q: null })}>{t.clearSearch}</button> : undefined} />
  </>;
}
