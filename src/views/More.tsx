import { Archive, Bell, ChevronRight, RadioTower, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { TRASH_RETENTION_DAYS } from "../../shared/contracts";
import { ChannelMark } from "../components/primitives";
import { channelKeys, channelOf, channelLabel, isRecord } from "../model";
import { formatRoute } from "../router";
import { useDashboard } from "../state";

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

/** 더보기: every screen that is not a tab, in the groups and order of the desktop sidebar (보관, 채널). */
export function MorePane() {
  const { records, trash } = useDashboard();
  const live = records.filter(record => isRecord(record) && record.archivedAt === null);
  const archived = records.filter(record => record.archivedAt !== null).length;
  const link = (view: "archive" | "trash" | "channels" | "settings") => formatRoute({ view, id: null, params: {} });

  return <div className="more-page">
    <header className="pane-head">
      <div className="pane-title-row"><h1 className="pane-title">더보기</h1></div>
    </header>
    <section className="more-group" aria-labelledby="more-keep">
      <h2 id="more-keep" className="more-heading">보관</h2>
      <ul className="more-list">
        <Item href={link("archive")} icon={<Archive size={18} aria-hidden="true" />} label="보관함" count={archived} />
        <Item href={link("trash")} icon={<Trash2 size={18} aria-hidden="true" />} label="휴지통" note={`삭제한 항목은 ${TRASH_RETENTION_DAYS}일 동안 보관`} count={trash.length} />
      </ul>
    </section>
    <section className="more-group" aria-labelledby="more-channels">
      <h2 id="more-channels" className="more-heading">채널</h2>
      <ul className="more-list">
        <Item href={link("channels")} icon={<RadioTower size={18} aria-hidden="true" />} label="채널 관리" note="채널별 현황 · JSON 가져오기 · 로그아웃" />
        {channelKeys.map(channel => <Item key={channel} href={formatRoute({ view: "library", id: null, params: { channel } })}
          icon={<ChannelMark channel={channel} size="tile" />} label={`${channelLabel(channel)} 기록`}
          count={live.filter(record => channelOf(record) === channel).length} />)}
      </ul>
    </section>
    <section className="more-group" aria-labelledby="more-settings">
      <h2 id="more-settings" className="more-heading">설정</h2>
      <ul className="more-list">
        <Item href={link("settings")} icon={<Bell size={18} aria-hidden="true" />} label="알림 설정" note="브리핑 · 확인 필요 · 답글 · 테스트" />
      </ul>
    </section>
  </div>;
}
