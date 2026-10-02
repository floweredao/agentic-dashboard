import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DashboardRecordSchema } from "../../shared/contracts";
import type { DashboardRecord } from "../../shared/contracts";
import { blankRecord } from "../model";
import { DashboardContext } from "../state";
import { fakeDashboard } from "../test-dashboard";
import { Editor } from "./Editor";
import { LibraryPane } from "./Library";
import { ContinuationLinks, Reader } from "./Reader";
import { RecordList } from "../components/RecordList";

const make = (patch: Record<string, unknown> = {}) => DashboardRecordSchema.parse({
  id: "00000000-0000-4000-8000-000000000101", kind: "research", title: "조사", body: "본문",
  source: "chatgpt", createdBy: "chatgpt", reviewState: "pending", archivedAt: null,
  createdAt: "2026-09-28T01:00:00Z", updatedAt: "2026-09-28T02:00:00Z", version: 3, fields: {}, ...patch,
});

const withDashboard = (node: React.ReactNode, records: readonly DashboardRecord[] = []) =>
  renderToStaticMarkup(<DashboardContext.Provider value={fakeDashboard(records)}>{node}</DashboardContext.Provider>);

function labels(markup: string) {
  return [...markup.replace(/<(select|textarea|small)\b[\s\S]*?<\/\1>/g, "")
    .matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>|<legend class="field-legend">([\s\S]*?)<\/legend>/g)]
    .map(match => (match[1] ?? match[2] ?? "").replace(/<[^>]*>/g, "").trim());
}

const editorLabels = (kind: DashboardRecord["kind"], existing?: DashboardRecord, records: readonly DashboardRecord[] = []) =>
  labels(withDashboard(<Editor initial={existing ?? blankRecord(kind)} requestId="r" onClose={() => {}} {...(existing ? { existing } : {})} />, records));

test("the editor shows only the reduced field set for each kind", () => {
  // Given/When: new drafts of every kind, and one existing report.
  const research = editorLabels("research");
  const existingReport = editorLabels("research", make());
  const social = editorLabels("social");
  const note = editorLabels("note");
  const task = editorLabels("task");
  const project = editorLabels("project");
  // Then: each kind lists exactly its spec fields, in order; the kind select appears only for new material.
  expect(research).toEqual(["제목", "종류", "결론", "요약", "본문", "다음 할 일", "링크", "태그"]);
  expect(existingReport).toEqual(["제목", "결론", "요약", "본문", "다음 할 일", "링크", "태그"]);
  expect(social).toEqual(["제목", "종류", "요약", "메모", "링크", "태그"]);
  expect(note).toEqual(["제목", "종류", "내용", "링크", "태그"]);
  expect(task).toEqual(["제목", "상태", "마감일", "오늘 할 일", "설명"]);
  expect(project).toEqual(["제목", "상태", "개요", "다음 할 일"]);
});

test("the task editor offers a project only when one exists", () => {
  const project = make({ id: "00000000-0000-4000-8000-000000000102", kind: "project", status: "active", source: "manual", createdBy: "owner" });
  expect(editorLabels("task", undefined, [project])).toContain("프로젝트");
});

test("the reader hides the version and shows legacy fields only when filled", () => {
  // Given: a report with lead fields and one filled plus one empty legacy key.
  const html = withDashboard(<Reader record={make({ fields: { conclusion: "결론 한 줄", summary: "요약 문단", nextActions: "- 할 일", significance: "옛 의미", questions: "" } })} />);
  // Then: lead order is 결론 then 요약, then 본문, 다음 할 일 and the filled legacy section.
  const order = ["<h3>결론</h3>", "<h3>요약</h3>", "<h3>본문</h3>", "<h3>다음 할 일</h3>", "<h3>의미</h3>"].map(tag => html.indexOf(tag));
  expect(order.every(index => index >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  expect(html).not.toContain("<h3>더 알아볼 점</h3>");
  expect(html).not.toMatch(/v3\b/);
  expect(html).toContain("저장 9월 28일</p>");
  // And: the secondary commands sit behind one menu button.
  expect(html).toContain('aria-haspopup="menu"');
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain("7일 뒤");
});

test("the reader shows the edit date only when it falls on another Seoul day", () => {
  const html = withDashboard(<Reader record={make({ updatedAt: "2026-09-29T03:00:00Z" })} />);
  expect(html).toContain("저장 9월 28일 · 수정 9월 29일");
});

test("list rows name the channel in the meta line without a separate channel column", async () => {
  // Given: an approved ChatGPT report in the library.
  const html = renderToStaticMarkup(<DashboardContext.Provider value={fakeDashboard([make({ reviewState: "approved" })], { view: "library" })}>
    <LibraryPane />
  </DashboardContext.Provider>);
  let marks = 0;
  let meta = "";
  await new HTMLRewriter()
    .on(".row .channel-dot, .row .row-mark", { element() { marks += 1; } })
    .on(".row-kind", { text(chunk) { meta += chunk.text; } })
    .transform(new Response(html)).text();
  // Then: no dot column, and the meta line reads "채널 · 종류".
  expect(marks).toBe(0);
  expect(meta).toBe("ChatGPT · 조사 보고");
});

test("the reader lists links by address and names a finished confirmation", () => {
  // Given: an approved report with two generically labelled links.
  const html = withDashboard(<Reader record={make({ reviewState: "approved", links: [
    { label: "링크", url: "https://example.com/docs" }, { label: "링크", url: "https://example.net/new" }] })} />);
  // Then: each link shows its address, and the disabled confirm button says it is done.
  expect(html).toContain("example.com/docs<");
  expect(html).toContain("example.net/new<");
  // And: every link is a whole-card block opening in a new tab, followed by the inline 링크 추가 button.
  expect(html.match(/<a class="link-card" href="https:\/\/example\.(com|net)[^"]*" target="_blank" rel="noopener noreferrer">/g)).toHaveLength(2);
  expect(html).toMatch(/<button[^>]*inline-add[^>]*>.*?링크 추가<\/button>/);
  expect(html).toMatch(/disabled=""[^>]*>.*?확인함<\/button>/);
});

test("task rows show status and due date without the channel and kind", async () => {
  // Given: a manual task in the work list.
  const task = make({ kind: "task", status: "todo", source: "manual", createdBy: "owner", dueDate: "2026-09-30", reviewState: "approved" });
  const html = renderToStaticMarkup(<DashboardContext.Provider value={fakeDashboard([task], { view: "work" })}>
    <RecordList records={[task]} empty="없음" />
  </DashboardContext.Provider>);
  // Then: the meta line carries no "직접 작성 · 할 일" prefix.
  expect(html).not.toContain("직접 작성");
  expect(html).toContain("시작 전");
  expect(html).toContain("마감 9월 30일");
});

test("a task shows its timeline with each owner comment's state, and its row counts the comments still waiting", () => {
  // Given: an OmO task with a report, an owner comment OmO answered and marked done, a seen one, and an unseen one.
  const task = make({ kind: "task", status: "review", source: "omo", createdBy: "omo", reviewState: "pending", title: "작업" });
  const entry = (id: string, patch: Record<string, unknown>) => ({ id: `00000000-0000-4000-8000-0000000002${id}`, recordId: task.id,
    author: "owner", source: "manual" as const, body: "", replyTo: null, status: null, createdAt: "2026-09-28T03:00:00Z",
    seenAt: null, seenBy: null, doneAt: null, doneBy: null, ...patch });
  const comments = [
    entry("01", { author: "omo", source: "omo", body: "1차 보고", status: "review" }),
    entry("02", { body: "색 바꿔줘", seenAt: "2026-09-28T03:01:00Z", seenBy: "omo", doneAt: "2026-09-28T03:02:00Z", doneBy: "omo" }),
    entry("03", { author: "omo", source: "omo", body: "바꿨어요", replyTo: "00000000-0000-4000-8000-000000000202" }),
    entry("04", { body: "글자 키워줘", seenAt: "2026-09-28T03:03:00Z", seenBy: "omo" }),
    entry("05", { body: "아이콘도" }),
  ];
  const render = (node: React.ReactNode) => renderToStaticMarkup(
    <DashboardContext.Provider value={fakeDashboard([task], { view: "work", id: task.id }, { comments })}>{node}</DashboardContext.Provider>);
  // When: its reader and its row are rendered.
  const reader = render(<Reader record={task} />);
  const row = render(<RecordList records={[task]} empty="없음" />);
  // Then: the report shows its status change, the answered comment is 처리함 with the reply nested under it,
  // the others read 봤어요 and 아직 안 봤어요, the comment box is there, and the row waits on two comments.
  expect(reader).toContain("상태 → 확인 필요");
  expect(reader).toMatch(/색 바꿔줘[\s\S]*처리함 · OmO[\s\S]*class="timeline-replies"[\s\S]*바꿨어요/);
  expect(reader).toMatch(/글자 키워줘[\s\S]*OmO가 봤어요/);
  expect(reader).toMatch(/아이콘도[\s\S]*아직 안 봤어요/);
  expect(reader).toMatch(/<textarea[^>]*placeholder="OmO에게 남길 말"/);
  expect(row).toContain("답 대기 2");
});

test("an empty search offers to clear it", () => {
  const html = renderToStaticMarkup(<DashboardContext.Provider value={fakeDashboard([make({ reviewState: "approved" })], { view: "library", params: { q: "zzzz" } })}>
    <LibraryPane />
  </DashboardContext.Provider>);
  expect(html).toContain("검색 결과 없음");
  expect(html).toMatch(/<button[^>]*>검색 지우기<\/button>/);
});

test("a pending item's primary button reads 확인 for every material kind", () => {
  // Given: a pending link and a pending report.
  const link = withDashboard(<Reader record={make({ kind: "social", reviewState: "pending" })} />);
  const report = withDashboard(<Reader record={make({ reviewState: "pending" })} />);
  // Then: both use the one vocabulary, with no read/unread wording or check mark.
  for (const html of [link, report]) {
    expect(html).toMatch(/<button[^>]*btn-primary[^>]*>확인<\/button>/);
    expect(html).toContain("미확인</span>");
    expect(html).not.toContain("읽음");
  }
});

test("an approved record with a due revisit keeps 확인함 and shows the separate 다시 볼 날 tag and action", () => {
  // Given: an approved report whose revisit date has passed.
  const html = withDashboard(<Reader record={make({ reviewState: "approved", fields: { revisitDate: "2026-01-01" } })} />);
  // Then: the status tag stays 확인함, a separate tag marks the revisit, and 다시 봤어요 is offered.
  expect(html).toContain(">확인함</span>");
  expect(html).toContain(">다시 볼 날</span>");
  expect(html).toMatch(/<button[^>]*>.*?다시 봤어요<\/button>/);
  expect(html).toMatch(/disabled=""[^>]*>.*?확인함<\/button>/);
});

test("an approved record without a due revisit shows no revisit marker", () => {
  const html = withDashboard(<Reader record={make({ reviewState: "approved", fields: { revisitDate: "2999-01-01" } })} />);
  expect(html).not.toContain("다시 볼 날<");
  expect(html).not.toContain("다시 봤어요");
});

test("the reader says when the open item is outside the current list and links to where it is", () => {
  // Given: an archived report opened from the default library list.
  const archived = make({ reviewState: "approved", archivedAt: "2026-09-28T03:00:00Z" });
  const html = renderToStaticMarkup(<DashboardContext.Provider value={fakeDashboard([archived], { view: "library", id: archived.id })}>
    <Reader record={archived} />
  </DashboardContext.Provider>);
  // Then: a note explains it and offers the list that contains it.
  expect(html).toContain("지금 목록 조건에 맞지 않는 항목이에요.");
  expect(html).toMatch(/<button[^>]*>보관함에서 보기<\/button>/);
});

const earlierId = "b1d095e5-e555-4a5c-b740-80b5bc1ab176";
const continuation = () => {
  const earlier = make({ id: earlierId, title: "앞 조사", reviewState: "approved", createdAt: "2026-09-27T01:00:00Z" });
  const current = make({ reviewState: "approved", body: "앞 기록(b1d095e5)에 이어서", fields: { previousId: earlierId } });
  const older = make({ id: "00000000-0000-4000-8000-000000000301", kind: "note", title: "다음 메모", reviewState: "approved",
    createdAt: "2026-09-29T01:00:00Z", fields: { previousId: current.id } });
  const newer = make({ id: "00000000-0000-4000-8000-000000000302", title: "더 뒤 조사", reviewState: "approved",
    createdAt: "2026-09-30T01:00:00Z", fields: { previousId: current.id } });
  return { earlier, current, older, newer, all: [earlier, current, older, newer] };
};

/** Every host element of a given type in a rendered-by-call element tree. */
function elementsOf(node: React.ReactNode, type: string): React.ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(child => elementsOf(child, type));
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as React.ReactElement<Record<string, unknown>>;
  return [...(element.type === type ? [element] : []), ...elementsOf(element.props.children as React.ReactNode, type)];
}

test("the reader shows 이어지는 기록 with the earlier record and its continuations newest first", () => {
  // Given: a report that continues a loaded record and is continued by two later records.
  const { current, all } = continuation();
  const html = withDashboard(<Reader record={current} />, all);
  // Then: the section lists 앞 기록, then 다음 기록 newest first, as relation rows.
  const order = ["<h3>이어지는 기록</h3>", ">앞 기록</h4>", ">앞 조사<", ">다음 기록</h4>", ">더 뒤 조사<", ">다음 메모<"].map(tag => html.indexOf(tag));
  expect(order.every(index => index >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  // And: the short id in the body is an in-app link to the earlier record's home view.
  expect(html).toContain(`<a href="#/library/${earlierId}" class="record-ref" title="앞 조사">b1d095e5</a>`);
});

test("the continuation section hides without links and shows an unloaded earlier id muted", () => {
  expect(withDashboard(<Reader record={make()} />)).not.toContain("이어지는 기록");
  const html = withDashboard(<Reader record={make({ fields: { previousId: earlierId } })} />);
  expect(html).toContain("<h3>이어지는 기록</h3>");
  expect(html).toContain(`<p class="continuation-missing" title="${earlierId}">불러오지 않은 기록 · <span class="continuation-id">b1d095e5</span></p>`);
});

test("clicking 앞 기록 or 다음 기록 navigates to that record in its home view", () => {
  // Given: the continuation links with a recording navigate.
  const { earlier, older, newer } = continuation();
  const calls: unknown[] = [];
  const tree = ContinuationLinks({ previousId: earlierId, previous: earlier, following: [newer, older], navigate: to => { calls.push(to); } });
  // When: every row button is clicked in order.
  for (const button of elementsOf(tree, "button")) (button.props.onClick as () => void)();
  // Then: each click opens that record in the library (all are confirmed material).
  expect(calls).toEqual([{ view: "library", id: earlierId }, { view: "library", id: newer.id }, { view: "library", id: older.id }]);
});
