import { expect, test } from "bun:test";
import { DashboardRecordSchema, TrashItemSchema } from "../../shared/contracts";

const make = (index: number, patch: Record<string, unknown> = {}) => DashboardRecordSchema.parse({
  id: `00000000-0000-4000-8000-${String(700 + index).padStart(12, "0")}`, kind: "research", title: `조사 ${index}`, body: "본문",
  source: "chatgpt", createdBy: "chatgpt", reviewState: "approved", archivedAt: null,
  createdAt: `2026-09-2${index}T01:00:00Z`, updatedAt: "2026-09-28T01:00:00Z", version: 1, fields: {}, ...patch,
});
const trashed = (index: number) => TrashItemSchema.parse({ record: make(index, { title: `지운 조사 ${index}` }),
  deletedAt: `2026-10-0${index}T00:00:00.000Z`, purgeAt: `2026-11-0${index}T00:00:00.000Z` });
const digestId = "00000000-0000-4000-8000-000000000790";

type View = InstanceType<typeof Bun.WebView>;
const findButton = `name => [...document.querySelectorAll("button")]
  .find(button => (button.getAttribute("aria-label") ?? button.textContent).trim() === name && !button.disabled)`;
/** Resolves with the first truthy value of `condition`, checked on every DOM change and focus move; rejects after 5 seconds. */
const until = (view: View, condition: string) => view.evaluate(`new Promise((resolve, reject) => {
  const button = ${findButton};
  const read = ${condition};
  const stop = () => { observer.disconnect(); document.removeEventListener("focusin", check); document.removeEventListener("focusout", check); clearTimeout(timer); };
  const check = () => { const value = read(); if (value) { stop(); resolve(value); } };
  const observer = new MutationObserver(check);
  const timer = setTimeout(() => { stop(); reject(new Error(${JSON.stringify(`timed out: ${condition}`)})); }, 5000);
  observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
  document.addEventListener("focusin", check);
  document.addEventListener("focusout", check);
  check();
})`);
const centre = (element: string) => `(() => { const target = ${element}; if (!target) return null;
  target.scrollIntoView({ block: "center" }); const box = target.getBoundingClientRect();
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; })()`;

async function tap(view: View, element: string) {
  const point = await until(view, `() => ${centre(element)}`) as { x: number; y: number };
  await view.click(point.x, point.y);
}
const press = (view: View, name: string) => tap(view, `button(${JSON.stringify(name)})`);

/** The app bundle beside a mock API that keeps its records and trash, so deletes and restores show in the next load. */
async function serveApp({ records = [] as ReturnType<typeof make>[], trash = [] as ReturnType<typeof trashed>[], digests = false } = {}) {
  const build = await Bun.build({ entrypoints: [`${import.meta.dir}/../main.tsx`], target: "browser" });
  expect(build.success).toBe(true);
  const [script, styles] = await Promise.all([".js", ".css"].map(extension => build.outputs.find(output => output.path.endsWith(extension))?.text() ?? ""));
  let items = [...records];
  let bin = [...trash];
  const page = { items: [], from: "2026-09-20", to: "2026-10-03", unread: 0, earliestDate: null, latestDate: null,
    parts: { articles: { unread: 0, earliestDate: null }, messages: { unread: 0, earliestDate: null } } };
  // An onboarded account, so the app opens straight on its screens.
  const account = { id: "test-user", email: "reader@example.test", locale: "ko", timeZone: "Asia/Seoul", timeZoneSaved: true,
    onboardedAt: "2026-09-01T00:00:00.000Z", agentSaveVerified: true, agentSaveRecordId: null, features: { digest: digests, push: false } };
  return Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ items: [] }), routes: {
    "/": new Response(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><script>localStorage.setItem("agentic:locale", "ko")</script><div id="root"></div><script type="module" src="/app.js"></script></body></html>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } }),
    "/app.js": new Response(script, { headers: { "Content-Type": "text/javascript; charset=utf-8" } }),
    "/app.css": new Response(styles, { headers: { "Content-Type": "text/css; charset=utf-8" } }),
    "/api/v1/config": Response.json({ appName: "Agentic Dashboard", timeZone: "Asia/Seoul", locale: "ko", features: { narration: false, push: false, digest: digests, trustedLogin: false } }),
    "/api/v1/auth/session": Response.json({ csrfToken: "csrf-1", expiresAt: "2026-10-06T00:00:00.000Z", account }),
    "/api/v1/account": Response.json({ account }),
    "/api/v1/records": () => Response.json({ items, nextCursor: null }),
    "/api/v1/records/changes": Response.json({ cursor: 0, items: [], deletedIds: [], hasMore: false, reset: false }),
    "/api/v1/records/:id": request => {
      const record = items.find(item => item.id === request.params.id);
      if (!record) return Response.json({ error: { code: "not_found", message: "not found" } }, { status: 404 });
      if (request.method === "DELETE") { items = items.filter(item => item !== record); return new Response(null, { status: 204 }); }
      const saved = { ...record, archivedAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z", version: record.version + 1 };
      items = items.map(item => item === record ? saved : item);
      return Response.json({ record: saved });
    },
    "/api/v1/trash": request => { if (request.method === "DELETE") bin = []; return request.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json({ items: bin }); },
    "/api/v1/trash/:id/restore": request => {
      const item = bin.find(entry => entry.record.id === request.params.id);
      bin = bin.filter(entry => entry !== item);
      if (item) items = [...items, item.record];
      return Response.json({ record: item?.record });
    },
    "/api/v1/trash/:id": request => { bin = bin.filter(entry => entry.record.id !== request.params.id); return new Response(null, { status: 204 }); },
    "/api/v1/comments": Response.json({ items: [] }),
    "/api/v1/agents": Response.json({ items: [] }),
    "/api/v1/digests": Response.json(page),
    "/api/v1/digests/:id": Response.json({ error: { code: "internal", message: "boom" } }, { status: 500 }),
  } });
}

async function withApp(options: Parameters<typeof serveApp>[0], width: number, height: number, run: (view: View) => Promise<void>) {
  const server = await serveApp(options);
  const view = new Bun.WebView({ width, height });
  try {
    await view.navigate(server.url.href);
    await run(view);
  } finally {
    view.close();
    server.stop(true);
  }
}

test("back from a phone reader puts focus on the row of the record that was open", async () => {
  // Given: a phone showing the Library with three records.
  const records = [make(1), make(2), make(3)];
  await withApp({ records }, 390, 844, async view => {
    await view.evaluate(`location.hash = "#/library"`);
    // When: the second record is opened and the app bar's back is pressed.
    await tap(view, `document.getElementById("row-${records[1]?.id}")`);
    await until(view, `() => document.activeElement?.id === "reader-title"`);
    await tap(view, `document.querySelector(".appbar-back")`);
    // Then: the list is back and focus is on that record's row, not dropped to the page with the back button.
    expect(await until(view, `() => location.hash === "#/library" && document.activeElement?.id`)).toBe(`row-${records[1]?.id}`);
  });
}, 30_000);

for (const [label, width, height] of [["desktop", 1312, 800], ["phone", 390, 844]] as const) {
  for (const command of ["삭제", "보관"]) {
    test(`${command} from the ${label} reader menu leaves focus in main, not on the page`, async () => {
      // Given: the second of three records open in the reader.
      const records = [make(1), make(2), make(3)];
      await withApp({ records }, width, height, async view => {
        await view.evaluate(`location.hash = "#/library/${records[1]?.id}"`);
        await until(view, `() => document.querySelector(".reader-title")?.textContent === "조사 2"`);
        // When: the command is chosen from the reader's ⋯ menu.
        await press(view, "더보기");
        await press(view, command);
        // Then: the reader goes back to the list, and focus lands on main (its row has left the list) instead of the body.
        expect(await until(view, `() => location.hash === "#/library" && !document.querySelector(".reader-title")
          && !document.getElementById("row-${records[1]?.id}") && document.activeElement?.id`)).toBe("main");
      });
    }, 30_000);
  }
}

/** The trashed title and button text of the focused trash button, or null while focus is anywhere else. */
const focusedTrashButton = `(document.activeElement?.closest(".trash-item") ? document.activeElement.closest(".trash-item").querySelector(".trash-title").textContent + " " + document.activeElement.textContent : null)`;

test("restoring a trashed item moves focus to 복원 of the item that takes its place", async () => {
  // Given: two trashed records, newest deletion first.
  await withApp({ trash: [trashed(4), trashed(5)] }, 1312, 800, async view => {
    await view.evaluate(`location.hash = "#/trash"`);
    await until(view, `() => document.querySelectorAll(".trash-item").length === 2`);
    // When: the first item is restored.
    await press(view, "복원");
    // Then: focus is on 복원 of the item now in its place, not dropped to the page with the removed row.
    expect(await until(view, `() => document.querySelectorAll(".trash-item").length === 1 && ${focusedTrashButton}`)).toBe("지운 조사 4 복원");
  });
}, 30_000);

test("deleting a trashed item for good moves focus to the next item, and emptying the trash moves it to main", async () => {
  // Given: three trashed records, newest deletion first; the page confirms every permanent delete.
  await withApp({ trash: [trashed(4), trashed(5), trashed(6)] }, 1312, 800, async view => {
    await view.evaluate(`location.hash = "#/trash"`);
    await until(view, `() => document.querySelectorAll(".trash-item").length === 3`);
    await view.evaluate("window.confirm = () => true");
    // When: the first item is deleted for good.
    await tap(view, `document.querySelector(".trash-purge")`);
    // Then: focus moves to 복원 of the item now in its place.
    expect(await until(view, `() => document.querySelectorAll(".trash-item").length === 2 && ${focusedTrashButton}`)).toBe("지운 조사 5 복원");
    // When: the trash is emptied.
    await press(view, "휴지통 비우기");
    // Then: no item is left to take focus, so it goes to main instead of the page.
    expect(await until(view, `() => document.querySelectorAll(".trash-item").length === 0 && document.activeElement?.id`)).toBe("main");
  });
}, 30_000);

test("a digest that fails to load says why in an alert", async () => {
  // Given: digests on, and the server failing to send the digest that is opened.
  await withApp({ digests: true }, 1312, 800, async view => {
    // When: the digest is opened by its address.
    await view.evaluate(`location.hash = "#/digest/${digestId}"`);
    // Then: the reason replaces the loading status in an alert, so a screen reader announces it.
    expect(await until(view, `() => document.querySelector(".reader-pane [role=alert]")?.textContent`)).toBe("요청을 처리하지 못했어요 (500).");
  });
}, 30_000);
