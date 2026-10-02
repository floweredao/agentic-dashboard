import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DashboardRecordSchema, TrashItemSchema } from "../../shared/contracts";
import type { DashboardRecord } from "../../shared/contracts";
import { DashboardContext } from "../state";
import type { Dashboard } from "../state";
import { fakeDashboard } from "../test-dashboard";
import { ArchivePane } from "./Archive";
import { TrashPane, purgeLabel } from "./Trash";

const make = (id: string, patch: Record<string, unknown> = {}) => DashboardRecordSchema.parse({
  id, kind: "social", title: "기록", body: "", source: "manual", createdBy: "owner", reviewState: "approved", archivedAt: null,
  createdAt: "2026-09-20T00:00:00Z", updatedAt: "2026-09-20T00:00:00Z", version: 1, fields: {}, ...patch,
});

const render = (node: React.ReactNode, records: readonly DashboardRecord[], overrides: Partial<Dashboard> = {}) =>
  renderToStaticMarkup(<DashboardContext.Provider value={fakeDashboard(records, { view: "archive" }, overrides)}>{node}</DashboardContext.Provider>);

async function scan(markup: string, selector: string) {
  let count = 0;
  let text = "";
  await new HTMLRewriter().on(selector, {
    element() { count += 1; },
    text(chunk) { text += chunk.text; },
  }).transform(new Response(markup)).text();
  return { count, text };
}

test("ArchivePane lists archived records of every kind, latest first, and leaves live ones out", async () => {
  // Given: an archived task, a later-archived note and a live link.
  const records = [
    make("00000000-0000-4000-8000-000000000001", { kind: "task", title: "끝난 업무", status: "done", archivedAt: "2026-09-20T00:00:00Z" }),
    make("00000000-0000-4000-8000-000000000002", { kind: "note", title: "보관한 메모", archivedAt: "2026-09-21T00:00:00Z" }),
    make("00000000-0000-4000-8000-000000000003", { title: "살아 있는 링크" }),
  ];
  // When: the archive is rendered.
  const html = render(<ArchivePane />, records);
  // Then: both archived records are rows, note first, and the live link is absent; the title counts two.
  expect(await scan(html, ".row-title")).toEqual({ count: 2, text: "보관한 메모끝난 업무" });
  expect((await scan(html, ".pane-title .count")).text).toBe("2");
});

test("ArchivePane without archived records shows its empty line", async () => {
  const html = render(<ArchivePane />, [make("00000000-0000-4000-8000-000000000004")]);
  expect((await scan(html, ".row")).count).toBe(0);
  expect(html).toContain("보관한 항목 없음");
});

const trashed = (id: string, patch: Record<string, unknown>, deletedAt: string, purgeAt: string) =>
  TrashItemSchema.parse({ record: make(id, patch), deletedAt, purgeAt });

test("TrashPane lists the latest deletion first with the days left before the purge", async () => {
  // Given: two trashed records, the ChatGPT link deleted after the note, seen 28.5 days before the link's purge.
  const items = [
    trashed("00000000-0000-4000-8000-000000000011", { kind: "note", title: "지운 메모" }, "2026-09-29T00:00:00Z", "2026-10-29T00:00:00Z"),
    trashed("00000000-0000-4000-8000-000000000012", { title: "지운 링크", source: "chatgpt", createdBy: "chatgpt" }, "2026-09-30T00:00:00Z", "2026-10-30T00:00:00Z"),
  ];
  const now = Date.parse("2026-10-01T12:00:00Z");
  // When: the trash is rendered at that moment.
  const html = render(<TrashPane now={now} />, [], { trash: items });
  // Then: the link comes first, its meta names channel, kind and a rounded-up 29 days, and each row offers 복원 and 영구 삭제.
  expect(await scan(html, ".trash-title")).toEqual({ count: 2, text: "지운 링크지운 메모" });
  expect((await scan(html, ".trash-meta")).text).toBe("ChatGPT · 링크 · 29일 뒤 영구 삭제직접 작성 · 메모 · 28일 뒤 영구 삭제");
  expect(html.match(/aria-label="영구 삭제"/g)).toHaveLength(2);
  expect(html.match(/<button[^>]*btn-outline[^>]*>.*?복원<\/button>/g)).toHaveLength(2);
  expect((await scan(html, ".pane-title .count")).text).toBe("2");
  expect(html).toMatch(/<button[^>]*trash-empty[^>]*>휴지통 비우기<\/button>/);
  expect(html).not.toMatch(/<button[^>]*trash-empty[^>]*disabled=""/);
});

test("purgeLabel reads 오늘 on the purge day and never counts below zero", () => {
  const purgeAt = "2026-10-30T00:00:00Z";
  expect(purgeLabel(purgeAt, Date.parse("2026-10-29T00:00:01Z"))).toBe("1일 뒤 영구 삭제");
  expect(purgeLabel(purgeAt, Date.parse("2026-10-30T00:00:00Z"))).toBe("오늘 영구 삭제");
  expect(purgeLabel(purgeAt, Date.parse("2026-11-05T00:00:00Z"))).toBe("오늘 영구 삭제");
});

test("an empty TrashPane says so and disables 휴지통 비우기", async () => {
  const html = render(<TrashPane now={Date.parse("2026-10-01T00:00:00Z")} />, []);
  expect(html).toContain("휴지통이 비어 있음");
  expect((await scan(html, ".trash-item")).count).toBe(0);
  expect(html).toMatch(/<button[^>]*trash-empty[^>]*disabled=""[^>]*>휴지통 비우기<\/button>/);
  expect(html).toContain("30일 동안 보관한 뒤 영구 삭제돼요.");
});
