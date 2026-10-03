import { ArchiveRestore, Trash2 } from "lucide-react";
import { TRASH_RETENTION_DAYS } from "../../shared/contracts";
import { BackButton, Empty, SidebarOpen } from "../components/primitives";
import { channelOf, channelLabel, kindLabels } from "../model";
import { strings } from "../i18n";
import { useDashboard } from "../state";

const text = strings({
  en: {
    purgeToday: "Deleted permanently today",
    purgeIn: (days: number) => `Deleted permanently in ${days} ${days === 1 ? "day" : "days"}`,
    title: "Trash", emptyTrash: "Empty trash",
    note: (days: number) => `Deleted items are kept for ${days} days, then removed permanently.`,
    empty: "Trash is empty", restore: "Restore", purge: "Delete permanently",
  },
  ko: {
    purgeToday: "오늘 영구 삭제",
    purgeIn: (days: number) => `${days}일 뒤 영구 삭제`,
    title: "휴지통", emptyTrash: "휴지통 비우기",
    note: (days: number) => `삭제한 항목은 ${days}일 동안 보관한 뒤 영구 삭제돼요.`,
    empty: "휴지통이 비어 있음", restore: "복원", purge: "영구 삭제",
  },
});

const day = 86_400_000;
/** Days left before the purge, rounded up; on the purge day itself it reads "today". */
export function purgeLabel(purgeAt: string, now = Date.now()) {
  const days = Math.max(0, Math.ceil((new Date(purgeAt).getTime() - now) / day));
  return days === 0 ? text().purgeToday : text().purgeIn(days);
}

/** `now` is injectable so tests can pin the purge countdown. */
export function TrashPane({ now = Date.now() }: { readonly now?: number }) {
  const t = text();
  const { trash, busy, restore, purge, emptyTrash } = useDashboard();
  const items = [...trash].sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));

  return <div className="trash-page">
    <header className="trash-head">
      <BackButton place="list" />
      <div className="pane-title-row"><SidebarOpen />
        <h1 className="pane-title">{t.title} <span className="count">{items.length}</span></h1>
        <button type="button" className="btn btn-quiet btn-danger trash-empty" onClick={() => { void emptyTrash(); }} disabled={busy || items.length === 0}>
          {t.emptyTrash}
        </button>
      </div>
      <p className="pane-note">{t.note(TRASH_RETENTION_DAYS)}</p>
    </header>
    {items.length === 0
      ? <Empty icon={<Trash2 size={20} aria-hidden="true" />}>{t.empty}</Empty>
      : <ul className="trash-list">{items.map(item => <li key={item.record.id} className="trash-item">
        <div className="trash-main">
          <span className="trash-title">{item.record.title}</span>
          <span className="trash-meta">{channelLabel(channelOf(item.record))} · {kindLabels[item.record.kind]} · <span className="trash-purge-at">{purgeLabel(item.purgeAt, now)}</span></span>
        </div>
        <div className="trash-actions">
          <button type="button" className="btn btn-outline" onClick={() => { void restore(item); }} disabled={busy}>
            <ArchiveRestore size={16} aria-hidden="true" />{t.restore}
          </button>
          <button type="button" className="icon-btn trash-purge" onClick={() => { void purge(item); }} disabled={busy} aria-label={t.purge} title={t.purge}>
            <Trash2 size={16} aria-hidden="true" />
          </button>
        </div>
      </li>)}</ul>}
  </div>;
}
