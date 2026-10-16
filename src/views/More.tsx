import { Bell, BriefcaseBusiness, ChevronRight, RadioTower, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { TRASH_RETENTION_DAYS } from "../../shared/contracts";
import { SidebarOpen } from "../components/primitives";
import { channelKeys } from "../model";
import { strings } from "../i18n";
import { formatRoute } from "../router";
import { useDashboard } from "../state";

const text = strings({
  en: {
    title: "More", work: "Work", tasks: "Tasks", tasksNote: "Shared with agents · tasks to check also show on Today",
    tidy: "Clean up", trash: "Trash", trashNote: (days: number) => `Deleted items are kept for ${days} days`,
    channels: "Connections", manage: "Manage channels", manageNote: (count: number) => `${count} connected · Import JSON · Sign out`,
    app: "App", settings: "Settings", settingsNote: "Language · Voice · Notifications",
  },
  ko: {
    title: "더보기", work: "일", tasks: "할 일", tasksNote: "에이전트와 함께 보는 일 · 확인할 일은 오늘에도 떠요",
    tidy: "정리", trash: "휴지통", trashNote: (days: number) => `삭제한 항목은 ${days}일 동안 보관`,
    channels: "연결", manage: "채널 관리", manageNote: (count: number) => `${count}개 연결 · JSON 가져오기 · 로그아웃`,
    app: "앱", settings: "설정", settingsNote: "언어 · 음성 · 알림",
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

function Group({ id, title, children }: { readonly id: string; readonly title: string; readonly children: ReactNode }) {
  return <section className="more-group" aria-labelledby={id}>
    <h2 id={id} className="more-heading">{title}</h2>
    <ul className="more-list">{children}</ul>
  </section>;
}

/** More: every screen that is not a tab, in the groups and order of the desktop sidebar (work, clean up, connections, app). */
export function MorePane() {
  const t = text();
  const { records, trash } = useDashboard();
  const open = records.filter(record => record.kind === "task" && !record.archivedAt && record.status !== "done").length;
  const link = (view: "work" | "trash" | "channels" | "settings") => formatRoute({ view, id: null, params: {} });

  return <div className="more-page">
    <header className="pane-head">
      <div className="pane-title-row"><SidebarOpen /><h1 className="pane-title">{t.title}</h1></div>
    </header>
    <Group id="more-work" title={t.work}>
      <Item href={link("work")} icon={<BriefcaseBusiness size={18} aria-hidden="true" />} label={t.tasks} note={t.tasksNote} count={open} />
    </Group>
    <Group id="more-tidy" title={t.tidy}>
      <Item href={link("trash")} icon={<Trash2 size={18} aria-hidden="true" />} label={t.trash} note={t.trashNote(TRASH_RETENTION_DAYS)} count={trash.length} />
    </Group>
    <Group id="more-channels" title={t.channels}>
      <Item href={link("channels")} icon={<RadioTower size={18} aria-hidden="true" />} label={t.manage} note={t.manageNote(channelKeys.length)} />
    </Group>
    <Group id="more-app" title={t.app}>
      <Item href={link("settings")} icon={<Bell size={18} aria-hidden="true" />} label={t.settings} note={t.settingsNote} />
    </Group>
  </div>;
}
