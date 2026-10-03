import { afterEach, beforeAll, afterAll, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DashboardRecordSchema } from "../../shared/contracts";
import { applyLocale } from "../i18n";
import { DashboardContext } from "../state";
import { fakeDashboard } from "../test-dashboard";
import { ChannelsView } from "./Channels";
import { LibraryPane } from "./Library";
import { MorePane } from "./More";
import { SettingsPane } from "./Settings";
import { WorkPane } from "./Work";

const task = DashboardRecordSchema.parse({
  id: "00000000-0000-4000-8000-000000000102", kind: "task", title: "Fixture task", body: "", source: "manual", createdBy: "owner",
  reviewState: "approved", archivedAt: null, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", version: 1,
  status: "todo", projectId: null, taskId: null, dueDate: null, fields: {},
});

const saved = { navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"), window: Object.getOwnPropertyDescriptor(globalThis, "window") };
beforeAll(() => {
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["ko-KR"], language: "ko-KR", userAgent: "", platform: "", maxTouchPoints: 0 } });
  Object.defineProperty(globalThis, "window", { configurable: true, value: { matchMedia: () => ({ matches: false }) } });
});
afterEach(() => applyLocale("ko"));
afterAll(() => {
  for (const [name, descriptor] of Object.entries(saved)) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

const render = (node: ReactNode, view: "library" | "work" | "more" | "settings" | "channels") =>
  renderToStaticMarkup(<DashboardContext.Provider value={fakeDashboard([task], { view })}>{node}</DashboardContext.Provider>);

test("the panes render their text in Korean, and differently from English", () => {
  const panes: readonly [string, ReactNode, "library" | "work" | "more" | "settings" | "channels", string][] = [
    ["library", <LibraryPane />, "library", "기록"],
    ["work", <WorkPane />, "work", "새 할 일"],
    ["more", <MorePane />, "more", "채널 관리"],
    ["settings", <SettingsPane />, "settings", "시스템 설정 따르기"],
    ["channels", <ChannelsView />, "channels", "채널 관리"],
  ];
  for (const [name, node, view, expected] of panes) {
    applyLocale("ko");
    const korean = render(node, view);
    expect(korean, name).toContain(expected);
    expect(korean.replace(/<[^>]*>/g, ""), name).toMatch(/[가-힣]/);
    applyLocale("en");
    expect(render(node, view), name).not.toBe(korean);
  }
});
