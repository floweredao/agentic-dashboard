export type View = "inbox" | "library" | "digest" | "work" | "more" | "archive" | "trash" | "channels" | "settings";
export const views: readonly View[] = ["inbox", "library", "digest", "work", "more", "archive", "trash", "channels", "settings"];
export const viewTitles: Record<View, string> = {
  inbox: "받은 항목", library: "기록", digest: "다이제스트", work: "할 일", more: "더보기", archive: "보관함", trash: "휴지통",
  channels: "채널 관리", settings: "알림 설정",
};
/** The screens under 더보기, in the order the phone's 더보기 and the desktop sidebar list them. */
export const moreViews = ["archive", "trash", "channels", "settings"] as const satisfies readonly View[];
/** The tab (bottom tab bar) that owns a view: the screens under 더보기 belong to it, every other view is its own tab. */
export const sectionOf = (view: View): View => (moreViews as readonly View[]).includes(view) ? "more" : view;
export type Params = Readonly<Record<string, string>>;
/** Committed screen state. The URL hash owns it: `#/<view>[/<recordId>][?key=value]`. */
export type Route = { readonly view: View; readonly id: string | null; readonly params: Params };

const legacy: Record<string, string> = {
  home: "#/inbox", mobile: "#/inbox", research: "#/library?type=research", social: "#/library?type=social",
  tasks: "#/work", projects: "#/work?show=projects", archive: "#/archive",
};
const isView = (value: string): value is View => (views as readonly string[]).includes(value);

/** Old single-word hashes (`#research`, `#home/queue`) map to their new location; anything else is null. */
export function legacyRedirect(hash: string): string | null {
  const match = /^#([a-z]+)(?:\/.*)?$/.exec(hash);
  return match?.[1] && !hash.startsWith("#/") ? legacy[match[1]] ?? null : null;
}

export function parseRoute(hash: string): Route {
  const [path = "", query = ""] = hash.replace(/^#\/?/, "").split("?");
  const [candidate = "", id = ""] = path.split("/");
  const params: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(query)) if (value !== "") params[key] = value;
  return { view: isView(candidate) ? candidate : "inbox", id: /^[0-9a-f-]{36}$/i.test(id) ? id : null, params };
}

export function formatRoute(route: Route): string {
  const query = new URLSearchParams(Object.entries(route.params).filter(([, value]) => value !== "")).toString();
  return `#/${route.view}${route.id ? `/${route.id}` : ""}${query ? `?${query}` : ""}`;
}

/**
 * What the app remembers in `history.state` for each entry: the hash this entry was opened from inside the app
 * (null when it was opened by address), and, for a reader opened from its list, the list entry's own `from`.
 */
export type Trail = { readonly from: string | null; readonly listFrom?: string | null };
/**
 * Where the back button goes. `steps` > 0 is that many history steps back (the same as the device's back gesture);
 * 0 replaces the entry with the parent screen, for a screen opened by address. `place` is where a desktop shows it.
 */
export type Back = { readonly hash: string; readonly steps: 0 | 1 | 2; readonly place: "list" | "reader" };

function listBack(view: View, from: string | null | undefined, phone: boolean): Back | null {
  if (sectionOf(view) === view) return null;
  if (from) return { hash: from, steps: 1, place: "list" };
  return phone ? { hash: formatRoute({ view: sectionOf(view), id: null, params: {} }), steps: 0, place: "list" } : null;
}

/**
 * The back button of a screen. Tab screens have none. A reader goes back to wherever it was opened from; opened by
 * address it goes up to its list on a phone (a desktop shows that list beside it). The screens under 더보기 go back to
 * wherever they were opened from, else up to 더보기 on a phone (a desktop sidebar lists them).
 */
export function backOf(route: Route, trail: Trail | null, phone: boolean): Back | null {
  const here = formatRoute(route);
  const from = trail?.from && trail.from !== here ? trail.from : null;
  if (!route.id) return listBack(route.view, from, phone);
  const list = formatRoute({ ...route, id: null });
  if (from && (phone || from !== list)) return { hash: from, steps: 1, place: "reader" };
  if (phone) return { hash: list, steps: 0, place: "reader" };
  // Desktop reader selected from the list beside it: the list's own back, one more step away.
  const outer = from ? listBack(route.view, trail?.listFrom, false) : null;
  return outer ? { ...outer, steps: 2 } : null;
}

/** The name on a back button: the screen it returns to, or 이전 기록 for another record. */
export function backLabel(hash: string): string {
  const route = parseRoute(hash);
  return route.id ? "이전 기록" : viewTitles[route.view];
}
