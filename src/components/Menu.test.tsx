import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Menu } from "./Menu";

test("the menu button is a bare ⋯ icon whose name stays in its aria-label and tooltip", () => {
  // Given: a More menu with one command.
  const html = renderToStaticMarkup(<Menu label="More" items={[{ label: "Archive", onSelect: () => {} }]} />);
  const button = html.match(/<button[^>]*aria-haspopup="menu"[^>]*>([\s\S]*?)<\/button>/);
  // Then: the button is named More for assistive tech and the pointer tooltip, and shows only the icon.
  expect(button?.[0]).toContain('aria-label="More"');
  expect(button?.[0]).toContain('title="More"');
  expect(button?.[0]).toContain('class="btn btn-outline menu-button"');
  expect(button?.[1]?.replace(/<svg[\s\S]*?<\/svg>/g, "")).toBe("");
});
