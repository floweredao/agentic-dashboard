import { ArchiveRestore, Trash2 } from "lucide-react";
import { TRASH_RETENTION_DAYS } from "../../shared/contracts";
import { BackButton, Empty } from "../components/primitives";
import { channelOf, channelLabel, kindLabels } from "../model";
import { useDashboard } from "../state";

const day = 86_400_000;
/** Days left before the purge, rounded up; on the purge day itself it reads 오늘. */
export function purgeLabel(purgeAt: string, now = Date.now()) {
  const days = Math.max(0, Math.ceil((new Date(purgeAt).getTime() - now) / day));
  return days === 0 ? "오늘 영구 삭제" : `${days}일 뒤 영구 삭제`;
}

/** `now` is injectable so tests can pin the purge countdown. */
export function TrashPane({ now = Date.now() }: { readonly now?: number }) {
  const { trash, busy, restore, purge, emptyTrash } = useDashboard();
  const items = [...trash].sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));

  return <div className="trash-page">
    <header className="trash-head">
      <BackButton place="list" />
      <div className="pane-title-row">
        <h1 className="pane-title">휴지통 <span className="count">{items.length}</span></h1>
        <button type="button" className="btn btn-quiet btn-danger trash-empty" onClick={() => { void emptyTrash(); }} disabled={busy || items.length === 0}>
          휴지통 비우기
        </button>
      </div>
      <p className="pane-note">삭제한 항목은 {TRASH_RETENTION_DAYS}일 동안 보관한 뒤 영구 삭제돼요.</p>
    </header>
    {items.length === 0
      ? <Empty icon={<Trash2 size={20} aria-hidden="true" />}>휴지통이 비어 있음</Empty>
      : <ul className="trash-list">{items.map(item => <li key={item.record.id} className="trash-item">
        <div className="trash-main">
          <span className="trash-title">{item.record.title}</span>
          <span className="trash-meta">{channelLabel(channelOf(item.record))} · {kindLabels[item.record.kind]} · <span className="trash-purge-at">{purgeLabel(item.purgeAt, now)}</span></span>
        </div>
        <div className="trash-actions">
          <button type="button" className="btn btn-outline" onClick={() => { void restore(item); }} disabled={busy}>
            <ArchiveRestore size={16} aria-hidden="true" />복원
          </button>
          <button type="button" className="icon-btn trash-purge" onClick={() => { void purge(item); }} disabled={busy} aria-label="영구 삭제" title="영구 삭제">
            <Trash2 size={16} aria-hidden="true" />
          </button>
        </div>
      </li>)}</ul>}
  </div>;
}
