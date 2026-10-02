import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DashboardRecordSchema } from "../../shared/contracts";
import { DashboardContext } from "../state";
import { fakeDashboard } from "../test-dashboard";
import { Reader } from "../views/Reader";

const make = (patch: Record<string, unknown> = {}) => DashboardRecordSchema.parse({
  id: "00000000-0000-4000-8000-000000000401", kind: "research", title: "공유할 조사", body: "본문",
  source: "chatgpt", createdBy: "chatgpt", reviewState: "approved", archivedAt: null,
  createdAt: "2026-09-28T01:00:00Z", updatedAt: "2026-09-28T01:00:00Z", version: 1, fields: {}, ...patch,
});

type View = InstanceType<typeof Bun.WebView>;
const findButton = `name => [...document.querySelectorAll("button")]
  .find(button => (button.getAttribute("aria-label") ?? button.textContent).trim() === name && !button.disabled)`;

const until = (view: View, condition: string) => view.evaluate(`new Promise((resolve, reject) => {
  const button = ${findButton};
  const read = ${condition};
  const stop = () => { observer.disconnect(); document.removeEventListener("focusin", check); clearTimeout(timer); };
  const check = () => { const value = read(); if (value) { stop(); resolve(value); } };
  const observer = new MutationObserver(check);
  const timer = setTimeout(() => { stop(); reject(new Error(${JSON.stringify(`timed out: ${condition}`)})); }, 5000);
  observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
  document.addEventListener("focusin", check);
  check();
})`);

async function press(view: View, name: string) {
  const point = await until(view, `() => { const target = button(${JSON.stringify(name)}); if (!target) return null;
    target.scrollIntoView({ block: "center" }); const box = target.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; }`) as { x: number; y: number };
  await view.click(point.x, point.y);
}

test("every record kind offers 공유 right before 더보기 in the reader toolbar", () => {
  for (const record of [make(), make({ kind: "social" }), make({ kind: "note" }), make({ kind: "work-report" }), make({ kind: "task" }), make({ kind: "project" })]) {
    const html = renderToStaticMarkup(<DashboardContext.Provider value={fakeDashboard([record])}><Reader record={record} /></DashboardContext.Provider>);
    expect(html).toMatch(/<button[^>]*aria-label="공유"[^>]*>(?:(?!<\/button>)[\s\S])*<\/button><div class="menu-wrap">/);
  }
});

test("공유 shows the record's link and code at once, and 공유 중지 revokes it and closes", async () => {
  // Given: the app bundle served beside a mock API whose record has no share yet.
  const record = make();
  const share = { code: "7K2M-9QXD-4HTV", url: "https://dashboard.example.test/s/7K2M-9QXD-4HTV", createdAt: "2026-09-29T03:00:00.000Z" };
  const path = `/api/v1/records/${record.id}/share`;
  let current: typeof share | null = null;
  const requests: { readonly method: string; readonly path: string; readonly csrf: string | null; readonly body: string }[] = [];
  const build = await Bun.build({ entrypoints: [`${import.meta.dir}/../main.tsx`], target: "browser" });
  expect(build.success).toBe(true);
  const [script, styles] = await Promise.all([".js", ".css"].map(extension => build.outputs.find(output => output.path.endsWith(extension))?.text() ?? ""));
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", routes: {
    "/": new Response(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } }),
    "/app.js": new Response(script, { headers: { "Content-Type": "text/javascript; charset=utf-8" } }),
    "/app.css": new Response(styles, { headers: { "Content-Type": "text/css; charset=utf-8" } }),
    "/api/v1/auth/session": Response.json({ csrfToken: "csrf-1", expiresAt: "2026-10-06T00:00:00.000Z" }),
    "/api/v1/records": Response.json({ items: [record], nextCursor: null }),
    "/api/v1/records/:id/share": async request => {
      requests.push({ method: request.method, path: new URL(request.url).pathname, csrf: request.headers.get("X-CSRF-Token"), body: await request.text() });
      if (request.method === "POST") { const created = current === null; current = share; return Response.json({ share }, { status: created ? 201 : 200 }); }
      if (request.method === "DELETE") { current = null; return new Response(null, { status: 204 }); }
      return Response.json({ share: current });
    },
  } });
  const view = new Bun.WebView({ width: 1024, height: 768 });
  try {
    await view.navigate(`${server.url.href}#/library/${record.id}`);
    // When: the owner opens 공유 from the reader.
    await press(view, "공유");
    // Then: one body-less POST carrying the CSRF token created the share with no extra step, the dialog shows the link and the code,
    // and focus is on the link's copy button.
    expect(await until(view, `() => { const values = [...document.querySelectorAll("dialog[open] input")].map(field => field.value); return values.length === 2 && values; }`))
      .toEqual([share.url, share.code]);
    expect(requests).toEqual([{ method: "POST", path, csrf: "csrf-1", body: "" }]);
    expect(await until(view, `() => document.activeElement?.getAttribute("aria-label") === "링크 복사"`)).toBe(true);
    expect(await until(view, `() => ({ create: Boolean(button("링크 만들기")) })`)).toEqual({ create: false });

    // When: 공유 중지 is pressed.
    await press(view, "공유 중지");
    // Then: a DELETE revoked it, the dialog closed and the toast says so.
    expect(await until(view, `() => !document.querySelector("dialog[open]") && document.querySelector(".toast > span")?.textContent`)).toBe("공유를 중지했어요.");
    expect(requests.slice(1)).toEqual([{ method: "DELETE", path, csrf: "csrf-1", body: "" }]);
  } finally {
    view.close();
    server.stop(true);
  }
}, 30_000);
