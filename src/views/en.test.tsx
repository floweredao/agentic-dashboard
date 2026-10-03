import { afterAll, beforeAll, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DashboardRecordSchema, TrashItemSchema } from "../../shared/contracts";
import type { DashboardRecord } from "../../shared/contracts";
import { applyLocale } from "../i18n";
import { DashboardContext } from "../state";
import type { Dashboard } from "../state";
import { fakeDashboard } from "../test-dashboard";
import { ArchivePane } from "./Archive";
import { ChannelsView } from "./Channels";
import { DigestPane } from "./Digest";
import { InboxPane } from "./Inbox";
import { LibraryPane } from "./Library";
import { MorePane } from "./More";
import { Reader } from "./Reader";
import { SettingsPane } from "./Settings";
import { TrashPane } from "./Trash";
import { WorkPane } from "./Work";

const research = DashboardRecordSchema.parse({
  id: "00000000-0000-4000-8000-000000000101", kind: "research", title: "Fixture research record", body: "Fixture body content",
  source: "manual", createdBy: "owner", reviewState: "approved", archivedAt: null,
  createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", version: 1,
  fields: { summary: "Fixture summary", conclusion: "Fixture conclusion", nextActions: "- Fixture action" },
});
const task = DashboardRecordSchema.parse({
  ...research, id: "00000000-0000-4000-8000-000000000102", kind: "task", title: "Fixture task",
  status: "todo", projectId: null, taskId: null, dueDate: null, fields: {},
});
const archived = DashboardRecordSchema.parse({ ...research, id: "00000000-0000-4000-8000-000000000103", archivedAt: "2026-10-01T00:00:00Z" });
const trashed = TrashItemSchema.parse({ record: research, deletedAt: "2026-10-01T00:00:00Z", purgeAt: "2026-10-31T00:00:00Z" });

const saved = { navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"), window: Object.getOwnPropertyDescriptor(globalThis, "window") };
beforeAll(() => {
  applyLocale("en");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en-US"], language: "en-US", userAgent: "", platform: "", maxTouchPoints: 0 } });
  Object.defineProperty(globalThis, "window", { configurable: true, value: { matchMedia: () => ({ matches: false }) } });
});
afterAll(() => {
  applyLocale("ko");
  for (const [name, descriptor] of Object.entries(saved)) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

function render(node: ReactNode, view: "inbox" | "library" | "work" | "more" | "settings" | "channels" | "archive" | "trash" | "digest",
  records: readonly DashboardRecord[] = [research], overrides: Partial<Dashboard> = {}) {
  return renderToStaticMarkup(<DashboardContext.Provider value={fakeDashboard(records, { view }, overrides)}>{node}</DashboardContext.Provider>);
}

async function withoutFixtureContent(markup: string) {
  return new HTMLRewriter().on('[lang="ko"], .reader-title, .reader-lead, .reader-body', { element(element) { element.remove(); } })
    .transform(new Response(markup)).text();
}

test("every pane renders without Korean UI text in English", async () => {
  const screens = [
    render(<InboxPane />, "inbox"),
    render(<LibraryPane />, "library"),
    render(<Reader record={research} />, "library"),
    render(<WorkPane />, "work", [task]),
    render(<MorePane />, "more"),
    render(<SettingsPane />, "settings"),
    render(<ChannelsView />, "channels"),
    render(<ArchivePane />, "archive", [archived]),
    render(<TrashPane now={Date.parse("2026-10-02T00:00:00Z")} />, "trash", [], { trash: [trashed] }),
    render(<DigestPane />, "digest"),
  ];
  const visibleText = await Promise.all(screens.map(withoutFixtureContent));
  for (const markup of visibleText) expect(markup.match(/[^<>]{0,60}[가-힣][^<>]{0,60}/g) ?? []).toEqual([]);
});
