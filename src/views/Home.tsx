import { useEffect, useMemo } from "react";
import type { ReactNode } from "react";
import { ChevronRight, Headphones, Pause, Play, Plus } from "lucide-react";
import type { DashboardRecord } from "../../shared/contracts";
import { clock, usePlayback } from "../components/playback";
import { SidebarOpen, Time } from "../components/primitives";
import { config } from "../config";
import { channelLabel, channelOf, foldContinuations, inboxItems, isRecord, kindLabels, lastActivity, libraryView, localDate, taskStatuses } from "../model";
import { strings } from "../i18n";
import { formatRoute, viewTitles } from "../router";
import { useDashboard } from "../state";
import { DigestRow } from "./Digest";

const text = strings({
  en: {
    digest: "Latest digest", noDigest: "No digests yet", allDigests: "All digests",
    records: "Recent records", toReview: (count: number) => `${count} to review`, seeAll: "See all", noRecords: "No records yet",
    listen: "Continue listening", play: "Play", pause: "Pause", tasks: "Tasks", compose: "New item",
  },
  ko: {
    digest: "최신 다이제스트", noDigest: "아직 온 다이제스트 없음", allDigests: "다이제스트 모두 보기",
    records: "최근 기록", toReview: (count: number) => `미확인 ${count}`, seeAll: "모두 보기", noRecords: "아직 기록 없음",
    listen: "이어 듣기", play: "재생", pause: "일시정지", tasks: "할 일", compose: "새로 저장",
  },
});

/** How many rows Recent records and Tasks show before their See all link. */
const SHOWN = 5;
/** How many of the newest digests 최신 브리핑 shows (this morning's and the one before it). */
const DIGESTS_SHOWN = 2;

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

/**
 * Home, the first screen, with no day boundary (a day brings few records): the two latest digests (when digests are on),
 * the newest records, the playback going on and the open tasks, those waiting for review first.
 */
export function HomePane() {
  const t = text();
  const { records, comments, digests, digestReads, compose } = useDashboard();
  const today = localDate();
  const recent = useMemo(() => foldContinuations(libraryView(records, "all", today)).slice(0, SHOWN).map(entry => entry.item), [records, today]);
  const pendingCount = useMemo(() => inboxItems(records, today).length, [records, today]);
  const tasks = useMemo(() => records
    .filter(record => record.kind === "task" && !record.archivedAt && record.status !== "done" && record.status !== "paused")
    .map(record => ({ record, review: record.status === "review", at: lastActivity(record, comments) }))
    .sort((a, b) => Number(b.review) - Number(a.review) || b.at.localeCompare(a.at))
    .map(entry => entry.record), [records, comments]);
  // The App's per-part read overlay (`<id>:<part>`) wins over the loaded summaries, as in the Digest list.
  const latest = (digests?.items ?? []).slice(0, DIGESTS_SHOWN).map(item => ({
    ...item,
    ...(digestReads.has(`${item.id}:articles`) ? { articlesReadAt: digestReads.get(`${item.id}:articles`) ?? null } : {}),
    ...(digestReads.has(`${item.id}:messages`) ? { messagesReadAt: digestReads.get(`${item.id}:messages`) ?? null } : {}),
  }));
  const library = (params: Readonly<Record<string, string>>) => formatRoute({ view: "library", id: null, params });

  return <div className="today-page">
    <header className="pane-head">
      <div className="pane-title-row"><SidebarOpen /><h1 className="pane-title">{viewTitles.home}</h1></div>
    </header>
    {config.features.digest && <Section id="today-digest" title={t.digest}
      aside={<a className="today-more" href={formatRoute({ view: "digest", id: null, params: {} })}>{t.allDigests}<ChevronRight size={14} aria-hidden="true" /></a>}>
      {latest.length ? <ul className="digest-list today-card">{latest.map(summary => <DigestRow key={summary.id} summary={summary} part="all" selected={false}
        href={formatRoute({ view: "digest", id: summary.id, params: {} })} onOpen={() => undefined} />)}</ul>
        : <p className="today-empty">{t.noDigest}</p>}
    </Section>}
    <Section id="today-records" title={t.records}
      aside={recent.length > 0 && <span className="today-links">
        {pendingCount > 0 && <a className="today-more" href={library({ state: "pending" })}>{t.toReview(pendingCount)}</a>}
        <a className="today-more" href={library({})}>{t.seeAll}<ChevronRight size={14} aria-hidden="true" /></a>
      </span>}>
      {recent.length ? <ul className="record-list today-card">{recent.map(record =>
        <Row key={record.id} record={record} href={formatRoute({ view: "library", id: record.id, params: {} })} />)}</ul>
        : <div className="today-empty-row"><p className="today-empty">{t.noRecords}</p>
          <button type="button" className="btn btn-outline today-empty-action" onClick={() => compose()}><Plus size={16} aria-hidden="true" />{t.compose}</button>
        </div>}
    </Section>
    <Listening />
    {tasks.length > 0 && <Section id="today-tasks" title={t.tasks}
      aside={<a className="today-more" href={formatRoute({ view: "work", id: null, params: {} })}>{t.seeAll}<ChevronRight size={14} aria-hidden="true" /></a>}>
      <ul className="record-list today-card">{tasks.slice(0, SHOWN).map(record => <Row key={record.id} record={record} href={formatRoute({ view: "work", id: record.id, params: {} })} />)}</ul>
    </Section>}
  </div>;
}
