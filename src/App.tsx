import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Archive, ArrowLeft, Bell, BriefcaseBusiness, Ellipsis, Inbox, Library, Menu, Newspaper, PanelLeftClose, PanelLeftOpen, Plus, RadioTower, RefreshCw, Trash2 } from "lucide-react";
import type { Comment, DashboardRecord, RecordInput, RecordKind, RecordPatch, TrashItem } from "../shared/contracts";
import { createComment, createRecord, deleteRecord, emptyTrash as emptyTrashApi, errorMessage, loadAgents, loadComments, loadDigests, loadRecords, loadTrash, logout as endSession, markDigest as markDigestApi, patchRecord, purgeRecord, recordInputSchema, restoreRecord, session } from "./api";
import type { DigestPage } from "./api";
import { syncPush } from "./push";
import { Empty, ChannelMark, DialogToast } from "./components/primitives";
import { ShareDialog } from "./components/ShareDialog";
import { MiniPlayer, useMiniPlayerShown } from "./components/playback";
import { DOCK_MIN, SPLIT_MIN, SidebarContext, WIDE_MIN, layoutOf, readDocked, useSidebarDrag, writeDocked } from "./components/sidebar";
import { config } from "./config";
import { isTypingTarget } from "./hooks";
import { formatClock, strings } from "./i18n";
import { addDays, aiFillRevert, blankRecord, channelOf, channelLabel, channelsFor, confirmationChanges, homeViewOf, inboxBadge, inboxStateOf, isRecord, listedFor, localDate, nextInQueue, partReadAt, revisitDue, setChannelKeys } from "./model";
import { backLabel, backOf, formatRoute, legacyRedirect, parseRoute, sectionOf, viewTitles } from "./router";
import type { Back, Route, Trail, View } from "./router";
import { DashboardContext } from "./state";
import type { Dashboard, Destination, ReviewState } from "./state";
import { ArchivePane } from "./views/Archive";
import { DigestPane, DigestReader, digestPart } from "./views/Digest";
import { ChannelsView, LoginDialog, OwnerGate } from "./views/Channels";
import { Compose } from "./views/Compose";
import { Editor } from "./views/Editor";
import { InboxPane } from "./views/Inbox";
import { LibraryPane } from "./views/Library";
import { MorePane } from "./views/More";
import { Reader } from "./views/Reader";
import { SettingsPane } from "./views/Settings";
import { TrashPane } from "./views/Trash";
import { WorkPane } from "./views/Work";

const text = strings({
  en: {
    synced: (time: string) => `Synced ${time}`,
    saved: "Saved.", undone: "Undone.", openedNext: " Opened the next item.", markedDone: "Marked as done.", confirmed: "Marked as reviewed.",
    restored: "Restored.", markedRead: "Marked as read.", markedUnread: "Marked as unread.", unstarred: "Removed from favorites.", starred: "Added to favorites.",
    markedPending: "Moved back to review.", revisitCleared: "Cleared the revisit date.", snoozed: "You'll see this again in 7 days.",
    archived: "Archived.", trashed: "Moved to the trash.",
    purgeConfirm: (title: string) => `Delete "${title}" permanently? This can't be undone.`, purged: "Deleted permanently.",
    emptyConfirm: "Empty the trash? Every item will be deleted permanently and this can't be undone.", emptied: "Emptied the trash.",
    aiReverted: "Restored the original title and summary.", followUp: (title: string) => `Follow-up: ${title}`, loggedOut: "Signed out.",
    undo: "Undo", close: "Close", skip: "Skip to content", loading: "Loading", mainMenu: "Main menu",
    compose: "New item", composeShortcut: "New item (C)", stored: "Storage", channels: "Channels", settings: "Settings",
    offline: "Offline · changes won't save", disconnected: "Not connected", refresh: "Refresh",
    showSidebar: "Show sidebar", hideSidebar: "Hide sidebar", showSidebarShortcut: "Show sidebar (⌘\\)", hideSidebarShortcut: "Hide sidebar (⌘\\)",
    digestList: "Digest list", detail: "Details", pickDigest: "Pick a digest from the list to read it here",
    list: (title: string) => `${title} list`, notFound: "Item not found", pickItem: "Pick an item from the list to read it here",
    count: (count: number) => `${count} ${count === 1 ? "item" : "items"}`,
    demo: "Demo", demoNotice: "A read-only demo with sample data. Look around freely; changes aren't saved.",
  },
  ko: {
    synced: (time: string) => `동기화 ${time}`,
    saved: "저장했어요.", undone: "되돌렸어요.", openedNext: " 다음 항목을 열었어요.", markedDone: "완료로 표시했어요.", confirmed: "확인했어요.",
    restored: "복원했어요.", markedRead: "읽음으로 표시했어요.", markedUnread: "안 읽음으로 표시했어요.", unstarred: "즐겨찾기에서 뺐어요.", starred: "즐겨찾기에 넣었어요.",
    markedPending: "미확인으로 바꿨어요.", revisitCleared: "다시 볼 날을 지웠어요.", snoozed: "7일 뒤에 다시 보여 드릴게요.",
    archived: "보관했어요.", trashed: "휴지통으로 옮겼어요.",
    purgeConfirm: (title: string) => `"${title}" 항목을 영구 삭제할까요? 되돌릴 수 없어요.`, purged: "영구 삭제했어요.",
    emptyConfirm: "휴지통을 비울까요? 모든 항목이 영구 삭제되고 되돌릴 수 없어요.", emptied: "휴지통을 비웠어요.",
    aiReverted: "원래 제목과 요약으로 되돌렸어요.", followUp: (title: string) => `${title} 후속 할 일`, loggedOut: "로그아웃했어요.",
    undo: "되돌리기", close: "닫기", skip: "본문으로 바로가기", loading: "불러오는 중", mainMenu: "주 메뉴",
    compose: "새로 저장", composeShortcut: "새로 저장 (C)", stored: "보관", channels: "채널", settings: "설정",
    offline: "오프라인 · 저장되지 않아요", disconnected: "연결 안 됨", refresh: "새로고침",
    showSidebar: "사이드바 보기", hideSidebar: "사이드바 숨기기", showSidebarShortcut: "사이드바 보기 (⌘\\)", hideSidebarShortcut: "사이드바 숨기기 (⌘\\)",
    digestList: "다이제스트 목록", detail: "상세", pickDigest: "목록에서 다이제스트를 고르면 여기에 보여요",
    list: (title: string) => `${title} 목록`, notFound: "항목을 찾을 수 없음", pickItem: "목록에서 항목을 고르면 여기에 보여요",
    count: (count: number) => `${count}건`,
    demo: "데모", demoNotice: "예시 데이터로 채운 읽기 전용 데모예요. 마음껏 둘러보세요. 바꾼 내용은 저장되지 않아요.",
  },
});

const icons: Record<View, typeof Inbox> = {
  inbox: Inbox, library: Library, digest: Newspaper, work: BriefcaseBusiness, more: Ellipsis, archive: Archive, trash: Trash2, channels: RadioTower,
  settings: Bell,
};
/** The tab screens in the order of the phone's tab bar and the top of the desktop sidebar (More is the sidebar's lower groups). Digest only when it is on. */
const tabViews = (): readonly View[] => config.features.digest ? ["inbox", "library", "digest", "work"] : ["inbox", "library", "work"];
/** Views that fill the workspace alone, with no reader pane beside them. */
const singlePane = (view: View) => view === "channels" || view === "trash" || view === "more" || view === "settings";
/** The app's own part of `history.state` (anything else, such as a state from an older build, reads as opened by address). */
const trailOf = (state: unknown): Trail => {
  const value = state && typeof state === "object" ? state as Record<string, unknown> : {};
  return { from: typeof value.from === "string" ? value.from : null, listFrom: typeof value.listFrom === "string" ? value.listFrom : null };
};
type Modal =
  | { readonly mode: "login" }
  | { readonly mode: "compose"; readonly kind: RecordKind }
  | { readonly mode: "editor"; readonly input: RecordInput; readonly existing?: DashboardRecord; readonly requestId: string }
  | { readonly mode: "share"; readonly record: DashboardRecord }
  | null;
type Toast = { readonly message: string; readonly tone: "info" | "error"; readonly key: number; readonly undo?: () => void };
const phone = () => window.matchMedia("(max-width: 767px)").matches;

function inputOf(record: DashboardRecord): RecordInput {
  const { kind, title, body, status, projectId, taskId, dueDate, tags, links, fields } = record;
  return { kind, title, body, status, projectId, taskId, dueDate, tags, links, fields };
}
const syncLabel = (date: Date | null) => date ? text().synced(formatClock(date)) : "";
/**
 * Records, the trash, timelines, digests (when on) and agents together. All but the records are secondary: a failure
 * there goes to `report` and never hides the records.
 */
async function loadAll(report: (cause: unknown) => void) {
  const secondary = <T,>(load: Promise<T>) => load.catch((cause: unknown) => { report(cause); return null; });
  const [items, trashed, comments, digests, agents] = await Promise.all([loadRecords(), secondary(loadTrash()), secondary(loadComments()),
    config.features.digest ? secondary(loadDigests()) : Promise.resolve(null), secondary(loadAgents())]);
  return { items, trashed, comments, digests, agents };
}

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash));
  const [records, setRecords] = useState<DashboardRecord[]>([]);
  const [trash, setTrash] = useState<TrashItem[]>([]);
  const [comments, setComments] = useState<Comment[]>([]);
  const [digests, setDigests] = useState<DigestPage | null>(null);
  const [digestReads, setDigestReads] = useState<ReadonlyMap<string, string | null>>(new Map());
  const [agents, setAgents] = useState<readonly string[]>([]);
  const [csrf, setCsrf] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [syncedAt, setSyncedAt] = useState<Date | null>(null);
  const [offline, setOffline] = useState(() => !navigator.onLine);
  const [narrow, setNarrow] = useState(phone);
  const [layout, setLayout] = useState(() => layoutOf(window.innerWidth));
  /** Wide windows only: the owner's choice to unfold the sidebar beside the panes (remembered on this device); null follows the width. */
  const [dockChoice, setDockChoice] = useState(() => readDocked(localStorage));
  const [roomy, setRoomy] = useState(() => window.innerWidth >= DOCK_MIN);
  const docked = dockChoice ?? roomy;
  /** Narrower windows: whether the sidebar lies over the panes. It never survives a resize, a navigation or a dialog. */
  const [drawer, setDrawer] = useState(false);
  /** The hash of the entry the app was on, stamped as `from` on the next entry a link pushes. */
  const lastHash = useRef(location.hash);
  /** Phone list scroll offsets by list hash, restored when the reader goes back to that list. */
  const listScroll = useRef(new Map<string, number>());
  /** Ids whose quiet confirmation (markRead) is in flight, so a repeated open of the same record cannot send a second PATCH. */
  const reading = useRef(new Set<string>());
  const latest = useRef({ route, records, csrf });
  latest.current = { route, records, csrf };
  const connected = csrf !== "";

  const notify = useCallback((message: string, tone: "info" | "error" = "info") => setToast({ message, tone, key: Date.now() }), []);
  const replace = useCallback((record: DashboardRecord) => setRecords(items =>
    items.some(item => item.id === record.id) ? items.map(item => item.id === record.id ? record : item) : [record, ...items]), []);
  const current = (record: DashboardRecord) => latest.current.records.find(item => item.id === record.id) ?? record;

  const navigate = useCallback((to: Destination, options?: { readonly replace?: boolean }) => {
    const hash = formatRoute({ view: to.view, id: to.id ?? null, params: to.params ?? {} });
    if (options?.replace) { history.replaceState(history.state, "", hash); setRoute(parseRoute(hash)); }
    else if (location.hash !== hash) location.hash = hash;
  }, []);

  const report = useCallback(async (cause: unknown) => notify(await errorMessage(cause), "error"), [notify]);
  /** A failed secondary load (null) keeps the last one. */
  const store = useCallback(({ items, trashed, comments: entries, digests: page, agents: names }: Awaited<ReturnType<typeof loadAll>>) => {
    setRecords(items); if (trashed) setTrash(trashed); if (entries) setComments(entries); if (names) setAgents(names);
    if (page) { setDigests(page); setDigestReads(new Map()); }
    setSyncedAt(new Date());
  }, []);

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try { store(await loadAll(silent ? () => undefined : report)); }
    catch (cause) { if (!navigator.onLine) setOffline(true); if (!silent) await report(cause); }
    finally { if (!silent) setLoading(false); }
  }, [report, store]);

  useEffect(() => {
    history.scrollRestoration = "manual";
    const redirect = legacyRedirect(location.hash);
    if (redirect) { history.replaceState(null, "", redirect); setRoute(parseRoute(redirect)); }
    // Mark the entry the app was opened on, so coming back to it later is never taken for a newly pushed one.
    if (history.state === null) history.replaceState({ from: null }, "");
    const changed = () => {
      // A link or an address-bar edit pushed a new entry: remember where it was opened from.
      if (history.state === null) history.replaceState({ from: lastHash.current }, "");
      setRoute(parseRoute(location.hash));
    };
    window.addEventListener("hashchange", changed);
    const media = window.matchMedia("(max-width: 767px)");
    const resized = () => setNarrow(media.matches);
    media.addEventListener("change", resized);
    let mounted = true;
    session().then(async auth => {
      const loaded = await loadAll(cause => { if (mounted) void report(cause); });
      if (mounted) { setCsrf(auth.csrfToken); store(loaded); if (config.features.demo) notify(text().demoNotice); }
    }).catch(() => undefined).finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; window.removeEventListener("hashchange", changed); media.removeEventListener("change", resized); };
  }, []);

  useEffect(() => {
    if (!connected) return;
    const tick = () => { if (document.visibilityState === "visible") void refresh(true); };
    const timer = window.setInterval(tick, 60_000);
    document.addEventListener("visibilitychange", tick);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", tick); };
  }, [connected, refresh]);

  useEffect(() => {
    const down = () => setOffline(true);
    const up = () => { setOffline(false); if (latest.current.csrf) void refresh(true); };
    window.addEventListener("offline", down);
    window.addEventListener("online", up);
    return () => { window.removeEventListener("offline", down); window.removeEventListener("online", up); };
  }, [refresh]);

  useEffect(() => {
    const queries = [SPLIT_MIN, WIDE_MIN, DOCK_MIN].map(width => window.matchMedia(`(min-width: ${width}px)`));
    const refit = () => { setLayout(layoutOf(window.innerWidth)); setRoomy(window.innerWidth >= DOCK_MIN); };
    for (const query of queries) query.addEventListener("change", refit);
    return () => { for (const query of queries) query.removeEventListener("change", refit); };
  }, []);
  const sidebar: "docked" | "open" | "hidden" = layout === "wide" && docked ? "docked" : drawer ? "open" : "hidden";
  const showSidebar = useCallback(() => {
    if (layout !== "wide") { setDrawer(true); return; }
    setDockChoice(true); writeDocked(localStorage, true);
  }, [layout]);
  const hideSidebar = useCallback(() => {
    setDrawer(false);
    if (layout === "wide") { setDockChoice(false); writeDocked(localStorage, false); }
  }, [layout]);
  const toggleSidebar = sidebar === "hidden" ? showSidebar : hideSidebar;
  const sidebarState = useMemo(() => ({ state: sidebar, show: showSidebar }), [sidebar, showSidebar]);
  useSidebarDrag({ enabled: true, open: sidebar !== "hidden", onOpen: showSidebar, onClose: hideSidebar });
  // Focus follows the control that can act next: into the sidebar when it appears, back to the opener (the list head's,
  // or the phone app bar's menu button) when it goes.
  const shownBefore = useRef(sidebar);
  useLayoutEffect(() => {
    if (shownBefore.current === sidebar) return;
    shownBefore.current = sidebar;
    const active = document.activeElement;
    const panel = document.getElementById("sidebar");
    // WebKit does not focus a clicked button; the click lands focus on the nearest focusable ancestor (main) instead.
    const lost = !active || active === document.body || active.id === "main";
    const opener = [...document.querySelectorAll<HTMLElement>(".sidebar-open, .appbar-menu")]
      .find(element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden");
    if (sidebar === "hidden") { if (lost || panel?.contains(active)) opener?.focus(); }
    else if (sidebar === "open" || lost || active?.matches(".appbar-menu, .sidebar-open")) document.querySelector<HTMLElement>(".sidebar-toggle")?.focus();
  }, [sidebar]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (document.querySelector("dialog[open]")) return;
      if (event.key === "Escape" && sidebar === "open") { event.preventDefault(); hideSidebar(); }
      else if (event.code === "Backslash" && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) { event.preventDefault(); toggleSidebar(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sidebar, hideSidebar, toggleSidebar]);

  // Phone: the window scrolls, so a reader starts at its title and a list comes back where it was left.
  const routeKey = formatRoute(route);
  // A drawer closes once it has done its job (a destination was chosen or a dialog opened) and when the window changes layout.
  useEffect(() => { setDrawer(false); }, [routeKey, modal, layout]);
  useEffect(() => { lastHash.current = location.hash; }, [routeKey]);
  useLayoutEffect(() => {
    if (!phone() || document.body.style.position === "fixed") return;
    if (route.id) window.scrollTo(0, 0);
    else window.scrollTo(0, listScroll.current.get(routeKey) ?? 0);
  }, [routeKey, route.id]);

  // Desktop deep link: once records arrive, centre the selected row so its neighbours show too.
  const revealed = useRef(false);
  useEffect(() => {
    if (revealed.current || !records.length) return;
    revealed.current = true;
    const id = latest.current.route.id;
    if (id && !phone()) document.getElementById(`row-${id}`)?.scrollIntoView({ block: "center" });
  }, [records.length]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), toast.undo ? 6000 : 4000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // The digest list hidden while digests are off sends its address to the inbox.
  useEffect(() => { if (route.view === "digest" && !config.features.digest) navigate({ view: "inbox" }, { replace: true }); }, [route.view, navigate]);

  // Pending records; unread digests count on the Digest tab.
  const inbox = useMemo(() => inboxBadge(records), [records]);
  useEffect(() => {
    document.title = `${config.appName} · ${viewTitles[route.view]}${inbox ? ` (${inbox})` : ""}`;
  }, [route.view, inbox]);

  // history.state changes only together with the route (every navigation sets a new route object), so the route keys this.
  const back: Back | null = useMemo(() => connected ? backOf(route, trailOf(history.state), narrow) : null, [connected, route, narrow]);
  const dashboard: Dashboard = useMemo(() => {
    const byId = new Map(records.map(record => [record.id, record]));
    /** undo: the changes that put the saved record back, offered as Undo in the toast. */
    const patch = async (record: DashboardRecord, changes: RecordPatch["changes"], message = text().saved, undo?: RecordPatch["changes"]) => {
      setBusy(true);
      setToast(null);
      try {
        const saved = await patchRecord(current(record), changes, latest.current.csrf);
        replace(saved);
        setToast({ message, tone: "info", key: Date.now(), ...(undo ? { undo: () => { void patch(saved, undo, text().undone); } } : {}) });
        return saved;
      } catch (cause) { if (!navigator.onLine) setOffline(true); notify(await errorMessage(cause), "error"); return null; }
      finally { setBusy(false); }
    };
    const open = (id: string, extra: Readonly<Record<string, string | null>> = {}) => {
      const { route: now } = latest.current;
      const list = formatRoute({ view: now.view, id: null, params: now.params });
      const params: Record<string, string> = { ...now.params };
      for (const [key, value] of Object.entries(extra)) { if (value) params[key] = value; else delete params[key]; }
      // Moving from one open item to another keeps one history entry, so back still leads out of the reader.
      if (now.id) { navigate({ view: now.view, id, params }, { replace: true }); return; }
      if (phone()) listScroll.current.set(list, window.scrollY);
      const listFrom = trailOf(history.state).from;
      navigate({ view: now.view, id, params });
      history.replaceState({ from: list, listFrom }, "", location.hash);
    };
    const select = (record: DashboardRecord | null) => {
      const { route: now } = latest.current;
      const list = formatRoute({ view: now.view, id: null, params: now.params });
      if (record) { open(record.id); return; }
      // Going back from a reader opened from this list is the same as the device's back gesture.
      if (trailOf(history.state).from === list) history.back();
      else navigate({ view: now.view, id: null, params: now.params }, { replace: true });
    };
    /**
     * When the open inbox item leaves the pending queue, the reader moves to its neighbour (and the toast says so). `leaves` is false when the change keeps it queued.
     * Under the all/approved filters a review change keeps the item listed, so the reader stays.
     */
    const leaveQueue = async (record: DashboardRecord, run: (moved: string) => Promise<DashboardRecord | null>, leaves = true) => {
      const { route: now, records: all } = latest.current;
      // listedFor keeps the open item in the inbox after its quiet confirmation, so it still advances from there.
      const queue = listedFor(now, all);
      const advances = leaves && now.view === "inbox" && inboxStateOf(now.params) === "pending"
        && now.id === record.id && queue.some(item => item.id === record.id);
      const next = advances ? nextInQueue(queue, record.id) : null;
      const saved = await run(next ? text().openedNext : "");
      if (saved && advances) navigate({ view: "inbox", id: next?.id ?? null, params: now.params }, { replace: true });
    };
    const confirm = async (record: DashboardRecord) => {
      if (record.kind === "task") { await leaveQueue(record, moved => patch(record, { status: "done" }, text().markedDone + moved)); return; }
      const changes = confirmationChanges(current(record));
      // While the quiet confirmation of this record is still in flight, a second PATCH would only conflict with it.
      if (!changes || reading.current.has(record.id)) return;
      await leaveQueue(record, moved => patch(record, changes, text().confirmed + moved), !revisitDue(current(record)));
    };
    const create = async (input: RecordInput, requestId: string, review?: ReviewState) => {
      setToast(null);
      let saved = await createRecord(input, latest.current.csrf, requestId);
      if (isRecord(input) && review && saved.reviewState !== review) saved = await patchRecord(saved, { reviewState: review }, latest.current.csrf);
      replace(saved); setModal(null); notify(text().saved);
      navigate({ view: homeViewOf(saved), id: saved.id });
      return saved;
    };
    const editDraft = (input: RecordInput) => { setToast(null); setModal({ mode: "editor", input, requestId: crypto.randomUUID() }); };
    const restoreById = async (id: string) => {
      setBusy(true);
      setToast(null);
      try {
        replace(await restoreRecord(id, latest.current.csrf));
        setTrash(items => items.filter(item => item.record.id !== id));
        notify(text().restored);
        // The silent refresh started by the delete may still be in flight; this one settles both lists on the server's state.
        void refresh(true);
      } catch (cause) { if (!navigator.onLine) setOffline(true); notify(await errorMessage(cause), "error"); }
      finally { setBusy(false); }
    };
    return {
      records, byId, trash, comments, connected, csrfToken: csrf, loading, busy, route, back, navigate, select, open, patch, confirm, create, editDraft, notify,
      digests, digestReads,
      markDigest: async (id, part, read, quiet = false) => {
        if (quiet && config.features.demo) return;
        try {
          const saved = await markDigestApi(id, part, read, latest.current.csrf);
          const key = `${id}:${part}`;
          const before = digests?.items.find(item => item.id === id);
          const wasUnread = digestReads.has(key) ? digestReads.get(key) === null : before ? partReadAt(before, part) === null : !read;
          const unread = partReadAt(saved, part) === null;
          setDigestReads(reads => new Map(reads).set(key, partReadAt(saved, part)));
          const step = unread === wasUnread ? 0 : unread ? 1 : -1;
          if (step) setDigests(page => page && { ...page, unread: Math.max(0, page.unread + step),
            parts: { ...page.parts, [part]: { ...page.parts[part], unread: Math.max(0, page.parts[part].unread + step) } } });
          if (!quiet) notify(read ? text().markedRead : text().markedUnread);
        } catch (cause) { if (!navigator.onLine) setOffline(true); notify(await errorMessage(cause), "error"); }
      },
      addComment: async (record, body) => {
        setBusy(true);
        setToast(null);
        try {
          const saved = await createComment(record.id, body, crypto.randomUUID(), latest.current.csrf);
          setComments(items => [...items, saved]);
          return true;
        } catch (cause) { if (!navigator.onLine) setOffline(true); notify(await errorMessage(cause), "error"); return false; }
        finally { setBusy(false); }
      },
      goBack: () => {
        if (!back) return;
        if (back.steps > 0) { history.go(-back.steps); return; }
        const parent = parseRoute(back.hash);
        navigate({ view: parent.view, id: parent.id, params: parent.params }, { replace: true });
      },
      setParams: (params, options) => {
        const now = latest.current.route;
        const merged: Record<string, string> = { ...now.params };
        for (const [key, value] of Object.entries(params)) { if (value) merged[key] = value; else delete merged[key]; }
        navigate({ view: now.view, id: now.id, params: merged }, options);
      },
      toggleStar: async record => { await patch(record, { fields: { ...current(record).fields, starred: current(record).fields.starred !== true } }, current(record).fields.starred === true ? text().unstarred : text().starred); },
      markPending: async record => { await patch(record, { reviewState: "pending" }, text().markedPending, { reviewState: "approved" }); },
      markRead: async record => {
        const now = current(record);
        // A read-only demo keeps its records unread instead of failing a save on every open.
        if (config.features.demo || !isRecord(now) || now.reviewState !== "pending" || reading.current.has(now.id)) return;
        reading.current.add(now.id);
        try { replace(await patchRecord(now, { reviewState: "approved" }, latest.current.csrf)); }
        catch (cause) { if (!navigator.onLine) setOffline(true); notify(await errorMessage(cause), "error"); }
        finally { reading.current.delete(now.id); }
      },
      clearRevisit: async record => {
        const before = current(record);
        await leaveQueue(record, moved => patch(record, { fields: { ...before.fields, revisitDate: null } }, text().revisitCleared + moved,
          { fields: before.fields }), before.reviewState !== "pending");
      },
      snooze: async record => {
        const before = current(record);
        await leaveQueue(record, moved => patch(record, { reviewState: "approved", fields: { ...before.fields, revisitDate: addDays(localDate(), 7) } },
          text().snoozed + moved, { reviewState: before.reviewState, fields: before.fields }));
      },
      toggleArchive: async record => {
        const archived = current(record).archivedAt !== null;
        if (archived) { await patch(record, { archived: false }, text().restored); return; }
        // Archiving the open record goes back to the list it was opened from, not on to another record.
        const open = latest.current.route.id === record.id;
        const saved = await patch(record, { archived: true }, text().archived, { archived: false });
        if (saved && open) select(null);
      },
      remove: async record => {
        setBusy(true);
        setToast(null);
        try {
          // Deleting the open record goes back to the list it was opened from, not on to another record.
          const open = latest.current.route.id === record.id;
          await deleteRecord(current(record), latest.current.csrf);
          setRecords(items => items.filter(item => item.id !== record.id));
          // Records that referenced it were detached and got new versions on the server, and the trash has a new item.
          void refresh(true);
          if (open) select(null);
          setToast({ message: text().trashed, tone: "info", key: Date.now(), undo: () => { void restoreById(record.id); } });
        } catch (cause) { if (!navigator.onLine) setOffline(true); notify(await errorMessage(cause), "error"); }
        finally { setBusy(false); }
      },
      restore: item => restoreById(item.record.id),
      purge: async item => {
        if (!window.confirm(text().purgeConfirm(item.record.title))) return;
        setBusy(true);
        setToast(null);
        try {
          await purgeRecord(item.record.id, latest.current.csrf);
          setTrash(items => items.filter(entry => entry.record.id !== item.record.id));
          notify(text().purged);
        } catch (cause) { if (!navigator.onLine) setOffline(true); notify(await errorMessage(cause), "error"); }
        finally { setBusy(false); }
      },
      emptyTrash: async () => {
        if (!window.confirm(text().emptyConfirm)) return;
        setBusy(true);
        setToast(null);
        try {
          await emptyTrashApi(latest.current.csrf);
          setTrash([]);
          notify(text().emptied);
        } catch (cause) { if (!navigator.onLine) setOffline(true); notify(await errorMessage(cause), "error"); }
        finally { setBusy(false); }
      },
      revertAiFill: async record => { const changes = aiFillRevert(current(record)); if (changes) await patch(record, changes, text().aiReverted); },
      update: async (record, input, review) => {
        setToast(null);
        const { kind: _kind, ...changes } = input;
        const saved = await patchRecord(current(record), { ...changes, ...(isRecord(input) && review ? { reviewState: review } : {}) }, latest.current.csrf);
        replace(saved); setModal(null); notify(text().saved);
        return saved;
      },
      compose: (kind = "social") => { setToast(null); if (!latest.current.csrf) setModal({ mode: "login" }); else setModal({ mode: "compose", kind }); },
      edit: record => { setToast(null); setModal({ mode: "editor", input: inputOf(current(record)), existing: current(record), requestId: crypto.randomUUID() }); },
      share: record => { setToast(null); setModal({ mode: "share", record: current(record) }); },
      followUp: record => {
        const task = blankRecord("task");
        editDraft({ ...task, title: text().followUp(record.title).slice(0, 200), projectId: record.projectId,
          fields: { ...task.fields, evidenceIds: [record.id], taskType: record.projectId ? "project" : "general" } });
      },
      refresh: () => refresh(),
      requestLogin: () => setModal({ mode: "login" }),
      login: async token => {
        const auth = await session(token);
        setCsrf(auth.csrfToken); store(await loadAll(report)); setModal(null);
      },
      logout: async () => { await endSession(latest.current.csrf); setCsrf(""); setRecords([]); setTrash([]); setComments([]); setDigests(null); setAgents([]); navigate({ view: "inbox" }); notify(text().loggedOut); },
      importJson: async text => create(recordInputSchema.parse(JSON.parse(text)), crypto.randomUUID()),
    };
  }, [records, trash, comments, digests, digestReads, connected, csrf, loading, busy, route, back, navigate, notify, refresh, replace, report, store]);

  // A tapped notification in an open window: go to the screen it names, as a new history entry.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const opened = (event: MessageEvent) => {
      const data: unknown = event.data;
      if (!data || typeof data !== "object" || (data as { type?: unknown }).type !== "agentic:open") return;
      const url = (data as { url?: unknown }).url;
      if (typeof url === "string" && url.startsWith("/")) location.hash = new URL(url, location.origin).hash;
    };
    navigator.serviceWorker.addEventListener("message", opened);
    return () => navigator.serviceWorker.removeEventListener("message", opened);
  }, []);
  // A subscribed device hands its subscription back on each sign-in, so a server that lost it gets it again.
  useEffect(() => { if (csrf) syncPush(csrf).catch(() => undefined); }, [csrf]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target) || document.querySelector("dialog[open]")) return;
      if (event.key === "c" || event.key === "n") { event.preventDefault(); dashboard.compose(); }
      else if (event.key === "/") {
        const search = document.querySelector<HTMLInputElement>("[data-search]");
        if (search) { event.preventDefault(); search.focus(); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dashboard]);

  const selected = route.id ? dashboard.byId.get(route.id) : undefined;
  const hasDetail = connected && !singlePane(route.view) && route.id !== null;
  const counts: Record<View, number> = {
    inbox,
    library: records.filter(record => isRecord(record) && !record.archivedAt).length,
    archive: records.filter(record => record.archivedAt !== null).length,
    work: records.filter(record => record.kind === "task" && !record.archivedAt && record.status !== "done").length,
    more: 0,
    channels: 0,
    trash: trash.length,
    digest: digests?.unread ?? 0,
    settings: 0,
  };
  const t = text();
  // Agents and record sources make the channel list; set before the views below read it.
  const channels = useMemo(() => channelsFor(agents, records), [agents, records]);
  setChannelKeys(channels);
  const link = (view: View) => formatRoute({ view, id: null, params: {} });
  const title = viewTitles[route.view];
  const navItem = (view: View) => {
    const Icon = icons[view];
    return <li key={view}><a className="nav-item" href={link(view)} title={viewTitles[view]} aria-current={route.view === view ? "page" : undefined}>
      <Icon size={18} aria-hidden="true" /><span className="nav-label">{viewTitles[view]}</span>
      {connected && counts[view] > 0 && <span className={`nav-count${view === "inbox" || view === "digest" ? " strong" : ""}`}>{counts[view]}</span>}
    </a></li>;
  };
  const locked = !connected && !loading;
  const mini = useMiniPlayerShown() && connected;
  const demoBadge = config.features.demo && <span className="demo-badge" title={t.demoNotice}>{t.demo}</span>;
  // The sidebar foot has room to name the release the demo runs; the phone app bar keeps the short badge beside the app name.
  const demoReleaseBadge = config.features.demo && <span className="demo-badge" title={t.demoNotice}>{config.version ? `${t.demo} · v${config.version}` : t.demo}</span>;
  const toastView = toast && <div key={toast.key} className={`toast ${toast.tone}`} role={toast.tone === "error" ? "alert" : "status"}>
    <span>{toast.message}</span>
    {toast.undo && <button type="button" className="toast-action" onClick={() => { const undo = toast.undo; setToast(null); undo?.(); }}>{t.undo}</button>}
    <button type="button" onClick={() => setToast(null)}>{t.close}</button>
  </div>;

  return <DashboardContext.Provider value={dashboard}><SidebarContext.Provider value={sidebarState}>
    <a href="#main" className="skip-link" onClick={event => { event.preventDefault(); document.getElementById("main")?.focus(); }}>{t.skip}</a>
    {loading && <div className="loading-line" role="status" aria-label={t.loading} />}
    <div className={`app view-${route.view}${hasDetail ? " has-detail" : ""}${back ? " has-back" : ""}${locked ? " locked" : ""}${mini ? " has-mini" : ""}`} data-sidebar={sidebar}>
      <nav id="sidebar" className="sidebar" aria-label={t.mainMenu} inert={sidebar === "hidden"}>
        <div className="sidebar-head">
          <a className="brand" href={link("inbox")}><img src="/brand-mark.png" alt="" width={26} height={26} /><span className="brand-name">{config.appName}</span></a>
          <button type="button" className="icon-btn sidebar-toggle" onClick={hideSidebar} aria-label={t.hideSidebar} title={t.hideSidebarShortcut}
            aria-controls="sidebar" aria-expanded={sidebar !== "hidden"}><PanelLeftClose size={18} aria-hidden="true" /></button>
        </div>
        <button type="button" className="btn btn-primary compose-btn" onClick={() => dashboard.compose()} aria-label={t.compose} title={t.composeShortcut}><Plus size={17} aria-hidden="true" /><span>{t.compose}</span></button>
        <ul className="nav-list">{tabViews().map(navItem)}</ul>
        {connected && <>
          <p className="nav-section">{t.stored}</p>
          <ul className="nav-list">{navItem("archive")}{navItem("trash")}</ul>
          <p className="nav-section">{t.channels}</p>
          <ul className="nav-list">{navItem("channels")}</ul>
          <p className="nav-section">{t.settings}</p>
          <ul className="nav-list">{navItem("settings")}</ul>
          <ul className="nav-list channel-nav">{channels.map(channel => {
            const total = records.filter(record => isRecord(record) && !record.archivedAt && channelOf(record) === channel).length;
            const active = route.view === "library" && route.params.channel === channel;
            return <li key={channel}><a className="nav-item" href={formatRoute({ view: "library", id: null, params: { channel } })} aria-current={active ? "page" : undefined}>
              <ChannelMark channel={channel} size="tile" /><span className="nav-label">{channelLabel(channel)}</span>{total > 0 && <span className="nav-count">{total}</span>}
            </a></li>;
          })}</ul>
        </>}
        <div className="sidebar-foot">
          {demoReleaseBadge}
          <span className={`status${offline ? " offline" : ""}`} role="status">{offline ? t.offline : connected ? syncLabel(syncedAt) : t.disconnected}</span>
          {connected && <button type="button" className="icon-btn" onClick={() => { void refresh(); }} disabled={loading} aria-label={t.refresh} title={t.refresh}><RefreshCw size={16} aria-hidden="true" /></button>}
        </div>
      </nav>
      <div className="sidebar-scrim" aria-hidden="true" onClick={hideSidebar} />

      <header className="appbar" inert={sidebar !== "hidden"}>
        <button type="button" className="icon-btn appbar-menu" onClick={showSidebar} aria-label={t.showSidebar} title={t.showSidebarShortcut}
          aria-controls="sidebar" aria-expanded={sidebar !== "hidden"}>{layout === "phone" ? <Menu size={20} aria-hidden="true" /> : <PanelLeftOpen size={18} aria-hidden="true" />}</button>
        {back && <button type="button" className="btn appbar-back" onClick={dashboard.goBack}><ArrowLeft size={18} aria-hidden="true" />{backLabel(back.hash)}</button>}
        <a className="brand" href={link("inbox")}><img src="/brand-mark.png" alt="" width={26} height={26} /><span className="brand-name">{config.appName}</span>{demoBadge}</a>
        {connected && <button type="button" className="icon-btn appbar-compose" onClick={() => dashboard.compose()} aria-label={t.compose} title={t.compose}><Plus size={20} aria-hidden="true" /></button>}
        {connected && <button type="button" className="icon-btn" onClick={() => { void refresh(); }} disabled={loading} aria-label={t.refresh}><RefreshCw size={18} aria-hidden="true" /></button>}
      </header>

      <main id="main" tabIndex={-1} inert={sidebar === "open"} className={`workspace${!connected || singlePane(route.view) ? " single" : ""}`}>
        {!connected ? loading ? null : <section className="pane">
          <OwnerGate onToken={() => setModal({ mode: "login" })} />
        </section>
          : route.view === "more" ? <section className="pane" aria-label={title}><MorePane /></section>
          : route.view === "channels" ? <section className="pane" aria-label={title}><ChannelsView /></section>
          : route.view === "trash" ? <section className="pane" aria-label={title}><TrashPane /></section>
          : route.view === "settings" ? <section className="pane" aria-label={title}><SettingsPane /></section>
          : route.view === "digest" ? <>
            <section className="pane list-pane" aria-label={t.digestList}><DigestPane /></section>
            <section className="pane reader-pane" aria-label={t.detail}>
              {route.id ? <DigestReader key={`${route.id}:${digestPart(route.params)}`} id={route.id} part={digestPart(route.params)} />
                : <div className="reader-empty"><Empty icon={<Newspaper size={20} aria-hidden="true" />}>{t.pickDigest}</Empty></div>}
            </section>
          </>
            : <>
              <section className="pane list-pane" aria-label={t.list(title)}>
                {route.view === "inbox" && <InboxPane />}
                {route.view === "library" && <LibraryPane />}
                {route.view === "archive" && <ArchivePane />}
                {route.view === "work" && <WorkPane />}
              </section>
              <section className="pane reader-pane" aria-label={t.detail}>
                {selected ? <Reader key={selected.id} record={selected} />
                  : <div className="reader-empty"><Empty>{route.id ? t.notFound : t.pickItem}</Empty></div>}
              </section>
            </>}
      </main>

      <nav className="tabbar" aria-label={t.mainMenu} inert={sidebar === "open"}>
        {tabViews().filter(view => view !== "work").map(view => <TabLink key={view} view={view} current={route.view}
          count={connected && (view === "inbox" || view === "digest") ? counts[view] : 0} />)}
        {(["work", "more"] as const).map(view => <TabLink key={view} view={view} current={route.view}
          count={view === "work" && connected ? records.filter(record => record.kind === "task" && !record.archivedAt && record.status === "review").length : 0} />)}
      </nav>
      {connected && <MiniPlayer />}
    </div>

    <DialogToast.Provider value={modal ? toastView : null}>
      {modal?.mode === "login" && <LoginDialog onClose={() => setModal(null)} />}
      {modal?.mode === "compose" && <Compose kind={modal.kind} onClose={() => setModal(null)} />}
      {modal?.mode === "editor" && <Editor key={modal.requestId} initial={modal.input} requestId={modal.requestId} onClose={() => setModal(null)} {...(modal.existing ? { existing: modal.existing } : {})} />}
      {modal?.mode === "share" && <ShareDialog record={modal.record} csrfToken={csrf} onClose={() => setModal(null)} />}
    </DialogToast.Provider>
    {!modal && toastView}
  </SidebarContext.Provider></DashboardContext.Provider>;
}

/** A tab is current on its own screen (page) and on the screens under it (true: archive, trash, channels and settings under More). */
function TabLink({ view, current, count }: { readonly view: View; readonly current: View; readonly count: number }) {
  const Icon = icons[view];
  return <a className="tab" href={formatRoute({ view, id: null, params: {} })} aria-current={current === view ? "page" : sectionOf(current) === view ? "true" : undefined}>
    <Icon size={20} aria-hidden="true" />{viewTitles[view]}{count > 0 && <span className="tab-badge" aria-label={text().count(count)}>{count}</span>}
  </a>;
}
