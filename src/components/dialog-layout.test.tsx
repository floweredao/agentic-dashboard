import { expect, test } from "bun:test";
import { DashboardRecordSchema } from "../../shared/contracts";

const make = (index: number, patch: Record<string, unknown> = {}) => DashboardRecordSchema.parse({
  id: `00000000-0000-4000-8000-${String(500 + index).padStart(12, "0")}`, kind: "research", title: `조사 ${index}`, body: "본문",
  source: "chatgpt", createdBy: "chatgpt", reviewState: "pending", archivedAt: null,
  createdAt: "2026-09-28T01:00:00Z", updatedAt: "2026-09-28T01:00:00Z", version: 1, fields: {}, ...patch,
});
const opened = make(0, { title: "긴 조사", body: Array.from({ length: 80 }, (_, i) => `문단 ${i}`).join("\n\n") });
const records = [opened, ...Array.from({ length: 30 }, (_, index) => make(index + 1))];

type View = InstanceType<typeof Bun.WebView>;
const until = (view: View, condition: string) => view.evaluate(`new Promise((resolve, reject) => {
  const read = ${condition};
  const timer = setTimeout(() => { observer.disconnect(); reject(new Error(${JSON.stringify(`timed out: ${condition}`)})); }, 5000);
  const check = () => { if (read()) { observer.disconnect(); clearTimeout(timer); resolve(true); } };
  const observer = new MutationObserver(check);
  observer.observe(document, { subtree: true, childList: true, attributes: true });
  check();
})`);
const shareButton = `[...document.querySelectorAll("button")].find(button => button.getAttribute("aria-label") === "공유")`;
const layout = `JSON.stringify([...document.querySelectorAll(".appbar, .list-pane, .reader-pane, .reader-body, .tabbar")]
  .map(element => { const box = element.getBoundingClientRect(); return [element.className, box.left, box.width]; }))`;

async function serveApp() {
  const build = await Bun.build({ entrypoints: [`${import.meta.dir}/../main.tsx`], target: "browser" });
  expect(build.success).toBe(true);
  const [script, styles] = await Promise.all([".js", ".css"].map(extension => build.outputs.find(output => output.path.endsWith(extension))?.text() ?? ""));
  return Bun.serve({ port: 0, hostname: "127.0.0.1", routes: {
    "/": new Response(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } }),
    "/app.js": new Response(script, { headers: { "Content-Type": "text/javascript; charset=utf-8" } }),
    "/app.css": new Response(styles, { headers: { "Content-Type": "text/css; charset=utf-8" } }),
    "/api/v1/config": Response.json({ appName: "Agentic Dashboard", timeZone: "Asia/Seoul", locale: "ko", features: { narration: false, push: false, digest: false, trustedLogin: false } }),
    "/api/v1/auth/session": Response.json({ csrfToken: "csrf-1", expiresAt: "2026-10-06T00:00:00.000Z" }),
    "/api/v1/records": Response.json({ items: records, nextCursor: null }),
    "/api/v1/records/:id/share": Response.json({ share: { code: "7K2M-9QXD-4HTV", url: "https://example.test/s/7K2M-9QXD-4HTV", createdAt: "2026-09-29T03:00:00.000Z" } }),
  } });
}

for (const [label, width, height, scrollY] of [["desktop", 1312, 800, 0], ["phone", 390, 844, 600]] as const) {
  test(`opening a dialog over the ${label} reader keeps the page behind it the same width`, async () => {
    // Given: the app bundle beside a mock API, showing a long record beside a list of unread records.
    const server = await serveApp();
    const view = new Bun.WebView({ width, height });
    try {
      await view.navigate(`${server.url.href}#/library/${opened.id}`);
      await until(view, `() => ${shareButton} && document.querySelectorAll(".row-title").length >= ${width < 768 ? 0 : records.length}`);
      await view.evaluate(`window.scrollTo(0, ${scrollY})`);
      // Then: on the desktop only the panes scroll, so the document has no scroll range of its own.
      if (label === "desktop") expect(Number(await view.evaluate("document.documentElement.scrollHeight - innerHeight"))).toBeLessThanOrEqual(0);
      const before = String(await view.evaluate(layout));
      // When: 공유 opens its dialog.
      const point = await view.evaluate(`(() => { const box = ${shareButton}.getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; })()`) as { x: number; y: number };
      await view.click(point.x, point.y);
      await until(view, `() => document.querySelector("dialog[open] input")`);
      // Then: the bars, panes and text keep their position and width, so nothing behind the dialog reflows.
      expect(String(await view.evaluate(layout))).toBe(before);
      // When: the dialog closes.
      await view.press("Escape");
      await until(view, `() => !document.querySelector("dialog[open]")`);
      // Then: the page is laid out exactly as before and back at its scroll offset.
      expect(String(await view.evaluate(layout))).toBe(before);
      expect(Number(await view.evaluate("window.scrollY"))).toBe(scrollY);
    } finally {
      view.close();
      server.stop(true);
    }
  }, 30_000);
}
