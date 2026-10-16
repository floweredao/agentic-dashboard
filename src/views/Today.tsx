import { useEffect, useMemo } from "react";
import type { ReactNode } from "react";
import { ChevronRight, Headphones, Pause, Play } from "lucide-react";
import type { DashboardRecord } from "../../shared/contracts";
import { clock, usePlayback } from "../components/playback";
import { SidebarOpen, Time } from "../components/primitives";
import { config } from "../config";
import { channelLabel, channelOf, inboxItems, inQueue, isRecord, kindLabels, localDate, taskStatuses } from "../model";
import { strings } from "../i18n";
import { formatRoute } from "../router";
import { useDashboard } from "../state";
import { DigestRow, dayTitle } from "./Digest";

const text = strings({
  en: {
    digest: "Digest", noDigest: "No digest yet today", allDigests: "All digests", latest: "Latest digest",
    records: "New records", toReview: (count: number) => `${count} to review`, seeAll: "See all", noRecords: "Nothing new to review",
    listen: "Continue listening", play: "Play", pause: "Pause", tasks: "Tasks to check",
  },
  ko: {
    digest: "다이제스트", noDigest: "오늘 온 다이제스트 없음", allDigests: "다이제스트 모두 보기", latest: "가장 최근 다이제스트",
    records: "새 기록", toReview: (count: number) => `미확인 ${count}`, seeAll: "모두 보기", noRecords: "새로 확인할 기록 없음",
    listen: "이어 듣기", play: "재생", pause: "일시정지", tasks: "할 일 · 확인 필요",
  },
});

const NEW_RECORDS = 5;

function Row({ record, href }: { readonly record: DashboardRecord; readonly href: string }) {
  const unread = isRecord(record) && record.reviewState === "pending";
  return <li><a className={`row${unread ? " unread" : ""}`} href={href}>
    <span className="row-main">
      <span className="row-top">
        <span className="row-title">{unread && <span className="unread-dot" aria-hidden="true" />}{record.title}</span>
        <Time value={record.createdAt} />
      </span>
      <span className="row-meta"><span className="row-kind">{isRecord(record)
        ? `${channelLabel(channelOf(record))} · ${kindLabels[record.kind]}`
        : taskStatuses[record.status as keyof typeof taskStatuses] ?? record.status}</span></span>
    </span>
  </a></li>;
}

function Section({ id, title, aside, children }: {
  readonly id: string; readonly title: string; readonly aside?: ReactNode; readonly children: ReactNode;
}) {
  return <section className="today-section" aria-labelledby={id}>
    <div className="today-heading"><h2 id={id}>{title}</h2>{aside}</div>
    {children}
  </section>;
}

/** Continue listening: the playback going on, as a card in place of the mini player (it registers as the track's player while shown). */
function Listening() {
  const { store, snapshot } = usePlayback();
  const { track, playing, time, duration } = snapshot;
  const t = text();
  useEffect(() => track ? store.mount(track.src) : undefined, [store, track]);
  if (!track) return null;
  const percent = duration > 0 ? Math.min(100, Math.floor((time / duration) * 100)) : 0;
  return <Section id="today-listen" title={t.listen}>
    <div className="today-card today-listen">
      <a className="today-listen-title" href={track.back}><Headphones size={16} aria-hidden="true" /><strong>{track.title}</strong></a>
      <span className="today-progress" aria-hidden="true"><span style={{ transform: `scaleX(${percent / 100})` }} /></span>
      <span className="today-listen-row">
        <span className="today-listen-time">{clock(time)} / {clock(duration)}</span>
        <button type="button" className="listen-play" aria-label={playing ? t.pause : t.play} onClick={() => store.toggle()}>
          {playing ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
        </button>
      </span>
    </div>
  </Section>;
}

/** Today, the first screen: today's digests (when digests are on), the records waiting for review, the playback going on and tasks to check. */
export function TodayPane() {
  const t = text();
  const { records, digests, digestReads } = useDashboard();
  const today = localDate();
  const queue = useMemo(() => inboxItems(records, today), [records, today]);
  const tasks = useMemo(() => records.filter(record => record.kind === "task" && inQueue(record, today)), [records, today]);
  const page = digests?.items ?? [];
  const todays = page.filter(item => item.date === today);
  // The App's per-part read overlay (`<id>:<part>`) wins over the loaded summaries, as in the Digest list.
  const shown = (todays.length ? todays : page.slice(0, 1)).map(item => ({
    ...item,
    ...(digestReads.has(`${item.id}:articles`) ? { articlesReadAt: digestReads.get(`${item.id}:articles`) ?? null } : {}),
    ...(digestReads.has(`${item.id}:messages`) ? { messagesReadAt: digestReads.get(`${item.id}:messages`) ?? null } : {}),
  }));
  const pending = formatRoute({ view: "library", id: null, params: { state: "pending" } });

  return <div className="today-page">
    <header className="pane-head">
      <div className="pane-title-row"><SidebarOpen /><h1 className="pane-title">{dayTitle(today)}</h1></div>
    </header>
    {config.features.digest && <Section id="today-digest" title={todays.length || !shown.length ? t.digest : t.latest}
      aside={<a className="today-more" href={formatRoute({ view: "digest", id: null, params: {} })}>{t.allDigests}<ChevronRight size={14} aria-hidden="true" /></a>}>
      {shown.length ? <ul className="digest-list today-card">{shown.map(summary => <DigestRow key={summary.id} summary={summary} part="all" selected={false}
        href={formatRoute({ view: "digest", id: summary.id, params: {} })} onOpen={() => undefined} />)}</ul>
        : <p className="today-empty">{t.noDigest}</p>}
    </Section>}
    <Section id="today-records" title={t.records}
      aside={queue.length > 0 && <a className="today-more" href={pending}>{t.toReview(queue.length)} · {t.seeAll}<ChevronRight size={14} aria-hidden="true" /></a>}>
      {queue.length ? <ul className="record-list today-card">{queue.slice(0, NEW_RECORDS).map(record =>
        <Row key={record.id} record={record} href={formatRoute({ view: "library", id: record.id, params: { state: "pending" } })} />)}</ul>
        : <p className="today-empty">{t.noRecords}</p>}
    </Section>
    <Listening />
    {tasks.length > 0 && <Section id="today-tasks" title={t.tasks}>
      <ul className="record-list today-card">{tasks.map(record => <Row key={record.id} record={record} href={formatRoute({ view: "work", id: record.id, params: {} })} />)}</ul>
    </Section>}
  </div>;
}
