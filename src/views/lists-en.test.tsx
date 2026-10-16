import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { applyLocale } from "../i18n";
import { DashboardContext } from "../state";
import { fakeDashboard } from "../test-dashboard";
import { LibraryPane } from "./Library";
import { MorePane } from "./More";
import { purgeLabel } from "./Trash";

afterEach(() => applyLocale("ko"));

const render = (pane: React.ReactNode, view: "library" | "more", params: Readonly<Record<string, string>> = {}) =>
  renderToStaticMarkup(<DashboardContext.Provider value={fakeDashboard([], { view, params, id: null })}>{pane}</DashboardContext.Provider>);

test("list views render their text in English", () => {
  // Given: the English locale.
  applyLocale("en");
  // When: panes with no records are rendered.
  const library = render(<LibraryPane />, "library");
  const archive = render(<LibraryPane />, "library", { state: "archived" });
  const more = render(<MorePane />, "more");
  // Then: titles, filters and empty states come from the English dictionaries.
  expect(library).toContain("Library");
  expect(library).toContain("Search library");
  expect(library).toContain("No records");
  // And: the one state chip group reads All · To review · Favorites · Archived.
  expect(library.match(/aria-label="Record status">(.*?)<\/div>/)?.[1]?.replace(/<[^>]+>/g, "")).toBe("All0To review0Favorites0Archived0");
  expect(archive).toContain("Nothing archived");
  expect(more).toContain("Manage channels");
  expect(purgeLabel("2026-10-03T00:00:00Z", Date.parse("2026-10-02T00:00:00Z"))).toBe("Deleted permanently in 1 day");
  expect(`${library}${archive}${more}`).not.toMatch(/[가-힣]/);
});
