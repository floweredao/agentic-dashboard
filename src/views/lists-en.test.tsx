import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { setLocale } from "../i18n";
import { DashboardContext } from "../state";
import { fakeDashboard } from "../test-dashboard";
import { ArchivePane } from "./Archive";
import { LibraryPane } from "./Library";
import { MorePane } from "./More";
import { purgeLabel } from "./Trash";

afterEach(() => setLocale("ko"));

const render = (pane: React.ReactNode, view: "library" | "archive" | "more") =>
  renderToStaticMarkup(<DashboardContext.Provider value={fakeDashboard([], { view, params: {}, id: null })}>{pane}</DashboardContext.Provider>);

test("list views render their text in English", () => {
  // Given: the English locale.
  setLocale("en");
  // When: panes with no records are rendered.
  const library = render(<LibraryPane />, "library");
  const archive = render(<ArchivePane />, "archive");
  const more = render(<MorePane />, "more");
  // Then: titles, filters and empty states come from the English dictionaries.
  expect(library).toContain("Library");
  expect(library).toContain("Search library");
  expect(library).toContain("No records");
  expect(archive).toContain("Nothing archived");
  expect(more).toContain("Manage channels");
  expect(purgeLabel("2026-10-03T00:00:00Z", Date.parse("2026-10-02T00:00:00Z"))).toBe("Deleted permanently in 1 day");
  expect(`${library}${archive}${more}`).not.toMatch(/[가-힣]/);
});
