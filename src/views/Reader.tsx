import { useEffect, useRef } from "react";
import { Archive, ArchiveRestore, CalendarCheck, Check, CircleDot, Clock, ListPlus, Pencil, RotateCcw, Share2, Star, Trash2 } from "lucide-react";
import type { DashboardRecord } from "../../shared/contracts";
import { InlineLinkAdd, InlineTagAdd, LinkCard } from "../components/LinkTagFields";
import { useNarration } from "../components/Listen";
import { Markdown } from "../components/Markdown";
import { Menu } from "../components/Menu";
import { Timeline } from "../components/Timeline";
import type { MenuItem } from "../components/Menu";
import { BackButton, RecordChannel, Tag, isSample } from "../components/primitives";
import type { ResolveRecord } from "../components/Markdown";
import { aiFilled, blankRecord, channelOf, channelLabel, dateLabel, homeRouteOf, homeViewOf, idsField, isRecord, kindLabels, listedFor, projectStatuses, recordByRef, revisitDue, seoulDate, taskStatuses, textField } from "../model";
import { formatRoute } from "../router";
import type { Route } from "../router";
import { useDashboard } from "../state";
import type { Dashboard } from "../state";

const bodyLabels = {
  research: "본문", "work-report": "본문", social: "메모", note: "내용", task: "설명", project: "개요",
} as const satisfies Record<DashboardRecord["kind"], string>;
/** Older records may still carry these keys; they are shown read-only, and only when filled. */
const legacySections = [
  ["significance", "의미"], ["questions", "더 알아볼 점"], ["savedReason", "저장한 이유"], ["personalNotes", "메모"],
  ["goal", "목표"], ["stage", "현재 단계"], ["decisions", "결정"], ["acceptance", "완료 기준"], ["progress", "진행 상황"], ["result", "결과"],
] as const;

/** Material status is reviewState alone; a due revisit is shown as its own tag beside it. */
function statusTag(record: DashboardRecord) {
  if (record.kind === "project") return <Tag>{projectStatuses[record.status as keyof typeof projectStatuses] ?? record.status}</Tag>;
  if (record.kind === "task") return <Tag tone={record.status === "done" ? "ok" : record.status === "review" ? "accent" : ""}>{taskStatuses[record.status as keyof typeof taskStatuses] ?? record.status}</Tag>;
  if (record.reviewState === "pending") return <Tag tone="accent">미확인</Tag>;
  if (record.reviewState === "rejected") return <Tag tone="danger">반려</Tag>;
  return <Tag tone="ok">확인함</Tag>;
}

const homeLabel = (home: Pick<Route, "view" | "params">) => home.view === "inbox" ? "받은 항목에서 보기"
  : home.view === "library" ? "기록에서 보기" : home.view === "archive" ? "보관함에서 보기"
    : home.params.show ? "프로젝트 목록에서 보기" : "할 일 전체에서 보기";

/** One related record as a row button that opens it in its home view (연결된 항목, 이어지는 기록). */
function relationButton(item: DashboardRecord, navigate: Dashboard["navigate"]) {
  return <button type="button" onClick={() => navigate({ view: homeViewOf(item), id: item.id })}>
    <RecordChannel record={item} /><span className="relation-kind">{kindLabels[item.kind]}</span><span className="relation-title">{item.title}</span>
    {item.archivedAt && <Tag>보관됨</Tag>}
  </button>;
}

/**
 * 이어지는 기록: the record this one continues (fields.previousId) and the loaded records that continue it, newest first.
 * An earlier id that is not loaded shows as a muted short id. Renders nothing when neither exists.
 */
export function ContinuationLinks({ previousId, previous, following, navigate }: {
  readonly previousId: string; readonly previous: DashboardRecord | undefined;
  readonly following: readonly DashboardRecord[]; readonly navigate: Dashboard["navigate"];
}) {
  if (!previousId && following.length === 0) return null;
  return <section className="reader-section continuation">
    <h3>이어지는 기록</h3>
    {previousId && <div className="continuation-group">
      <h4 className="continuation-label">앞 기록</h4>
      {previous ? <ul className="relation-list"><li>{relationButton(previous, navigate)}</li></ul>
        : <p className="continuation-missing" title={previousId}>불러오지 않은 기록 · <span className="continuation-id">{previousId.slice(0, 8)}</span></p>}
    </div>}
    {following.length > 0 && <div className="continuation-group">
      <h4 className="continuation-label">다음 기록</h4>
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
  // Opening a pending record confirms it once. After 미확인으로 표시 it stays pending until the record is opened again.
  useEffect(() => { void d.markRead(record); }, [record.id]);

  const material = isRecord(record);
  const narration = useNarration({ record: material ? record : null });
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
    ? ([["결론", textField(record, "conclusion")], ["요약", textField(record, "summary")]] as const).filter(([, value]) => value.trim()) : [];
  const next = record.kind === "project" ? ["다음 할 일", textField(record, "nextAction")] as const
    : material ? ["다음 할 일", textField(record, "nextActions")] as const : null;
  const legacy = legacySections.filter(([key]) => textField(record, key).trim());
  const revisit = textField(record, "revisitDate");
  const starred = record.fields.starred === true;
  const confirmed = record.reviewState === "approved";
  const due = material && revisitDue(record);
  // A record opened by link, relation or a change that moved it may not be in the list beside it.
  const home = homeRouteOf(record);
  const outside = d.route.view !== "channels" && !listedFor(d.route, d.records).some(item => item.id === record.id)
    && listedFor({ ...home, id: record.id }, d.records).some(item => item.id === record.id);
  const edited = seoulDate(new Date(record.updatedAt)) !== seoulDate(new Date(record.createdAt));
  const properties = [
    ...(record.kind === "task" && record.dueDate ? [["마감일", dateLabel(record.dueDate)] as const] : []),
    ...(record.kind === "task" && record.fields.today === true ? [["오늘 할 일", "예"] as const] : []),
    ...(material && revisit ? [["다시 볼 날짜", dateLabel(revisit)] as const] : []),
  ];
  const archiveItem: MenuItem = record.archivedAt
    ? { label: "복원", icon: <ArchiveRestore size={16} aria-hidden="true" />, onSelect: () => { void d.toggleArchive(record); } }
    : { label: "보관", icon: <Archive size={16} aria-hidden="true" />, onSelect: () => { void d.toggleArchive(record); } };
  const deleteItem: MenuItem = { label: "삭제", icon: <Trash2 size={16} aria-hidden="true" />, danger: true, onSelect: () => { void d.remove(record); } };
  const moreItems: readonly MenuItem[] = material ? [
    ...narration.items,
    ...(confirmed ? [{ label: "미확인으로 표시", icon: <CircleDot size={16} aria-hidden="true" />, onSelect: () => { void d.markPending(record); } }] : []),
    { label: "7일 뒤 다시 보기", icon: <Clock size={16} aria-hidden="true" />, onSelect: () => { void d.snooze(record); } },
    { label: "후속 할 일 만들기", icon: <ListPlus size={16} aria-hidden="true" />, onSelect: () => d.followUp(record) },
    archiveItem,
    ...(aiFilled(record) ? [{ label: "원래대로 되돌리기", icon: <RotateCcw size={16} aria-hidden="true" />, onSelect: () => { void d.revertAiFill(record); } }] : []),
    deleteItem,
  ] : record.kind === "task" ? [
    { label: "확인 필요", icon: <Clock size={16} aria-hidden="true" />, disabled: record.status === "review",
      onSelect: () => { void d.patch(record, { status: "review" }, "확인 필요로 옮겼어요."); } },
    archiveItem,
    deleteItem,
  ] : [archiveItem, deleteItem];
  const editButton = <button type="button" className="btn btn-outline edit-button" onClick={() => d.edit(record)} disabled={d.busy} aria-label="편집">
    <Pencil size={16} aria-hidden="true" /><span className="edit-label">편집</span>
  </button>;

  return <article className="reader" aria-labelledby="reader-title">
    <div className="reader-inner">
      <BackButton place="reader" />
      <div className="reader-meta">
        <span className="reader-channel"><RecordChannel record={record} size="tile" />{channelLabel(channelOf(record))}</span>
        <span className="reader-kind">{kindLabels[record.kind]}</span>
        {statusTag(record)}
        {due && <Tag tone="accent">다시 볼 날</Tag>}
        {aiFilled(record) && <Tag>자동 작성</Tag>}
        {record.archivedAt && <Tag>보관됨</Tag>}
        {isSample(record) && <Tag>샘플</Tag>}
      </div>
      <h2 id="reader-title" ref={heading} tabIndex={-1} className="reader-title">{record.title}</h2>
      <p className="reader-dates">저장 {dateLabel(record.createdAt)}{edited && <> · 수정 {dateLabel(record.updatedAt)}</>}</p>
      {outside && <p className="reader-note">지금 목록 조건에 맞지 않는 항목이에요.
        <button type="button" className="btn btn-outline" onClick={() => d.navigate({ ...home, id: record.id })}>{homeLabel(home)}</button>
      </p>}

      <div className={due ? "reader-actions has-revisit" : "reader-actions"} role="toolbar" aria-label="도구 모음">
        {material && <>
          <button type="button" className={confirmed ? "btn btn-primary is-confirmed" : "btn btn-primary"} onClick={() => { void d.confirm(record); }} disabled={d.busy || record.reviewState !== "pending"} title="확인 (E)">
            {confirmed && <Check size={16} aria-hidden="true" />}
            {confirmed ? "확인함" : "확인"}
          </button>
          {due && <button type="button" className="btn btn-outline revisit-button" onClick={() => { void d.clearRevisit(record); }} disabled={d.busy}
            aria-label="다시 봤어요">
            <CalendarCheck size={16} aria-hidden="true" />다시 봤어요
          </button>}
          <button type="button" className="btn btn-outline icon-toggle" onClick={() => { void d.toggleStar(record); }} disabled={d.busy}
            aria-pressed={starred} aria-label="별표" title={starred ? "별표 해제 (S)" : "별표 (S)"}>
            <Star size={16} aria-hidden="true" fill={starred ? "currentColor" : "none"} />
          </button>
          {editButton}
        </>}
        {record.kind === "task" && <>
          <button type="button" className="btn btn-primary" onClick={() => { void d.confirm(record); }} disabled={d.busy || record.status === "done"} title="완료 (E)">
            <Check size={16} aria-hidden="true" />{record.status === "done" ? "완료됨" : "완료"}
          </button>
          {editButton}
        </>}
        {record.kind === "project" && <>
          {editButton}
          <button type="button" className="btn btn-outline" disabled={d.busy}
            onClick={() => d.editDraft({ ...blankRecord("task"), projectId: record.id })}>
            <ListPlus size={16} aria-hidden="true" />할 일 추가
          </button>
        </>}
        <button type="button" className="btn btn-outline icon-toggle" onClick={() => d.share(record)} aria-label="공유" title="에이전트와 공유">
          <Share2 size={16} aria-hidden="true" />
        </button>
        <Menu label="더보기" items={moreItems} disabled={d.busy} />
      </div>

      {narration.bar}

      {sourceLink && <div className="source-link"><LinkCard link={sourceLink} /></div>}

      {lead.length > 0 && <div className="reader-lead">{lead.map(([label, value]) => <section key={label}>
        <h3>{label}</h3><div className="prose compact"><Markdown text={value} resolveRecord={resolveRecord} /></div>
      </section>)}</div>}

      {record.body.trim() && <section className="reader-section reader-body-section">
        <h3>{bodyLabels[record.kind]}</h3><div className="prose reader-body"><Markdown text={record.body} resolveRecord={resolveRecord} /></div>
      </section>}

      {!material && <Timeline key={record.id} record={record} />}

      {next && next[1].trim() && <section className="reader-section">
        <h3>{next[0]}</h3><div className="prose"><Markdown text={next[1]} resolveRecord={resolveRecord} /></div>
      </section>}

      {legacy.map(([key, label]) => <section key={key} className="reader-section">
        <h3>{label}</h3><div className="prose"><Markdown text={textField(record, key)} resolveRecord={resolveRecord} /></div>
      </section>)}

      <ContinuationLinks previousId={previousId} previous={previousId ? d.byId.get(previousId) : undefined} following={following} navigate={d.navigate} />

      {relations.length > 0 && <section className="reader-section">
        <h3>연결된 항목</h3>
        <ul className="relation-list">{relations.map(item => <li key={item.id}>{relationButton(item, d.navigate)}</li>)}</ul>
      </section>}

      {(listedLinks.length > 0 || material) && <section className="reader-section">
        <h3>링크</h3>
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
