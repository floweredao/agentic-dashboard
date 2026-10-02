import { useMemo } from "react";
import { RecordList } from "../components/RecordList";
import { SearchField, useSearch } from "../components/SearchField";
import { ChannelMark, Chip } from "../components/primitives";
import { useListShortcuts } from "../hooks";
import { channelKeys, channelOf, channelLabel, libraryItems } from "../model";
import { useDashboard } from "../state";

const types = [
  { value: "research", label: "조사 보고" },
  { value: "work-report", label: "작업 보고" },
  { value: "social", label: "링크" },
  { value: "note", label: "메모" },
] as const;

export function LibraryPane() {
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
      <div className="pane-title-row">
        <h1 className="pane-title">기록 <span className="count">{items.length}</span></h1>
      </div>
      <div className="pane-toolbar">
        <SearchField search={search} label="기록 검색" placeholder="제목, 내용, 요약, 태그" />
        <div className="chip-row" role="group" aria-label="기록 종류">
          <Chip selected={type === ""} count={anyType.length} onClick={() => setParams({ type: null }, { replace: true })}>전체</Chip>
          {types.map(option => <Chip key={option.value} selected={type === option.value}
            count={anyType.filter(record => record.kind === option.value).length}
            onClick={() => pick("type", option.value, type === option.value)}>
            {option.label}
          </Chip>)}
        </div>
        <div className="chip-row" role="group" aria-label="채널">
          {channelKeys.map(key => {
            const count = anyChannel.filter(record => channelOf(record) === key).length;
            return count > 0 || channel === key
              ? <Chip key={key} selected={channel === key} count={count} onClick={() => pick("channel", key, channel === key)}>
                <ChannelMark channel={key} />{channelLabel(key)}
              </Chip>
              : null;
          })}
        </div>
        <div className="chip-row" role="group" aria-label="기록 상태">
          <Chip selected={starred} onClick={() => pick("starred", "1", starred)}>별표</Chip>
        </div>
      </div>
    </header>
    <RecordList grouped records={items} empty={q ? "검색 결과 없음" : filtered ? "조건에 맞는 기록 없음" : "기록 없음"}
      emptyAction={filtered
        ? <button type="button" className="btn btn-outline" onClick={() => clear({ q: null, type: null, channel: null, starred: null })}>조건 모두 지우기</button>
        : q ? <button type="button" className="btn btn-outline" onClick={() => clear({ q: null })}>검색 지우기</button> : undefined} />
  </>;
}
