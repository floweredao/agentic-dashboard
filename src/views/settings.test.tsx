import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { applyLocale } from "../i18n";
import { DashboardContext } from "../state";
import { fakeDashboard } from "../test-dashboard";
import { SettingsPane } from "./Settings";
import { config, configure } from "../config";

afterEach(() => applyLocale("ko"));
const render = () => renderToStaticMarkup(<DashboardContext.Provider value={fakeDashboard([], { view: "settings" })}><SettingsPane /></DashboardContext.Provider>);

test("Settings offers the language as three radio rows with the system language noted", () => {
  applyLocale("en");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["ko-KR"], language: "ko-KR", userAgent: "", platform: "", maxTouchPoints: 0 } });
  Object.defineProperty(globalThis, "window", { configurable: true, value: { matchMedia: () => ({ matches: false }) } });
  try {
    const html = render();
    const inputs = html.match(/<input[^>]*name="language"[^>]*>/g) ?? [];
    expect(inputs.map(input => input.match(/value="(\w+)"/)?.[1])).toEqual(["system", "en", "ko"]);
    expect(inputs.filter(input => input.includes("checked")).map(input => input.match(/value="(\w+)"/)?.[1])).toEqual(["system"]);
    expect(html).toContain("Follow the system");
    expect(html).toContain("This device: 한국어");
    expect(html).toContain('<strong lang="en">English</strong>');
    expect(html).toContain('<strong lang="ko">한국어</strong>');
    expect(html).not.toContain("<select");
  } finally {
    Reflect.deleteProperty(globalThis, "navigator");
    Reflect.deleteProperty(globalThis, "window");
  }
});

test("Settings shows the language choice in Korean too", () => {
  const html = render();
  expect(html).toContain("시스템 설정 따르기");
  expect(html).toContain("언어");
});

test("audio sections remain mounted while push is off", () => {
  // Given: narration is enabled independently of push.
  const features = { ...config.features };
  configure({ features: { narration: true, push: false } });
  try {
    // When: settings first renders, before its requests settle.
    const html = render();
    // Then: both sections have stable headings and loading state.
    expect(html).toContain('id="settings-voices"');
    expect(html).toContain('id="settings-auto"');
    expect(html).not.toContain('id="settings-device"');
  } finally { configure({ features }); }
});
