import { Fragment, useRef, useState } from "react";
import type { MouseEvent, PointerEvent as RowPointerEvent, ReactNode } from "react";
import { Archive, ArchiveRestore, BriefcaseBusiness, ChevronDown, Library, Star, Trash2 } from "lucide-react";
import type { DashboardRecord } from "../../shared/contracts";
import { aiFilled, channelOf, channelLabel, dateLabel, excerpt, foldContinuations, groupByDay, hostOf, isRecord, kindLabels, projectStatuses, revisitDue, taskStatuses, waitingReplies } from "../model";
import { strings } from "../i18n";
import { formatRoute } from "../router";
import { useDashboard } from "../state";
import { Empty, isSample, Time } from "./primitives";
import { SIDEBAR_EDGE } from "./sidebar";
import { SWIPE_VELOCITY_WINDOW, swipeAxis, swipeDecision, swipeVelocity } from "./swipe";
import type { SwipeAction, SwipeAxis, SwipeSample } from "./swipe";

const text = strings({
  en: {
    restore: "Restore", archive: "Archive", delete: "Delete", unread: "Unread ",
    waiting: "Awaiting reply", revisit: "Revisit", due: "Due", starred: "Favorite", archived: "Archived", aiFilled: "Auto-filled", sample: "Sample",
    thread: (count: number) => `${count} earlier ${count === 1 ? "record" : "records"}`,
  },
  ko: {
    restore: "복원", archive: "보관", delete: "삭제", unread: "미확인 ",
    waiting: "답 대기", revisit: "다시 볼 날", due: "마감", starred: "즐겨찾기", archived: "보관됨", aiFilled: "자동 작성", sample: "샘플",
    thread: (count: number) => `이어진 기록 ${count}`,
  },
});

// At most 280 UTF-16 units, dropping the first half of an emoji the cut would split.
const plain = (text: string) => text.replace(/[#*_`>|]+/g, " ").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\s+/g, " ").trim().slice(0, 280).replace(/[\uD800-\uDBFF]$/, "");
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

/** `kinds`: lead the row with the tile of the tab it belongs to (Library for records, Tasks for tasks and projects), as the inbox mixes them. */
export function RecordRow({ record, kinds = false }: { readonly record: DashboardRecord; readonly kinds?: boolean }) {
  const t = text();
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
    // Another finger landing mid-swipe leaves the swipe to the finger that started it: its pointer is captured, so its up or cancel still comes here.
    if (state.gesture?.axis === "horizontal" && event.pointerId !== state.gesture.pointerId) return;
    state.suppressClick = false;
    state.gesture = null;
    const row = rowRef.current;
    if (!connected || state.busy || !row || !isSwipePointer(event) || event.clientX <= SIDEBAR_EDGE) return;
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
      <span className="swipe-action">{record.archivedAt ? <ArchiveRestore size={18} /> : <Archive size={18} />}{record.archivedAt ? t.restore : t.archive}</span>
      <span className="swipe-action"><Trash2 size={18} />{t.delete}</span>
    </div>
    <a ref={rowRef} id={`row-${record.id}`} className={`row${unread ? " unread" : ""}`} href={formatRoute({ view: route.view, id: record.id, params: route.params })}
      aria-current={selected ? "true" : undefined} onClick={open}>
      {kinds ? <span className={`row-kind-icon ${isRecord(record) ? "kind-record" : "kind-task"}`} aria-hidden="true">
        {isRecord(record) ? <Library size={16} /> : <BriefcaseBusiness size={16} />}
      </span> : null}
      <span className="row-main">
        <span className="row-top">
          <span className="row-title">{unread && <span className="unread-dot" aria-hidden="true" />}{unread && <span className="visually-hidden">{t.unread}</span>}{record.title}</span>
          <Time value={record.createdAt} />
        </span>
        {summary && <span className="row-summary">{summary}</span>}
        <span className="row-meta">
          {isRecord(record) ? <span className="row-kind">{channelLabel(channelOf(record))} · {kindLabels[record.kind]}</span>
            : record.kind === "project" && <span className="row-kind">{kindLabels.project}</span>}
          {!isRecord(record) && <span>{statusLabel(record)}</span>}
          {waiting > 0 && <span className="tag accent">{t.waiting} {waiting}</span>}
          {revisitDue(record) && <span className="tag">{t.revisit}</span>}
          {record.dueDate && <span>{t.due} {dateLabel(record.dueDate)}</span>}
          {host && <span className="row-host">{host}</span>}
          {record.fields.starred === true && <Star className="row-star" size={13} aria-label={t.starred} />}
          {record.archivedAt && <Archive size={13} aria-label={t.archived} />}
          {aiFilled(record) && <span>{t.aiFilled}</span>}
          {isSample(record) && <span className="tag">{t.sample}</span>}
        </span>
      </span>
    </a>
  </li>;
}

/** A record that later records continue, with a toggle that unfolds those earlier records under it (open while one of them is). */
function Thread({ record, earlier, kinds }: { readonly record: DashboardRecord; readonly earlier: readonly DashboardRecord[]; readonly kinds: boolean }) {
  const { route } = useDashboard();
  const [open, setOpen] = useState(false);
  const shown = open || earlier.some(item => item.id === route.id);
  const id = `thread-${record.id}`;
  return <>
    <RecordRow record={record} kinds={kinds} />
    <li className="thread-toggle">
      <button type="button" className="thread-button" aria-expanded={shown} aria-controls={id} onClick={() => setOpen(!shown)}>
        <ChevronDown size={14} aria-hidden="true" />{text().thread(earlier.length)}
      </button>
    </li>
    {shown && <li id={id} className="thread-earlier"><ul className="record-list">{earlier.map(item => <RecordRow key={item.id} record={item} kinds={kinds} />)}</ul></li>}
  </>;
}

/**
 * Rows with optional sticky day headers. Rows carry `id="row-<id>"` for keyboard selection. With `fold`, a record that
 * a later listed record continues folds under that one (foldContinuations).
 */
export function RecordList({ records, empty, emptyAction, grouped = false, kinds = false, fold = false }: {
  readonly records: readonly DashboardRecord[]; readonly empty: string; readonly emptyAction?: ReactNode; readonly grouped?: boolean;
  readonly kinds?: boolean; readonly fold?: boolean;
}) {
  if (!records.length) return <Empty action={emptyAction}>{empty}</Empty>;
  const entries = fold ? foldContinuations(records) : records.map(item => ({ item, earlier: [] as DashboardRecord[] }));
  const rows = (items: typeof entries) => items.map(({ item, earlier }) => earlier.length
    ? <Fragment key={item.id}><Thread record={item} earlier={earlier} kinds={kinds} /></Fragment>
    : <RecordRow key={item.id} record={item} kinds={kinds} />);
  if (!grouped) return <ul className="record-list">{rows(entries)}</ul>;
  return <div className="record-groups">{groupByDay(entries.map(entry => ({ ...entry, createdAt: entry.item.createdAt }))).map(group =>
    <section key={group.label} className="day-group" aria-label={group.label}>
      <h2 className="day-label">{group.label}</h2>
      <ul className="record-list">{rows(group.items)}</ul>
    </section>)}</div>;
}
