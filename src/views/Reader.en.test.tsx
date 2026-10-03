import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DashboardRecordSchema } from "../../shared/contracts";
import { Markdown } from "../components/Markdown";
import { agentMessage } from "../components/ShareDialog";
import { applyLocale } from "../i18n";
import { DashboardContext } from "../state";
import { fakeDashboard } from "../test-dashboard";
import { Reader } from "./Reader";

const record = DashboardRecordSchema.parse({
  id: "00000000-0000-4000-8000-000000000501", kind: "research", title: "Sample research", body: "- [x] shipped\n- [ ] pending",
  source: "manual", createdBy: "manual", reviewState: "approved", archivedAt: null,
  createdAt: "2026-09-28T01:00:00Z", updatedAt: "2026-09-30T01:00:00Z", version: 1, fields: {},
});

test("the reader, markdown and share message render in English with a locale date", () => {
  applyLocale("en");
  try {
    const html = renderToStaticMarkup(<DashboardContext.Provider value={fakeDashboard([record])}><Reader record={record} /></DashboardContext.Provider>);
    expect(html).toContain('aria-label="Share"');
    // More is a ⋯ icon button: its name lives in the label and tooltip, with no visible text beside the icon.
    expect(html).toMatch(/<button[^>]*class="btn btn-outline menu-button"[^>]*aria-label="More" title="More"[^>]*><svg[^>]*lucide-ellipsis[^>]*>(?:<circle[^>]*><\/circle>)+<\/svg><\/button>/);
    expect(html).toContain("Saved September 28 · Edited September 30");
    expect(html).toContain("Confirmed");
    expect(renderToStaticMarkup(<Markdown text={"- [x] a\n- [ ] b"} />)).toContain('aria-label="Not done"');
    expect(agentMessage({ code: "AAAA-BBBB-CCCC", url: "https://dashboard.example.test/s/AAAA-BBBB-CCCC", createdAt: "2026-09-29T03:00:00.000Z" }))
      .toContain("one GET request");
  } finally {
    applyLocale("ko");
  }
});
