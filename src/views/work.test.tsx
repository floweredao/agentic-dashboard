import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DashboardRecordSchema } from "../../shared/contracts";
import { channelsFor, setChannelKeys } from "../model";
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

afterEach(() => setChannelKeys(channelsFor([], [])));
const renderChannels = (records: Parameters<typeof fakeDashboard>[0]) => renderToStaticMarkup(
  <DashboardContext.Provider value={fakeDashboard(records, { view: "channels" })}>
    <ChannelsView />
  </DashboardContext.Provider>,
);

test("channels list every registered agent and record source by name, with the live pending count", () => {
  // Given: a registered agent with no records yet, and two live records from another source with one pending item.
  const records = [
    makeRecord("00000000-0000-4000-8000-000000000001", { source: "omo", createdBy: "omo", reviewState: "pending" }),
    makeRecord("00000000-0000-4000-8000-000000000002", { source: "omo", createdBy: "omo" }),
  ];
  setChannelKeys(channelsFor(["codex"], records));
  // When: the channels page is rendered.
  const html = renderChannels(records);
  const omoCard = html.split("<h2>omo</h2>").at(1)?.split("</article>").at(0) ?? "";
  // Then: codex, omo and manual cards render (share stays off without trusted login), and omo reports one pending item.
  expect(html.match(/class="channel-card"/g)).toHaveLength(3);
  expect(html).toContain("codex 에이전트가 저장한 기록");
  expect(omoCard).toContain("<dt>미확인</dt><dd>1</dd>");
  expect(html).not.toContain("bun run agents add");
});

test("with no agents the channels page explains how to register one", () => {
  // Given: no agents and only records written in the app.
  setChannelKeys(channelsFor([], []));
  // Then: only the manual card renders, with the registration command.
  const html = renderChannels([]);
  expect(html.match(/class="channel-card"/g)).toHaveLength(1);
  expect(html).toContain("bun run agents add &lt;name&gt;");
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
