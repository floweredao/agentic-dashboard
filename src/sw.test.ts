import { expect, test } from "bun:test";

type Listener = (event: Record<string, unknown>) => void;
type Shown = { title: string; options: { body: string; tag: string; data: { url: string } } };

/** Runs public/sw.js against a stand-in worker scope and returns its listeners and what it did. */
async function worker(windows: { focus: () => Promise<unknown>; posted: unknown[] }[]) {
  const listeners = new Map<string, Listener>();
  const shown: Shown[] = [];
  const opened: string[] = [];
  const self = {
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    skipWaiting: () => undefined,
    registration: { showNotification: async (title: string, options: Shown["options"]) => { shown.push({ title, options }); } },
    clients: {
      claim: async () => undefined,
      matchAll: async () => windows.map(window => ({ focused: false, focus: window.focus, postMessage: (message: unknown) => window.posted.push(message) })),
      openWindow: async (url: string) => { opened.push(url); },
    },
  };
  new Function("self", await Bun.file(new URL("../public/sw.js", import.meta.url)).text())(self);
  const fire = async (type: string, event: Record<string, unknown>) => {
    let work: Promise<unknown> = Promise.resolve();
    listeners.get(type)?.({ ...event, waitUntil: (promise: Promise<unknown>) => { work = promise; } });
    await work;
  };
  return { fire, shown, opened };
}

test("a push shows its title and body and keeps the in-app address; a malformed one still shows a notification", async () => {
  const { fire, shown } = await worker([]);
  const payload = { kind: "briefing", title: "아침 브리핑 왔어요", body: "· 국내 첫 소식", url: "/#/briefing/abc", tag: "briefing-abc" };
  await fire("push", { data: { json: () => payload, text: () => JSON.stringify(payload) } });
  await fire("push", { data: { json: () => { throw new SyntaxError("bad"); }, text: () => "plain text" } });
  await fire("push", { data: { json: () => ({ title: "x", url: "https://evil.example/" }), text: () => "" } });
  expect(shown.map(item => [item.title, item.options.body, item.options.tag, item.options.data.url])).toEqual([
    ["아침 브리핑 왔어요", "· 국내 첫 소식", "briefing-abc", "/#/briefing/abc"],
    ["Agentic Dashboard", "plain text", "Agentic Dashboard", "/"],
    ["x", "", "Agentic Dashboard", "/"],
  ]);
});

test("a tap tells an open window where to go and brings it forward, or opens the app there", async () => {
  const open = { focus: async () => undefined, posted: [] as unknown[] };
  const withWindow = await worker([open]);
  const notification = { close: () => undefined, data: { url: "/#/work/t1" } };
  await withWindow.fire("notificationclick", { notification });
  expect(open.posted).toEqual([{ type: "agentic:open", url: "/#/work/t1" }]);
  expect(withWindow.opened).toEqual([]);
  const refusing = { focus: async () => { throw new Error("focus refused"); }, posted: [] as unknown[] };
  const iosLike = await worker([refusing]);
  await iosLike.fire("notificationclick", { notification });
  expect(iosLike.opened).toEqual(["/#/work/t1"]);
  const closed = await worker([]);
  await closed.fire("notificationclick", { notification });
  expect(closed.opened).toEqual(["/#/work/t1"]);
});
