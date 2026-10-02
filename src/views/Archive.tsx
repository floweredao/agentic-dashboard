import { useMemo } from "react";
import { RecordList } from "../components/RecordList";
import { BackButton } from "../components/primitives";
import { useListShortcuts } from "../hooks";
import { archivedItems } from "../model";
import { useDashboard } from "../state";

export function ArchivePane() {
  const { records } = useDashboard();
  const items = useMemo(() => archivedItems(records), [records]);
  useListShortcuts(items);

  return <>
    <header className="pane-head">
      <BackButton place="list" />
      <div className="pane-title-row">
        <h1 className="pane-title">보관함 <span className="count">{items.length}</span></h1>
      </div>
    </header>
    <RecordList records={items} empty="보관한 항목 없음" />
  </>;
}
