import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { setLocale } from "../i18n";
import { DashboardContext } from "../state";
import { fakeDashboard } from "../test-dashboard";
import { WorkPane } from "./Work";

afterEach(() => setLocale("ko"));

test("the work pane renders its own text in English and in Korean", () => {
  const render = () => renderToStaticMarkup(
    <DashboardContext.Provider value={fakeDashboard([], { view: "work" })}>
      <WorkPane />
    </DashboardContext.Provider>,
  );
  setLocale("en");
  const english = render();
  expect(english).toContain("New task");
  expect(english).toContain("No tasks");
  setLocale("ko");
  const korean = render();
  expect(korean).toContain("새 할 일");
  expect(korean).toContain("할 일 없음");
});
