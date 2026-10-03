import { Archive, Bell, ChevronRight, RadioTower, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { TRASH_RETENTION_DAYS } from "../../shared/contracts";
import { ChannelMark, SidebarOpen } from "../components/primitives";
import { channelKeys, channelOf, channelLabel, isRecord } from "../model";
import { strings } from "../i18n";
import { formatRoute } from "../router";
import { useDashboard } from "../state";

const text = strings({
  en: {
    title: "More", keep: "Keep", archive: "Archive", trash: "Trash",
    trashNote: (days: number) => `Deleted items are kept for ${days} days`,
    channels: "Channels", manage: "Manage channels", manageNote: "Status by channel · Import JSON · Sign out",
    records: (channel: string) => `${channel} records`,
    settings: "Settings", notifications: "Language and notifications", notificationsNote: "Language · Digests · Needs review · Replies · Test",
  },
  ko: {
    title: "더보기", keep: "보관", archive: "보관함", trash: "휴지통",
    trashNote: (days: number) => `삭제한 항목은 ${days}일 동안 보관`,
    channels: "채널", manage: "채널 관리", manageNote: "채널별 현황 · JSON 가져오기 · 로그아웃",
    records: (channel: string) => `${channel} 기록`,
    settings: "설정", notifications: "언어와 알림", notificationsNote: "언어 · 다이제스트 · 확인 필요 · 답글 · 테스트",
  },
});

function Item({ href, icon, label, note, count }: {
  readonly href: string; readonly icon: ReactNode; readonly label: string; readonly note?: string; readonly count?: number;
}) {
  return <li><a className="more-item" href={href}>
    <span className="more-icon">{icon}</span>
    <span className="more-text"><span className="more-label">{label}</span>{note && <span className="more-note">{note}</span>}</span>
    {count !== undefined && <span className="count">{count}</span>}
    <ChevronRight size={16} className="more-chevron" aria-hidden="true" />
  </a></li>;
}

/** More: every screen that is not a tab, in the groups and order of the desktop sidebar (keep, channels). */
export function MorePane() {
  const t = text();
  const { records, trash } = useDashboard();
  const live = records.filter(record => isRecord(record) && record.archivedAt === null);
  const archived = records.filter(record => record.archivedAt !== null).length;
  const link = (view: "archive" | "trash" | "channels" | "settings") => formatRoute({ view, id: null, params: {} });

  return <div className="more-page">
    <header className="pane-head">
      <div className="pane-title-row"><SidebarOpen /><h1 className="pane-title">{t.title}</h1></div>
    </header>
    <section className="more-group" aria-labelledby="more-keep">
      <h2 id="more-keep" className="more-heading">{t.keep}</h2>
      <ul className="more-list">
        <Item href={link("archive")} icon={<Archive size={18} aria-hidden="true" />} label={t.archive} count={archived} />
        <Item href={link("trash")} icon={<Trash2 size={18} aria-hidden="true" />} label={t.trash} note={t.trashNote(TRASH_RETENTION_DAYS)} count={trash.length} />
      </ul>
    </section>
    <section className="more-group" aria-labelledby="more-channels">
      <h2 id="more-channels" className="more-heading">{t.channels}</h2>
      <ul className="more-list">
        <Item href={link("channels")} icon={<RadioTower size={18} aria-hidden="true" />} label={t.manage} note={t.manageNote} />
        {channelKeys.map(channel => <Item key={channel} href={formatRoute({ view: "library", id: null, params: { channel } })}
          icon={<ChannelMark channel={channel} size="tile" />} label={t.records(channelLabel(channel))}
          count={live.filter(record => channelOf(record) === channel).length} />)}
      </ul>
    </section>
    <section className="more-group" aria-labelledby="more-settings">
      <h2 id="more-settings" className="more-heading">{t.settings}</h2>
      <ul className="more-list">
        <Item href={link("settings")} icon={<Bell size={18} aria-hidden="true" />} label={t.notifications} note={t.notificationsNote} />
      </ul>
    </section>
  </div>;
}
