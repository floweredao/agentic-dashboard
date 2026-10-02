import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DashboardRecordSchema } from "../../shared/contracts";
import { DashboardContext } from "../state";
import { fakeDashboard } from "../test-dashboard";
import { ChannelsView } from "./Channels";
import { WorkPane } from "./Work";

const makeRecord = (id: string, patch: Record<string, unknown>) => DashboardRecordSchema.parse({
  id,
  kind: "note",
  title: "기록",
  body: "",
  status: "new",
  projectId: null,
  taskId: null,
  dueDate: null,
  tags: [],
  links: [],
  fields: {},
  source: "manual",
  createdBy: "owner",
  reviewState: "approved",
  archivedAt: null,
  createdAt: "2026-09-28T00:00:00Z",
  updatedAt: "2026-09-28T00:00:00Z",
  version: 1,
  ...patch,
});

test("channels show every source and the live OmO pending count", () => {
  // Given: two live OmO records with one pending item.
  const records = [
    makeRecord("00000000-0000-4000-8000-000000000001", { source: "omo", createdBy: "omo", reviewState: "pending" }),
    makeRecord("00000000-0000-4000-8000-000000000002", { source: "omo", createdBy: "omo" }),
  ];
  // When: the channels page is rendered.
  const html = renderToStaticMarkup(
    <DashboardContext.Provider value={fakeDashboard(records, { view: "channels" })}>
      <ChannelsView />
    </DashboardContext.Provider>,
  );
  const omoCard = html.split("<h2>OmO</h2>").at(1)?.split("</article>").at(0) ?? "";
  // Then: all five channel cards render and OmO reports one pending item.
  expect(html.match(/class="channel-card"/g)).toHaveLength(5);
  expect(omoCard).toContain("<dt>미확인</dt><dd>1</dd>");
});

test("work done filter lists only completed tasks", () => {
  // Given: one completed task and one active task.
  const records = [
    makeRecord("00000000-0000-4000-8000-000000000010", { kind: "task", title: "완료한 업무", status: "done" }),
    makeRecord("00000000-0000-4000-8000-000000000011", { kind: "task", title: "진행 중 업무", status: "active" }),
  ];
  // When: the work pane is rendered with the done filter.
  const html = renderToStaticMarkup(
    <DashboardContext.Provider value={fakeDashboard(records, { view: "work", params: { filter: "done" } })}>
      <WorkPane />
    </DashboardContext.Provider>,
  );
  // Then: only the completed task is listed.
  expect(html).toContain("완료한 업무");
  expect(html).not.toContain("진행 중 업무");
});

test("project mode lists projects instead of tasks", () => {
  // Given: one project and one task.
  const records = [
    makeRecord("00000000-0000-4000-8000-000000000020", { kind: "project", title: "대시보드 프로젝트", status: "active" }),
    makeRecord("00000000-0000-4000-8000-000000000021", { kind: "task", title: "별도 업무", status: "todo" }),
  ];
  // When: the work pane is rendered in project mode.
  const html = renderToStaticMarkup(
    <DashboardContext.Provider value={fakeDashboard(records, { view: "work", params: { show: "projects" } })}>
      <WorkPane />
    </DashboardContext.Provider>,
  );
  // Then: the project is listed and the task is absent.
  expect(html).toContain("대시보드 프로젝트");
  expect(html).not.toContain("별도 업무");
});
