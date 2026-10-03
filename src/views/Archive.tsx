import { useMemo } from "react";
import { RecordList } from "../components/RecordList";
import { BackButton, SidebarOpen } from "../components/primitives";
import { useListShortcuts } from "../hooks";
import { archivedItems } from "../model";
import { strings } from "../i18n";
import { useDashboard } from "../state";

const text = strings({
  en: { title: "Archive", empty: "Nothing archived" },
  ko: { title: "보관함", empty: "보관한 항목 없음" },
});

export function ArchivePane() {
  const t = text();
  const { records } = useDashboard();
  const items = useMemo(() => archivedItems(records), [records]);
  useListShortcuts(items);

  return <>
    <header className="pane-head">
      <BackButton place="list" />
      <div className="pane-title-row"><SidebarOpen />
        <h1 className="pane-title">{t.title} <span className="count">{items.length}</span></h1>
      </div>
    </header>
    <RecordList records={items} empty={t.empty} />
  </>;
}
