import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DashboardRecordSchema } from "../../shared/contracts";
import type { DashboardRecord } from "../../shared/contracts";
import { DashboardContext } from "../state";
import { fakeDashboard } from "../test-dashboard";
import { HomePane } from "./Home";

const record = (n: number, patch: Record<string, unknown> = {}) => DashboardRecordSchema.parse({
  id: `00000000-0000-4000-8000-0000000002${String(n).padStart(2, "0")}`, kind: "research", title: `기록 ${n}`, body: "",
  source: "manual", createdBy: "owner", reviewState: "approved", archivedAt: null,
  createdAt: `2026-09-${String(n).padStart(2, "0")}T00:00:00Z`, updatedAt: `2026-09-${String(n).padStart(2, "0")}T00:00:00Z`,
  version: 1, fields: {}, ...patch,
});
const task = (n: number, status: string, title: string) => record(n, { kind: "task", title, status, projectId: null, taskId: null, dueDate: null });

const render = (records: readonly DashboardRecord[]) =>
  renderToStaticMarkup(<DashboardContext.Provider value={fakeDashboard(records, { view: "home" })}>{<HomePane />}</DashboardContext.Provider>);

async function texts(markup: string, selector: string) {
  const found: string[] = [];
  await new HTMLRewriter().on(selector, {
    element() { found.push(""); },
    text(chunk) { found[found.length - 1] += chunk.text; },
  }).transform(new Response(markup)).text();
  return found;
}

test("Home has no day boundary: the newest records whatever their review state, and open tasks review first", async () => {
  // Given: weeks-old reviewed records (one archived, one continued by a later one) and tasks in every status.
  const records = [
    ...[1, 2, 3, 4, 5, 6].map(n => record(n)),
    record(7, { archivedAt: "2026-09-08T00:00:00Z" }),
    record(8, { reviewState: "pending", fields: { previousId: record(6).id } }),
    task(9, "todo", "할 일 하나"), task(10, "review", "확인할 일"), task(11, "done", "끝난 일"), task(12, "paused", "보류한 일"),
  ];
  // When: Home is rendered.
  const html = render(records);
  // Then: the title is 메인, not a date; the five newest unarchived records show, the continued one folded under its
  // continuation; 미확인 1 links to the queue; open tasks show, the one to review first.
  expect(await texts(html, "h1")).toEqual(["메인"]);
  expect(await texts(html, "h2")).toEqual(["최신 다이제스트", "최근 기록", "할 일"]);
  expect(await texts(html, 'section[aria-labelledby="today-records"] .row-title')).toEqual(["기록 8", "기록 5", "기록 4", "기록 3", "기록 2"]);
  expect(html).toContain('href="#/library?state=pending"');
  expect(await texts(html, 'section[aria-labelledby="today-tasks"] .row-title')).toEqual(["확인할 일", "할 일 하나"]);
});

test("Home says there is nothing yet when no digest or record has arrived", async () => {
  const html = render([]);
  expect(await texts(html, ".today-empty")).toEqual(["아직 온 다이제스트 없음", "아직 기록 없음"]);
  expect(html).not.toContain("today-tasks");
});
