import { Fragment, useRef } from "react";
import type { MouseEvent, PointerEvent as RowPointerEvent, ReactNode } from "react";
import { Archive, ArchiveRestore, Star, Trash2 } from "lucide-react";
import type { DashboardRecord } from "../../shared/contracts";
import { aiFilled, channelOf, channelLabel, dateLabel, excerpt, groupByDay, hostOf, isRecord, kindLabels, projectStatuses, revisitDue, taskStatuses, waitingReplies } from "../model";
import { formatRoute } from "../router";
import { useDashboard } from "../state";
import { Empty, isSample, Time } from "./primitives";
import { SWIPE_VELOCITY_WINDOW, swipeAxis, swipeDecision, swipeVelocity } from "./swipe";
import type { SwipeAction, SwipeAxis, SwipeSample } from "./swipe";

const plain = (text: string) => text.replace(/[#*_`>|]+/g, " ").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\s+/g, " ").trim().slice(0, 280);
const statusLabel = (record: DashboardRecord) => record.kind === "project"
  ? projectStatuses[record.status as keyof typeof projectStatuses] ?? record.status
  : taskStatuses[record.status as keyof typeof taskStatuses] ?? record.status;

type Gesture = {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly width: number;
  axis: SwipeAxis | null;
  dx: number;
  samples: readonly SwipeSample[];
};
type SwipeState = { gesture: Gesture | null; busy: boolean; suppressClick: boolean };

const isSwipePointer = (event: RowPointerEvent<HTMLLIElement>) => event.isPrimary && (event.pointerType === "touch" || event.pointerType === "pen");

/** Moves the row and resolves when its transform transition ends; at once when it is already there or reduced motion removed the transition. */
function slide(row: HTMLElement, x: number): Promise<void> {
  return new Promise(resolve => {
    const transform = `translateX(${x}px)`;
    if (row.style.transform === transform) { resolve(); return; }
    row.style.transform = transform;
    const seconds = parseFloat(getComputedStyle(row).transitionDuration);
    if (!seconds) { resolve(); return; }
    let timer = 0;
    const done = () => { row.removeEventListener("transitionend", onEnd); window.clearTimeout(timer); resolve(); };
    const onEnd = (event: TransitionEvent) => { if (event.target === row && event.propertyName === "transform") done(); };
    row.addEventListener("transitionend", onEnd);
    timer = window.setTimeout(done, seconds * 1000 + 100);
  });
}

export function RecordRow({ record }: { readonly record: DashboardRecord }) {
  const { route, select, connected, toggleArchive, remove, comments } = useDashboard();
  const waiting = isRecord(record) ? 0 : waitingReplies(comments, record.id);
  const selected = route.id === record.id;
  const unread = isRecord(record) && record.reviewState === "pending";
  const summary = plain(excerpt(record));
  const host = record.kind === "social" ? hostOf(record) : "";
  const rowRef = useRef<HTMLAnchorElement>(null);
  const swipe = useRef<SwipeState>({ gesture: null, busy: false, suppressClick: false });
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    select(record);
  };
  const reveal = (wrapper: HTMLLIElement, dx: number, width: number) => {
    if (dx === 0) delete wrapper.dataset.swipe;
    else wrapper.dataset.swipe = dx > 0 ? "archive" : "delete";
    wrapper.toggleAttribute("data-armed", swipeDecision({ dx, width, velocity: 0 }) !== null);
  };
  const settle = async (wrapper: HTMLLIElement, row: HTMLAnchorElement, decision: SwipeAction | null, width: number) => {
    try {
      wrapper.dataset.phase = "settle";
      wrapper.toggleAttribute("data-armed", decision !== null);
      await slide(row, decision === null ? 0 : decision === "archive" ? width : -width);
      if (decision === "archive") await toggleArchive(record);
      else if (decision === "delete") await remove(record);
    } finally {
      delete wrapper.dataset.phase;
      delete wrapper.dataset.swipe;
      wrapper.removeAttribute("data-armed");
      row.style.transform = "";
      swipe.current.busy = false;
    }
  };
  const onPointerDown = (event: RowPointerEvent<HTMLLIElement>) => {
    const state = swipe.current;
    state.suppressClick = false;
    state.gesture = null;
    const row = rowRef.current;
    if (!connected || state.busy || !row || !isSwipePointer(event)) return;
    state.gesture = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, width: row.offsetWidth, axis: null, dx: 0, samples: [{ t: event.timeStamp, x: event.clientX }] };
  };
  const onPointerMove = (event: RowPointerEvent<HTMLLIElement>) => {
    const gesture = swipe.current.gesture;
    const row = rowRef.current;
    if (!gesture || !row || event.pointerId !== gesture.pointerId || gesture.axis === "vertical") return;
    const dx = event.clientX - gesture.startX;
    if (gesture.axis === null) {
      gesture.axis = swipeAxis(dx, event.clientY - gesture.startY);
      if (gesture.axis !== "horizontal") return;
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.dataset.phase = "drag";
    }
    gesture.dx = Math.max(-gesture.width, Math.min(gesture.width, dx));
    gesture.samples = [...gesture.samples.filter(sample => event.timeStamp - sample.t <= SWIPE_VELOCITY_WINDOW), { t: event.timeStamp, x: event.clientX }];
    row.style.transform = `translateX(${gesture.dx}px)`;
    reveal(event.currentTarget, gesture.dx, gesture.width);
  };
  const release = (event: RowPointerEvent<HTMLLIElement>, cancelled: boolean) => {
    const state = swipe.current;
    const gesture = state.gesture;
    const row = rowRef.current;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    state.gesture = null;
    state.suppressClick = gesture.axis !== null;
    if (gesture.axis !== "horizontal" || !row) return;
    const decision = cancelled ? null : swipeDecision({ dx: gesture.dx, width: gesture.width, velocity: swipeVelocity(gesture.samples, event.timeStamp) });
    state.busy = true;
    void settle(event.currentTarget, row, decision, gesture.width);
  };
  const onClickCapture = (event: MouseEvent<HTMLLIElement>) => {
    if (!swipe.current.suppressClick) return;
    swipe.current.suppressClick = false;
    event.preventDefault();
    event.stopPropagation();
  };
  return <li className="swipe" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={event => release(event, false)}
    onPointerCancel={event => release(event, true)} onClickCapture={onClickCapture}>
    <div className="swipe-actions" aria-hidden="true">
      <span className="swipe-action">{record.archivedAt ? <ArchiveRestore size={18} /> : <Archive size={18} />}{record.archivedAt ? "복원" : "보관"}</span>
      <span className="swipe-action"><Trash2 size={18} />삭제</span>
    </div>
    <a ref={rowRef} id={`row-${record.id}`} className={`row${unread ? " unread" : ""}`} href={formatRoute({ view: route.view, id: record.id, params: route.params })}
      aria-current={selected ? "true" : undefined} onClick={open}>
      <span className="row-main">
        <span className="row-top">
          <span className="row-title">{unread && <span className="unread-dot" aria-hidden="true" />}{unread && <span className="visually-hidden">미확인 </span>}{record.title}</span>
          <Time value={record.createdAt} />
        </span>
        {summary && <span className="row-summary">{summary}</span>}
        <span className="row-meta">
          {isRecord(record) ? <span className="row-kind">{channelLabel(channelOf(record))} · {kindLabels[record.kind]}</span>
            : record.kind === "project" && <span className="row-kind">{kindLabels.project}</span>}
          {!isRecord(record) && <span>{statusLabel(record)}</span>}
          {waiting > 0 && <span className="tag accent">답 대기 {waiting}</span>}
          {revisitDue(record) && <span className="tag">다시 볼 날</span>}
          {record.dueDate && <span>마감 {dateLabel(record.dueDate)}</span>}
          {host && <span className="row-host">{host}</span>}
          {record.fields.starred === true && <Star className="row-star" size={13} aria-label="별표" />}
          {record.archivedAt && <Archive size={13} aria-label="보관됨" />}
          {aiFilled(record) && <span>자동 작성</span>}
          {isSample(record) && <span className="tag">샘플</span>}
        </span>
      </span>
    </a>
  </li>;
}

/** A non-record row merged into a list by its time (`at`, ISO), such as a briefing in 받은 항목. */
export type ExtraRow = { readonly id: string; readonly at: string; readonly row: ReactNode };

/** Rows with optional sticky Seoul-day headers. Rows carry `id="row-<id>"` for keyboard selection. `extra` rows merge in newest first. */
export function RecordList({ records, empty, emptyAction, grouped = false, extra = [] }: {
  readonly records: readonly DashboardRecord[]; readonly empty: string; readonly emptyAction?: ReactNode; readonly grouped?: boolean;
  readonly extra?: readonly ExtraRow[];
}) {
  if (!records.length && !extra.length) return <Empty action={emptyAction}>{empty}</Empty>;
  const rows: readonly ExtraRow[] = extra.length
    ? [...records.map(record => ({ id: record.id, at: record.createdAt, row: <RecordRow key={record.id} record={record} /> })), ...extra]
      .sort((a, b) => b.at.localeCompare(a.at))
    : records.map(record => ({ id: record.id, at: record.createdAt, row: <RecordRow key={record.id} record={record} /> }));
  if (!grouped) return <ul className="record-list">{rows.map(item => <Fragment key={item.id}>{item.row}</Fragment>)}</ul>;
  return <div className="record-groups">{groupByDay(rows.map(item => ({ ...item, createdAt: item.at }))).map(group => <section key={group.label} className="day-group" aria-label={group.label}>
    <h2 className="day-label">{group.label}</h2>
    <ul className="record-list">{group.items.map(item => <Fragment key={item.id}>{item.row}</Fragment>)}</ul>
  </section>)}</div>;
}
