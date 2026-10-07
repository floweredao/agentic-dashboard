import { useEffect, useRef, useState } from "react";
import { Archive, ArchiveRestore, CalendarCheck, Check, CircleDot, Clock, ListPlus, Maximize2, Pencil, RotateCcw, Share2, Star, Trash2 } from "lucide-react";
import type { DashboardRecord } from "../../shared/contracts";
import { InlineLinkAdd, InlineTagAdd, LinkCard } from "../components/LinkTagFields";
import { DocumentFrame, useRecordDocument } from "../components/DocumentView";
import { FullscreenReader } from "../components/FullscreenReader";
import { useNarration } from "../components/Listen";
import { Markdown } from "../components/Markdown";
import { Menu } from "../components/Menu";
import { Timeline } from "../components/Timeline";
import type { MenuItem } from "../components/Menu";
import { BackButton, RecordChannel, Tag, isSample } from "../components/primitives";
import type { ResolveRecord } from "../components/Markdown";
import { aiFilled, blankRecord, channelOf, channelLabel, dateLabel, homeRouteOf, homeViewOf, idsField, isRecord, kindLabels, listedFor, localDate, projectStatuses, recordByRef, revisitDue, taskStatuses, textField } from "../model";
import { strings } from "../i18n";
import { formatRoute } from "../router";
import type { Route } from "../router";
import { useDashboard } from "../state";
import type { Dashboard } from "../state";

type Labels = {
  readonly body: Record<DashboardRecord["kind"], string>;
  readonly legacy: Record<(typeof legacyKeys)[number], string>;
  readonly [key: string]: unknown;
};
/** Older records may still carry these keys; they are shown read-only, and only when filled. */
const legacyKeys = ["significance", "questions", "savedReason", "personalNotes", "goal", "stage", "decisions", "acceptance", "progress", "result"] as const;
const text = strings({
  en: {
    body: { research: "Body", "work-report": "Body", social: "Note", note: "Content", task: "Description", project: "Overview" },
    legacy: {
      significance: "Significance", questions: "Questions to explore", savedReason: "Why it was saved", personalNotes: "Notes",
      goal: "Goal", stage: "Current stage", decisions: "Decisions", acceptance: "Acceptance criteria", progress: "Progress", result: "Result",
    },
    unread: "Unread", rejected: "Rejected", read: "Confirmed",
    fromInbox: "View in Inbox", fromLibrary: "View in Library", fromArchive: "View in Archive", fromProjects: "View in Projects", fromTasks: "View in all tasks",
    archived: "Archived",
    continuation: "Continues from", earlier: "Earlier record", later: "Later records",
    notLoaded: "Record not loaded",
    conclusion: "Conclusion", summary: "Summary", nextAction: "Next steps",
    dueDate: "Due date", todayTask: "Today's task", yes: "Yes", revisitDate: "Revisit date",
    restore: "Restore", archive: "Archive", delete: "Delete",
    markPending: "Mark as unread", snooze: "Revisit in 7 days", followUp: "Create follow-up task", revert: "Revert to original",
    needsReview: "Needs review", movedToReview: "Moved to needs review.",
    edit: "Edit",
    revisitTag: "Due for revisit", autoFilled: "Auto-filled", sample: "Sample",
    saved: "Saved", edited: "Edited",
    outside: "This item doesn't match the current list filters.",
    toolbar: "Toolbar", confirmTitle: "Confirm (E)", confirmed: "Confirmed", confirm: "Confirm",
    revisited: "Revisited", star: "Star", unstarTitle: "Remove star (S)", starTitle: "Star (S)",
    completeTitle: "Complete (E)", done: "Done", complete: "Complete", addTask: "Add task",
    share: "Share", shareTitle: "Share with an agent", more: "More",
    related: "Related items", links: "Links",
    views: "View", summaryView: "Summary", documentView: "Full document", fullscreen: "Full screen", fullscreenTitle: "Read in full screen", exitFullscreen: "Close",
  },
  ko: {
    body: { research: "본문", "work-report": "본문", social: "메모", note: "내용", task: "설명", project: "개요" },
    legacy: {
      significance: "의미", questions: "더 알아볼 점", savedReason: "저장한 이유", personalNotes: "메모",
      goal: "목표", stage: "현재 단계", decisions: "결정", acceptance: "완료 기준", progress: "진행 상황", result: "결과",
    },
    unread: "미확인", rejected: "반려", read: "확인함",
    fromInbox: "받은 항목에서 보기", fromLibrary: "기록에서 보기", fromArchive: "보관함에서 보기", fromProjects: "프로젝트 목록에서 보기", fromTasks: "할 일 전체에서 보기",
    archived: "보관됨",
    continuation: "이어지는 기록", earlier: "앞 기록", later: "다음 기록",
    notLoaded: "불러오지 않은 기록",
    conclusion: "결론", summary: "요약", nextAction: "다음 할 일",
    dueDate: "마감일", todayTask: "오늘 할 일", yes: "예", revisitDate: "다시 볼 날짜",
    restore: "복원", archive: "보관", delete: "삭제",
    markPending: "미확인으로 표시", snooze: "7일 뒤 다시 보기", followUp: "후속 할 일 만들기", revert: "원래대로 되돌리기",
    needsReview: "확인 필요", movedToReview: "확인 필요로 옮겼어요.",
    edit: "편집",
    revisitTag: "다시 볼 날", autoFilled: "자동 작성", sample: "샘플",
    saved: "저장", edited: "수정",
    outside: "지금 목록 조건에 맞지 않는 항목이에요.",
    toolbar: "도구 모음", confirmTitle: "확인 (E)", confirmed: "확인함", confirm: "확인",
    revisited: "다시 봤어요", star: "별표", unstarTitle: "별표 해제 (S)", starTitle: "별표 (S)",
    completeTitle: "완료 (E)", done: "완료됨", complete: "완료", addTask: "할 일 추가",
    share: "공유", shareTitle: "에이전트와 공유", more: "더보기",
    related: "연결된 항목", links: "링크",
    views: "보기", summaryView: "요약", documentView: "전체 문서", fullscreen: "전체화면", fullscreenTitle: "전체화면으로 보기", exitFullscreen: "닫기",
  },
} satisfies { readonly en: Labels; readonly ko: Labels });

/** Material status is reviewState alone; a due revisit is shown as its own tag beside it. */
function statusTag(record: DashboardRecord) {
  if (record.kind === "project") return <Tag>{projectStatuses[record.status as keyof typeof projectStatuses] ?? record.status}</Tag>;
  if (record.kind === "task") return <Tag tone={record.status === "done" ? "ok" : record.status === "review" ? "accent" : ""}>{taskStatuses[record.status as keyof typeof taskStatuses] ?? record.status}</Tag>;
  if (record.reviewState === "pending") return <Tag tone="accent">{text().unread}</Tag>;
  if (record.reviewState === "rejected") return <Tag tone="danger">{text().rejected}</Tag>;
  return <Tag tone="ok">{text().read}</Tag>;
}

const homeLabel = (home: Pick<Route, "view" | "params">) => home.view === "inbox" ? text().fromInbox
  : home.view === "library" ? text().fromLibrary : home.view === "archive" ? text().fromArchive
    : home.params.show ? text().fromProjects : text().fromTasks;

/** One related record as a row button that opens it in its home view (related items, continuation links). */
function relationButton(item: DashboardRecord, navigate: Dashboard["navigate"]) {
  return <button type="button" onClick={() => navigate({ view: homeViewOf(item), id: item.id })}>
    <RecordChannel record={item} /><span className="relation-kind">{kindLabels[item.kind]}</span><span className="relation-title">{item.title}</span>
    {item.archivedAt && <Tag>{text().archived}</Tag>}
  </button>;
}

/**
 * Continuation links: the record this one continues (fields.previousId) and the loaded records that continue it, newest first.
 * An earlier id that is not loaded shows as a muted short id. Renders nothing when neither exists.
 */
export function ContinuationLinks({ previousId, previous, following, navigate }: {
  readonly previousId: string; readonly previous: DashboardRecord | undefined;
  readonly following: readonly DashboardRecord[]; readonly navigate: Dashboard["navigate"];
}) {
  if (!previousId && following.length === 0) return null;
  return <section className="reader-section continuation">
    <h3>{text().continuation}</h3>
    {previousId && <div className="continuation-group">
      <h4 className="continuation-label">{text().earlier}</h4>
      {previous ? <ul className="relation-list"><li>{relationButton(previous, navigate)}</li></ul>
        : <p className="continuation-missing" title={previousId}>{text().notLoaded} · <span className="continuation-id">{previousId.slice(0, 8)}</span></p>}
    </div>}
    {following.length > 0 && <div className="continuation-group">
      <h4 className="continuation-label">{text().later}</h4>
      <ul className="relation-list">{following.map(item => <li key={item.id}>{relationButton(item, navigate)}</li>)}</ul>
    </div>}
  </section>;
}

export function Reader({ record }: { readonly record: DashboardRecord }) {
  const d = useDashboard();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (window.matchMedia("(max-width: 767px)").matches) heading.current?.focus({ preventScroll: true });
    heading.current?.closest(".pane")?.scrollTo({ top: 0 });
  }, [record.id]);
  // Opening a pending record confirms it once. After it is marked unread it stays pending until the record is opened again.
  useEffect(() => { void d.markRead(record); }, [record.id]);

  const material = isRecord(record);
  const narration = useNarration({ record: material ? record : null });
  const attached = useRecordDocument(material ? record.id : null);
  const [shown, setShown] = useState<{ readonly id: string; readonly full: boolean }>({ id: record.id, full: true });
  // A record with a document opens on it: the full document, not the short summary, is what is worth reading.
  const full = attached !== null && (shown.id !== record.id || shown.full);
  const [focused, setFocused] = useState<string | null>(null);
  const fullscreen = focused === record.id;
  const project = record.projectId ? d.byId.get(record.projectId) : undefined;
  const task = record.taskId ? d.byId.get(record.taskId) : undefined;
  const relationCandidates = record.kind === "project"
    ? d.records.filter(item => item.projectId === record.id && item.id !== record.id)
    : record.kind === "task"
      ? [...(project ? [project] : []), ...d.records.filter(item => isRecord(item) && (item.taskId === record.id || idsField(record, "evidenceIds").includes(item.id)))]
      : [...(project ? [project] : []), ...(task?.kind === "task" ? [task] : []),
        ...d.records.filter(item => item.kind === "task" && idsField(item, "evidenceIds").includes(record.id))];
  const relations = relationCandidates.filter((item, index) => relationCandidates.findIndex(candidate => candidate.id === item.id) === index);
  const previousId = material ? textField(record, "previousId") : "";
  const following = material ? d.records.filter(item => item.id !== record.id && textField(item, "previousId") === record.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : [];
  const resolveRecord: ResolveRecord = token => {
    const item = recordByRef(d.records, token);
    return item ? { id: item.id, title: item.title, href: formatRoute({ view: homeViewOf(item), id: item.id, params: {} }) } : null;
  };
  const sourceLink = record.kind === "social" ? record.links[0] : undefined;
  const listedLinks = sourceLink ? record.links.slice(1) : record.links;
  const lead = material
    ? ([[text().conclusion, textField(record, "conclusion")], [text().summary, textField(record, "summary")]] as const).filter(([, value]) => value.trim()) : [];
  const next = record.kind === "project" ? [text().nextAction, textField(record, "nextAction")] as const
    : material ? [text().nextAction, textField(record, "nextActions")] as const : null;
  const legacy = legacyKeys.filter(key => textField(record, key).trim());
  const revisit = textField(record, "revisitDate");
  const starred = record.fields.starred === true;
  const confirmed = record.reviewState === "approved";
  const due = material && revisitDue(record);
  // A record opened by link, relation or a change that moved it may not be in the list beside it.
  const home = homeRouteOf(record);
  const outside = d.route.view !== "channels" && !listedFor(d.route, d.records).some(item => item.id === record.id)
    && listedFor({ ...home, id: record.id }, d.records).some(item => item.id === record.id);
  const edited = localDate(new Date(record.updatedAt)) !== localDate(new Date(record.createdAt));
  const properties = [
    ...(record.kind === "task" && record.dueDate ? [[text().dueDate, dateLabel(record.dueDate)] as const] : []),
    ...(record.kind === "task" && record.fields.today === true ? [[text().todayTask, text().yes] as const] : []),
    ...(material && revisit ? [[text().revisitDate, dateLabel(revisit)] as const] : []),
  ];
  const archiveItem: MenuItem = record.archivedAt
    ? { label: text().restore, icon: <ArchiveRestore size={16} aria-hidden="true" />, onSelect: () => { void d.toggleArchive(record); } }
    : { label: text().archive, icon: <Archive size={16} aria-hidden="true" />, onSelect: () => { void d.toggleArchive(record); } };
  const deleteItem: MenuItem = { label: text().delete, icon: <Trash2 size={16} aria-hidden="true" />, danger: true, onSelect: () => { void d.remove(record); } };
  const moreItems: readonly MenuItem[] = material ? [
    ...narration.items,
    ...(confirmed ? [{ label: text().markPending, icon: <CircleDot size={16} aria-hidden="true" />, onSelect: () => { void d.markPending(record); } }] : []),
    { label: text().snooze, icon: <Clock size={16} aria-hidden="true" />, onSelect: () => { void d.snooze(record); } },
    { label: text().followUp, icon: <ListPlus size={16} aria-hidden="true" />, onSelect: () => d.followUp(record) },
    archiveItem,
    ...(aiFilled(record) ? [{ label: text().revert, icon: <RotateCcw size={16} aria-hidden="true" />, onSelect: () => { void d.revertAiFill(record); } }] : []),
    deleteItem,
  ] : record.kind === "task" ? [
    { label: text().needsReview, icon: <Clock size={16} aria-hidden="true" />, disabled: record.status === "review",
      onSelect: () => { void d.patch(record, { status: "review" }, text().movedToReview); } },
    archiveItem,
    deleteItem,
  ] : [archiveItem, deleteItem];
  const editButton = <button type="button" className="btn btn-outline edit-button" onClick={() => d.edit(record)} disabled={d.busy} aria-label={text().edit}>
    <Pencil size={16} aria-hidden="true" /><span className="edit-label">{text().edit}</span>
  </button>;

  return <article className="reader" aria-labelledby="reader-title">
    <div className={full ? "reader-inner has-document" : "reader-inner"}>
      {/* Full screen sits in the reading column's top-right corner on every screen, icon only with its name for assistive tech
          and the tooltip. */}
      <div className="reader-top">
      <div className="reader-top-main">
      <BackButton place="reader" />
      <div className="reader-meta">
        <span className="reader-channel"><RecordChannel record={record} size="tile" />{channelLabel(channelOf(record))}</span>
        <span className="reader-kind">{kindLabels[record.kind]}</span>
        {statusTag(record)}
        {due && <Tag tone="accent">{text().revisitTag}</Tag>}
        {aiFilled(record) && <Tag>{text().autoFilled}</Tag>}
        {record.archivedAt && <Tag>{text().archived}</Tag>}
        {isSample(record) && <Tag>{text().sample}</Tag>}
      </div>
      </div>
      <button type="button" className="btn btn-outline reader-corner-button reader-fullscreen-button" onClick={() => setFocused(record.id)}
        aria-label={text().fullscreen} title={text().fullscreenTitle}>
        <Maximize2 size={16} aria-hidden="true" />
      </button>
      </div>
      <h2 id="reader-title" ref={heading} tabIndex={-1} className="reader-title">{record.title}</h2>
      <p className="reader-dates">{text().saved} {dateLabel(record.createdAt)}{edited && <> · {text().edited} {dateLabel(record.updatedAt)}</>}</p>
      {outside && <p className="reader-note">{text().outside}
        <button type="button" className="btn btn-outline" onClick={() => d.navigate({ ...home, id: record.id })}>{homeLabel(home)}</button>
      </p>}

      <div className={due ? "reader-actions has-revisit" : "reader-actions"} role="toolbar" aria-label={text().toolbar}>
        {material && <>
          <button type="button" className={confirmed ? "btn btn-primary is-confirmed" : "btn btn-primary"} onClick={() => { void d.confirm(record); }} disabled={d.busy || record.reviewState !== "pending"} title={text().confirmTitle}>
            {confirmed && <Check size={16} aria-hidden="true" />}
            {confirmed ? text().confirmed : text().confirm}
          </button>
          {due && <button type="button" className="btn btn-outline revisit-button" onClick={() => { void d.clearRevisit(record); }} disabled={d.busy}
            aria-label={text().revisited}>
            <CalendarCheck size={16} aria-hidden="true" />{text().revisited}
          </button>}
          <button type="button" className="btn btn-outline icon-toggle" onClick={() => { void d.toggleStar(record); }} disabled={d.busy}
            aria-pressed={starred} aria-label={text().star} title={starred ? text().unstarTitle : text().starTitle}>
            <Star size={16} aria-hidden="true" fill={starred ? "currentColor" : "none"} />
          </button>
          {editButton}
        </>}
        {record.kind === "task" && <>
          <button type="button" className="btn btn-primary" onClick={() => { void d.confirm(record); }} disabled={d.busy || record.status === "done"} title={text().completeTitle}>
            <Check size={16} aria-hidden="true" />{record.status === "done" ? text().done : text().complete}
          </button>
          {editButton}
        </>}
        {record.kind === "project" && <>
          {editButton}
          <button type="button" className="btn btn-outline" disabled={d.busy}
            onClick={() => d.editDraft({ ...blankRecord("task"), projectId: record.id })}>
            <ListPlus size={16} aria-hidden="true" />{text().addTask}
          </button>
        </>}
        <button type="button" className="btn btn-outline icon-toggle" onClick={() => d.share(record)} aria-label={text().share} title={text().shareTitle}>
          <Share2 size={16} aria-hidden="true" />
        </button>
        <Menu label={text().more} items={moreItems} disabled={d.busy} />
      </div>

      {narration.bar}

      {sourceLink && <div className="source-link"><LinkCard link={sourceLink} /></div>}

      {(() => { const reading = <>
      {attached && <div className="segmented reader-docswitch" role="group" aria-label={text().views}>
        <button type="button" data-view="document" aria-pressed={full} onClick={() => setShown({ id: record.id, full: true })}>{text().documentView}</button>
        <button type="button" data-view="summary" aria-pressed={!full} onClick={() => setShown({ id: record.id, full: false })}>{text().summaryView}</button>
      </div>}

      {lead.length > 0 && <div className={full ? "reader-lead is-brief" : "reader-lead"}>{lead.map(([label, value]) => <section key={label}>
        <h3>{label}</h3><div className="prose compact"><Markdown text={value} resolveRecord={resolveRecord} /></div>
      </section>)}</div>}
      {full && attached ? <DocumentFrame key={record.id} html={attached.html} title={`${text().documentView}: ${record.title}`} /> : <>

      {record.body.trim() && <section className="reader-section reader-body-section">
        <h3>{text().body[record.kind]}</h3><div className="prose reader-body"><Markdown text={record.body} resolveRecord={resolveRecord} /></div>
      </section>}

      {!material && <Timeline key={record.id} record={record} />}

      {next && next[1].trim() && <section className="reader-section">
        <h3>{next[0]}</h3><div className="prose"><Markdown text={next[1]} resolveRecord={resolveRecord} /></div>
      </section>}

      {legacy.map(key => <section key={key} className="reader-section">
        <h3>{text().legacy[key]}</h3><div className="prose"><Markdown text={textField(record, key)} resolveRecord={resolveRecord} /></div>
      </section>)}
      </>}
      </>;
      return fullscreen
        ? <FullscreenReader title={record.title} closeLabel={text().exitFullscreen} onClose={() => setFocused(null)} wide={full}>{reading}</FullscreenReader>
        : reading; })()}

      <ContinuationLinks previousId={previousId} previous={previousId ? d.byId.get(previousId) : undefined} following={following} navigate={d.navigate} />

      {relations.length > 0 && <section className="reader-section">
        <h3>{text().related}</h3>
        <ul className="relation-list">{relations.map(item => <li key={item.id}>{relationButton(item, d.navigate)}</li>)}</ul>
      </section>}

      {(listedLinks.length > 0 || material) && <section className="reader-section">
        <h3>{text().links}</h3>
        {listedLinks.length > 0 && <ul className="link-list">{listedLinks.map((link, index) => <li key={`${link.url}-${index}`}>
          <LinkCard link={link} />
        </li>)}</ul>}
        {material && <InlineLinkAdd key={record.id} record={record} />}
      </section>}

      {(record.tags.length > 0 || material) && <div className="reader-tags">
        {record.tags.map(tag => <Tag key={tag}>#{tag}</Tag>)}
        {material && <InlineTagAdd key={record.id} record={record} />}
      </div>}

      {properties.length > 0 && <dl className="reader-props">{properties.map(([label, value]) =>
        <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl>}
    </div>
  </article>;
}
