import { expect, test } from "bun:test";
import { DashboardRecordSchema } from "../../shared/contracts";

const make = (index: number) => DashboardRecordSchema.parse({
  id: `00000000-0000-4000-8000-${String(700 + index).padStart(12, "0")}`, kind: "research", title: `Research ${index}`, body: "Body",
  source: "chatgpt", createdBy: "chatgpt", reviewState: "approved", archivedAt: null,
  createdAt: "2026-09-28T01:00:00Z", updatedAt: "2026-09-28T01:00:00Z", version: 1, fields: {},
});
const records = Array.from({ length: 6 }, (_, index) => make(index));
const opened = records[0]!;

type View = InstanceType<typeof Bun.WebView>;
const until = (view: View, condition: string) => view.evaluate(`new Promise((resolve, reject) => {
  const read = ${condition};
  const timer = setTimeout(() => { clearInterval(poll); reject(new Error(${JSON.stringify(`timed out: ${condition}`)})); }, 5000);
  const check = () => { if (read()) { clearInterval(poll); clearTimeout(timer); resolve(true); } };
  const poll = setInterval(check, 30);
  check();
})`);
const boxes = `JSON.stringify(Object.fromEntries([".sidebar", ".appbar", ".list-pane", ".reader-pane", ".tabbar"].map(selector => {
  const element = document.querySelector(selector);
  if (!element) return [selector, "missing"];
  const box = element.getBoundingClientRect();
  return [selector, getComputedStyle(element).display === "none" ? null : [Math.round(box.left), Math.round(box.width)]];
})))`;
const settled = `() => document.getAnimations().length === 0`;
const state = `document.querySelector(".app").dataset.sidebar`;
const focused = `document.activeElement && (document.activeElement.getAttribute("aria-label") || document.activeElement.textContent)`;

async function serveApp() {
  const build = await Bun.build({ entrypoints: [`${import.meta.dir}/../main.tsx`], target: "browser" });
  expect(build.success).toBe(true);
  const [script, styles] = await Promise.all([".js", ".css"].map(extension => build.outputs.find(output => output.path.endsWith(extension))?.text() ?? ""));
  return Bun.serve({ port: 0, hostname: "127.0.0.1", routes: {
    // English is pinned, so the assertions below read the English labels whatever the browser's language.
    "/": new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><script>localStorage.setItem("agentic:locale", "en")</script><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } }),
    "/app.js": new Response(script, { headers: { "Content-Type": "text/javascript; charset=utf-8" } }),
    "/app.css": new Response(styles, { headers: { "Content-Type": "text/css; charset=utf-8" } }),
    "/api/v1/config": Response.json({ appName: "Agentic Dashboard", timeZone: "UTC", locale: "en", features: { narration: false, push: false, digest: false, trustedLogin: false } }),
    "/api/v1/auth/session": Response.json({ csrfToken: "csrf-1", expiresAt: "2026-10-06T00:00:00.000Z" }),
    "/api/v1/records": Response.json({ items: records, nextCursor: null }),
    "/api/v1/trash": Response.json({ items: [] }),
    "/api/v1/comments": Response.json({ items: [] }),
    "/api/v1/agents": Response.json({ items: [] }),
  } });
}

async function withApp(width: number, height: number, run: (view: View) => Promise<void>) {
  const server = await serveApp();
  const view = new Bun.WebView({ width, height });
  try {
    await view.navigate(`${server.url.href}#/library/${opened.id}`);
    await until(view, `() => document.querySelectorAll(".row-title").length >= ${width < 768 ? 0 : records.length} && document.querySelector(".reader h2")`);
    await view.evaluate(`localStorage.removeItem("agentic:sidebar")`);
    await run(view);
  } finally {
    view.close();
    server.stop(true);
  }
}

const read = async (view: View, script: string) => String(await view.evaluate(script));
const press = async (view: View, selector: string) => {
  const point = await view.evaluate(`(() => { const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; })()`) as { x: number; y: number };
  await view.click(point.x, point.y);
};

/** The opener in the list head, when it can be seen and pressed. */
const opener = `[...document.querySelectorAll(".sidebar-open")].find(button => button.getClientRects().length && getComputedStyle(button).visibility !== "hidden")`;

test("a wide window folds the sidebar into the layout and moves its button to the list head", async () => {
  await withApp(1440, 900, async view => {
    await until(view, settled);
    // Given: a 1440px window. Then: three columns with no app bar; the only toggle is in the sidebar head.
    const docked = JSON.parse(String(await view.evaluate(boxes)));
    expect(docked[".sidebar"]).toEqual([0, 248]);
    expect(docked[".list-pane"][0]).toBe(248);
    expect(docked[".appbar"]).toBeNull();
    expect(await read(view, state)).toBe("docked");
    expect(await read(view, `!!${opener}`)).toBe("false");
    // When: the sidebar's button folds it.
    await press(view, ".sidebar-toggle");
    await until(view, `() => ${state} === "hidden"`);
    await until(view, settled);
    // Then: the list fills its place (no scrim, nothing inert), the opener appears in the list head and takes focus.
    const folded = JSON.parse(String(await view.evaluate(boxes)));
    expect(folded[".list-pane"][0]).toBe(0);
    expect(folded[".sidebar"][0] + folded[".sidebar"][1]).toBeLessThanOrEqual(0);
    expect(await read(view, `document.querySelector(".list-pane .pane-title-row").contains(${opener})`)).toBe("true");
    expect(await read(view, focused)).toBe("Show sidebar");
    expect(await read(view, `document.querySelector("main").inert`)).toBe("false");
    expect(await read(view, `localStorage.getItem("agentic:sidebar")`)).toBe("hidden");
    // When: the page reloads. Then: it stays folded.
    await view.navigate(`${await read(view, "location.origin")}/?reloaded=1${await read(view, "location.hash")}`);
    await until(view, `() => document.querySelector(".reader h2") && document.querySelector(".app").dataset.sidebar`);
    expect(await read(view, state)).toBe("hidden");
    // When: the keyboard shortcut unfolds it. Then: the list moves back over, the opener goes and the choice is stored.
    await view.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "\\\\", code: "Backslash", metaKey: true, bubbles: true }))`);
    await until(view, `() => ${state} === "docked"`);
    await until(view, settled);
    expect(JSON.parse(String(await view.evaluate(boxes)))[".list-pane"][0]).toBe(248);
    expect(await read(view, `!!${opener}`)).toBe("false");
    expect(await read(view, `localStorage.getItem("agentic:sidebar")`)).toBe("shown");
  });
}, 30_000);

test("an iPad landscape window starts with two columns and unfolds the sidebar into the layout from the list head", async () => {
  await withApp(1180, 820, async view => {
    await until(view, settled);
    // Given: a 1180pt window (iPad Air 11" landscape) with no stored choice. Then: list and reader only, the opener in the list head.
    const rest = JSON.parse(String(await view.evaluate(boxes)));
    expect(await read(view, state)).toBe("hidden");
    expect(rest[".list-pane"][0]).toBe(0);
    expect(rest[".appbar"]).toBeNull();
    // When: the opener is pressed.
    await press(view, ".list-pane .sidebar-open");
    await until(view, `() => ${state} === "docked"`);
    await until(view, settled);
    // Then: the sidebar takes its place in the layout and the panes move over; nothing lies over them.
    const shown = JSON.parse(String(await view.evaluate(boxes)));
    expect(shown[".sidebar"]).toEqual([0, 248]);
    expect(shown[".list-pane"][0]).toBe(248);
    expect(shown[".reader-pane"][0] + shown[".reader-pane"][1]).toBe(1180);
    expect(await read(view, `document.querySelector("main").inert`)).toBe("false");
    expect(await read(view, `document.querySelector("#sidebar").contains(document.activeElement)`)).toBe("true");
  });
}, 30_000);

test("a window too narrow for three columns slides the sidebar over the panes from the list head", async () => {
  await withApp(900, 820, async view => {
    await until(view, settled);
    // Given: a 900pt window (a 2/3 iPad split). Then: two columns, no app bar.
    const rest = JSON.parse(String(await view.evaluate(boxes)));
    expect(rest[".list-pane"][0]).toBe(0);
    expect(rest[".appbar"]).toBeNull();
    // When: the opener in the list head is pressed.
    await press(view, ".list-pane .sidebar-open");
    await until(view, `() => ${state} === "open"`);
    await until(view, settled);
    // Then: the sidebar lies over the panes, which keep their place, and the page behind is inert.
    const open = JSON.parse(String(await view.evaluate(boxes)));
    expect(open[".sidebar"][0]).toBe(0);
    expect(open[".list-pane"]).toEqual(rest[".list-pane"]);
    expect(await read(view, `document.querySelector("main").inert`)).toBe("true");
    // When: Escape closes it. Then: focus returns to the opener.
    await view.press("Escape");
    await until(view, `() => ${state} === "hidden"`);
    await until(view, settled);
    expect(await read(view, focused)).toBe("Show sidebar");
    // When: it opens again and the scrim is tapped. Then: it closes without a new history entry.
    const entries = await read(view, "history.length");
    await press(view, ".list-pane .sidebar-open");
    await until(view, `() => ${state} === "open"`);
    await until(view, settled);
    await view.click(850, 400);
    await until(view, `() => ${state} === "hidden"`);
    expect(await read(view, "history.length")).toBe(entries);
  });
}, 30_000);

test("a phone keeps its tab bar and opens the sidebar as a drawer that closes on navigation", async () => {
  await withApp(390, 844, async view => {
    await view.evaluate(`location.hash = "#/library"`);
    await until(view, `() => document.querySelectorAll(".row-title").length === ${records.length}`);
    await until(view, settled);
    // Given: a phone on a tab screen. Then: the tab bar is there and the sidebar is off screen.
    const rest = JSON.parse(String(await view.evaluate(boxes)));
    expect(rest[".tabbar"]).toEqual([0, Number(await view.evaluate("document.documentElement.clientWidth"))]);
    expect(rest[".sidebar"][0] + rest[".sidebar"][1]).toBeLessThanOrEqual(0);
    // When: the app bar's menu button opens the drawer and a channel in it is chosen.
    await press(view, ".appbar-menu");
    await until(view, `() => ${state} === "open"`);
    await until(view, settled);
    await press(view, `.channel-nav a[href*="channel=chatgpt"]`);
    // Then: the library filters to that channel and the drawer closes.
    await until(view, `() => location.hash.includes("channel=chatgpt") && ${state} === "hidden"`);
    await until(view, settled);
    expect(JSON.parse(String(await view.evaluate(boxes)))[".tabbar"]).toEqual(rest[".tabbar"]);
  });
}, 30_000);
