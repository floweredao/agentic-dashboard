import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Archive, ArrowLeft, Bell, BriefcaseBusiness, Ellipsis, Inbox, Library, Newspaper, Plus, RadioTower, RefreshCw, Trash2 } from "lucide-react";
import type { Comment, DashboardRecord, RecordInput, RecordKind, RecordPatch, TrashItem } from "../shared/contracts";
import { createComment, createRecord, deleteRecord, emptyTrash as emptyTrashApi, errorMessage, loadBriefings, loadComments, loadRecords, loadTrash, logout as endSession, markBriefing as markBriefingApi, patchRecord, purgeRecord, recordInputSchema, restoreRecord, session } from "./api";
import type { BriefingPage } from "./api";
import { syncPush } from "./push";
import { Empty, ChannelMark, DialogToast } from "./components/primitives";
import { ShareDialog } from "./components/ShareDialog";
import { isTypingTarget } from "./hooks";
import { addDays, aiFillRevert, blankRecord, channelKeys, channelOf, channelLabel, confirmationChanges, homeViewOf, inboxBadge, inboxStateOf, isRecord, listedFor, nextInQueue, revisitDue, seoulDate, withBriefingReads } from "./model";
import { backLabel, backOf, formatRoute, legacyRedirect, parseRoute, sectionOf, viewTitles } from "./router";
import type { Back, Route, Trail, View } from "./router";
import { DashboardContext } from "./state";
import type { Dashboard, Destination, ReviewState } from "./state";
import { ArchivePane } from "./views/Archive";
import { BriefingPane, BriefingReader, briefingPart, partReadAt } from "./views/Briefing";
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

const icons: Record<View, typeof Inbox> = {
  inbox: Inbox, library: Library, briefing: Newspaper, work: BriefcaseBusiness, more: Ellipsis, archive: Archive, trash: Trash2, channels: RadioTower,
  settings: Bell,
};
/** The tab screens in the order of the phone's tab bar and the top of the desktop sidebar (더보기 is the sidebar's lower groups). */
const tabViews = ["inbox", "library", "briefing", "work"] as const;
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
const syncLabel = (date: Date | null) => date
  ? `동기화 ${new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit" }).format(date)}` : "";
/** Records, the trash and timelines together. The trash and timelines are secondary: a failure there goes to `report` and never hides the records. */
async function loadAll(report: (cause: unknown) => void) {
  const secondary = <T,>(load: Promise<T>) => load.catch((cause: unknown) => { report(cause); return null; });
  const [items, trashed, comments, briefings] = await Promise.all([loadRecords(), secondary(loadTrash()), secondary(loadComments()), secondary(loadBriefings())]);
  return { items, trashed, comments, briefings };
}

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash));
  const [records, setRecords] = useState<DashboardRecord[]>([]);
  const [trash, setTrash] = useState<TrashItem[]>([]);
  const [comments, setComments] = useState<Comment[]>([]);
  const [briefings, setBriefings] = useState<BriefingPage | null>(null);
  const [briefingReads, setBriefingReads] = useState<ReadonlyMap<string, string | null>>(new Map());
  const [csrf, setCsrf] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [syncedAt, setSyncedAt] = useState<Date | null>(null);
  const [offline, setOffline] = useState(() => !navigator.onLine);
  const [narrow, setNarrow] = useState(phone);
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
  /** A failed trash or timeline load (null) keeps the last one. */
  const store = useCallback(({ items, trashed, comments: entries, briefings: page }: Awaited<ReturnType<typeof loadAll>>) => {
    setRecords(items); if (trashed) setTrash(trashed); if (entries) setComments(entries);
    if (page) { setBriefings(page); setBriefingReads(new Map()); }
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
      if (mounted) { setCsrf(auth.csrfToken); store(loaded); }
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

  // Phone: the window scrolls, so a reader starts at its title and a list comes back where it was left.
  const routeKey = formatRoute(route);
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

  // Pending records plus briefings with an unread part, with the read overlay applied as the 브리핑 list does.
  const inbox = useMemo(() => inboxBadge(records, (briefings?.items ?? []).map(item => withBriefingReads(item, briefingReads))),
    [records, briefings, briefingReads]);
  useEffect(() => {
    document.title = `Agentic Dashboard · ${viewTitles[route.view]}${inbox ? ` (${inbox})` : ""}`;
  }, [route.view, inbox]);

  // history.state changes only together with the route (every navigation sets a new route object), so the route keys this.
  const back: Back | null = useMemo(() => connected ? backOf(route, trailOf(history.state), narrow) : null, [connected, route, narrow]);
  const dashboard: Dashboard = useMemo(() => {
    const byId = new Map(records.map(record => [record.id, record]));
    /** undo: the changes that put the saved record back, offered as 되돌리기 in the toast. */
    const patch = async (record: DashboardRecord, changes: RecordPatch["changes"], message = "저장했어요.", undo?: RecordPatch["changes"]) => {
      setBusy(true);
      setToast(null);
      try {
        const saved = await patchRecord(current(record), changes, latest.current.csrf);
        replace(saved);
        setToast({ message, tone: "info", key: Date.now(), ...(undo ? { undo: () => { void patch(saved, undo, "되돌렸어요."); } } : {}) });
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
     * When the open inbox item leaves the 미확인 queue, the reader moves to its neighbour (and the toast says so). `leaves` is false when the change keeps it queued.
     * Under the 전체/확인함 filters a review change keeps the item listed, so the reader stays.
     */
    const leaveQueue = async (record: DashboardRecord, run: (moved: string) => Promise<DashboardRecord | null>, leaves = true) => {
      const { route: now, records: all } = latest.current;
      // listedFor keeps the open item in the inbox after its quiet confirmation, so it still advances from there.
      const queue = listedFor(now, all);
      const advances = leaves && now.view === "inbox" && inboxStateOf(now.params) === "pending"
        && now.id === record.id && queue.some(item => item.id === record.id);
      const next = advances ? nextInQueue(queue, record.id) : null;
      const saved = await run(next ? " 다음 항목을 열었어요." : "");
      if (saved && advances) navigate({ view: "inbox", id: next?.id ?? null, params: now.params }, { replace: true });
    };
    const confirm = async (record: DashboardRecord) => {
      if (record.kind === "task") { await leaveQueue(record, moved => patch(record, { status: "done" }, "완료로 표시했어요." + moved)); return; }
      const changes = confirmationChanges(current(record));
      // While the quiet confirmation of this record is still in flight, a second PATCH would only conflict with it.
      if (!changes || reading.current.has(record.id)) return;
      await leaveQueue(record, moved => patch(record, changes, "확인했어요." + moved), !revisitDue(current(record)));
    };
    const create = async (input: RecordInput, requestId: string, review?: ReviewState) => {
      setToast(null);
      let saved = await createRecord(input, latest.current.csrf, requestId);
      if (isRecord(input) && review && saved.reviewState !== review) saved = await patchRecord(saved, { reviewState: review }, latest.current.csrf);
      replace(saved); setModal(null); notify("저장했어요.");
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
        notify("복원했어요.");
        // The silent refresh started by the delete may still be in flight; this one settles both lists on the server's state.
        void refresh(true);
      } catch (cause) { if (!navigator.onLine) setOffline(true); notify(await errorMessage(cause), "error"); }
      finally { setBusy(false); }
    };
    return {
      records, byId, trash, comments, connected, csrfToken: csrf, loading, busy, route, back, navigate, select, open, patch, confirm, create, editDraft, notify,
      briefings, briefingReads,
      markBriefing: async (id, part, read, quiet = false) => {
        try {
          const saved = await markBriefingApi(id, part, read, latest.current.csrf);
          const key = `${id}:${part}`;
          const before = briefings?.items.find(item => item.id === id);
          const wasUnread = briefingReads.has(key) ? briefingReads.get(key) === null : before ? partReadAt(before, part) === null : !read;
          const unread = partReadAt(saved, part) === null;
          setBriefingReads(reads => new Map(reads).set(key, partReadAt(saved, part)));
          const step = unread === wasUnread ? 0 : unread ? 1 : -1;
          if (step) setBriefings(page => page && { ...page, unread: Math.max(0, page.unread + step),
            parts: { ...page.parts, [part]: { ...page.parts[part], unread: Math.max(0, page.parts[part].unread + step) } } });
          if (!quiet) notify(read ? "읽음으로 표시했어요." : "안 읽음으로 표시했어요.");
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
      toggleStar: async record => { await patch(record, { fields: { ...current(record).fields, starred: current(record).fields.starred !== true } }, current(record).fields.starred === true ? "별표를 뺐어요." : "별표를 달았어요."); },
      markPending: async record => { await patch(record, { reviewState: "pending" }, "미확인으로 바꿨어요.", { reviewState: "approved" }); },
      markRead: async record => {
        const now = current(record);
        if (!isRecord(now) || now.reviewState !== "pending" || reading.current.has(now.id)) return;
        reading.current.add(now.id);
        try { replace(await patchRecord(now, { reviewState: "approved" }, latest.current.csrf)); }
        catch (cause) { if (!navigator.onLine) setOffline(true); notify(await errorMessage(cause), "error"); }
        finally { reading.current.delete(now.id); }
      },
      clearRevisit: async record => {
        const before = current(record);
        await leaveQueue(record, moved => patch(record, { fields: { ...before.fields, revisitDate: null } }, "다시 볼 날을 지웠어요." + moved,
          { fields: before.fields }), before.reviewState !== "pending");
      },
      snooze: async record => {
        const before = current(record);
        await leaveQueue(record, moved => patch(record, { reviewState: "approved", fields: { ...before.fields, revisitDate: addDays(seoulDate(), 7) } },
          "7일 뒤에 다시 보여 드릴게요." + moved, { reviewState: before.reviewState, fields: before.fields }));
      },
      toggleArchive: async record => {
        const archived = current(record).archivedAt !== null;
        if (archived) { await patch(record, { archived: false }, "복원했어요."); return; }
        // Archiving the open record goes back to the list it was opened from, not on to another record.
        const open = latest.current.route.id === record.id;
        const saved = await patch(record, { archived: true }, "보관했어요.", { archived: false });
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
          setToast({ message: "휴지통으로 옮겼어요.", tone: "info", key: Date.now(), undo: () => { void restoreById(record.id); } });
        } catch (cause) { if (!navigator.onLine) setOffline(true); notify(await errorMessage(cause), "error"); }
        finally { setBusy(false); }
      },
      restore: item => restoreById(item.record.id),
      purge: async item => {
        if (!window.confirm(`"${item.record.title}" 항목을 영구 삭제할까요? 되돌릴 수 없어요.`)) return;
        setBusy(true);
        setToast(null);
        try {
          await purgeRecord(item.record.id, latest.current.csrf);
          setTrash(items => items.filter(entry => entry.record.id !== item.record.id));
          notify("영구 삭제했어요.");
        } catch (cause) { if (!navigator.onLine) setOffline(true); notify(await errorMessage(cause), "error"); }
        finally { setBusy(false); }
      },
      emptyTrash: async () => {
        if (!window.confirm("휴지통을 비울까요? 모든 항목이 영구 삭제되고 되돌릴 수 없어요.")) return;
        setBusy(true);
        setToast(null);
        try {
          await emptyTrashApi(latest.current.csrf);
          setTrash([]);
          notify("휴지통을 비웠어요.");
        } catch (cause) { if (!navigator.onLine) setOffline(true); notify(await errorMessage(cause), "error"); }
        finally { setBusy(false); }
      },
      revertAiFill: async record => { const changes = aiFillRevert(current(record)); if (changes) await patch(record, changes, "원래 제목과 요약으로 되돌렸어요."); },
      update: async (record, input, review) => {
        setToast(null);
        const { kind: _kind, ...changes } = input;
        const saved = await patchRecord(current(record), { ...changes, ...(isRecord(input) && review ? { reviewState: review } : {}) }, latest.current.csrf);
        replace(saved); setModal(null); notify("저장했어요.");
        return saved;
      },
      compose: (kind = "social") => { setToast(null); if (!latest.current.csrf) setModal({ mode: "login" }); else setModal({ mode: "compose", kind }); },
      edit: record => { setToast(null); setModal({ mode: "editor", input: inputOf(current(record)), existing: current(record), requestId: crypto.randomUUID() }); },
      share: record => { setToast(null); setModal({ mode: "share", record: current(record) }); },
      followUp: record => {
        const task = blankRecord("task");
        editDraft({ ...task, title: `${record.title} 후속 할 일`.slice(0, 200), projectId: record.projectId,
          fields: { ...task.fields, evidenceIds: [record.id], taskType: record.projectId ? "project" : "general" } });
      },
      refresh: () => refresh(),
      requestLogin: () => setModal({ mode: "login" }),
      login: async token => {
        const auth = await session(token);
        setCsrf(auth.csrfToken); store(await loadAll(report)); setModal(null);
      },
      logout: async () => { await endSession(latest.current.csrf); setCsrf(""); setRecords([]); setTrash([]); setComments([]); setBriefings(null); navigate({ view: "inbox" }); notify("로그아웃했어요."); },
      importJson: async text => create(recordInputSchema.parse(JSON.parse(text)), crypto.randomUUID()),
    };
  }, [records, trash, comments, briefings, briefingReads, connected, csrf, loading, busy, route, back, navigate, notify, refresh, replace, report, store]);

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
  // A briefing opened from 받은 항목 reads there in full (뉴스 and 메일), so back returns to the inbox with its filters.
  const inboxBriefing = route.view === "inbox" && !selected && route.id !== null && briefings?.items.some(item => item.id === route.id) ? route.id : null;
  const hasDetail = connected && !singlePane(route.view) && route.id !== null;
  const counts: Record<View, number> = {
    inbox,
    library: records.filter(record => isRecord(record) && !record.archivedAt).length,
    archive: records.filter(record => record.archivedAt !== null).length,
    work: records.filter(record => record.kind === "task" && !record.archivedAt && record.status !== "done").length,
    more: 0,
    channels: 0,
    trash: trash.length,
    briefing: briefings?.unread ?? 0,
    settings: 0,
  };
  const link = (view: View) => formatRoute({ view, id: null, params: {} });
  const title = viewTitles[route.view];
  const navItem = (view: View) => {
    const Icon = icons[view];
    return <li key={view}><a className="nav-item" href={link(view)} title={viewTitles[view]} aria-current={route.view === view ? "page" : undefined}>
      <Icon size={18} aria-hidden="true" /><span className="nav-label">{viewTitles[view]}</span>
      {connected && counts[view] > 0 && <span className={`nav-count${view === "inbox" || view === "briefing" ? " strong" : ""}`}>{counts[view]}</span>}
    </a></li>;
  };
  const locked = !connected && !loading;
  const toastView = toast && <div key={toast.key} className={`toast ${toast.tone}`} role={toast.tone === "error" ? "alert" : "status"}>
    <span>{toast.message}</span>
    {toast.undo && <button type="button" className="toast-action" onClick={() => { const undo = toast.undo; setToast(null); undo?.(); }}>되돌리기</button>}
    <button type="button" onClick={() => setToast(null)}>닫기</button>
  </div>;

  return <DashboardContext.Provider value={dashboard}>
    <a href="#main" className="skip-link" onClick={event => { event.preventDefault(); document.getElementById("main")?.focus(); }}>본문으로 바로가기</a>
    {loading && <div className="loading-line" role="status" aria-label="불러오는 중" />}
    <div className={`app view-${route.view}${hasDetail ? " has-detail" : ""}${back ? " has-back" : ""}${locked ? " locked" : ""}`}>
      <nav className="sidebar" aria-label="주 메뉴">
        <a className="brand" href={link("inbox")}><img src="/brand-mark.png" alt="" width={26} height={26} /><span className="brand-name">Agentic Dashboard</span></a>
        <button type="button" className="btn btn-primary compose-btn" onClick={() => dashboard.compose()} aria-label="새로 저장" title="새로 저장 (C)"><Plus size={17} aria-hidden="true" /><span>새로 저장</span></button>
        <ul className="nav-list">{tabViews.map(navItem)}</ul>
        {connected && <>
          <p className="nav-section">보관</p>
          <ul className="nav-list">{navItem("archive")}{navItem("trash")}</ul>
          <p className="nav-section">채널</p>
          <ul className="nav-list">{navItem("channels")}</ul>
          <p className="nav-section">설정</p>
          <ul className="nav-list">{navItem("settings")}</ul>
          <ul className="nav-list channel-nav">{channelKeys.map(channel => {
            const total = records.filter(record => isRecord(record) && !record.archivedAt && channelOf(record) === channel).length;
            const active = route.view === "library" && route.params.channel === channel;
            return <li key={channel}><a className="nav-item" href={formatRoute({ view: "library", id: null, params: { channel } })} aria-current={active ? "page" : undefined}>
              <ChannelMark channel={channel} size="tile" /><span className="nav-label">{channelLabel(channel)}</span>{total > 0 && <span className="nav-count">{total}</span>}
            </a></li>;
          })}</ul>
        </>}
        <div className="sidebar-foot">
          <span className={`status${offline ? " offline" : ""}`} role="status">{offline ? "오프라인 · 저장되지 않아요" : connected ? syncLabel(syncedAt) : "연결 안 됨"}</span>
          {connected && <button type="button" className="icon-btn" onClick={() => { void refresh(); }} disabled={loading} aria-label="새로고침" title="새로고침"><RefreshCw size={16} aria-hidden="true" /></button>}
        </div>
      </nav>

      <header className="appbar">
        {back && <button type="button" className="btn appbar-back" onClick={dashboard.goBack}><ArrowLeft size={18} aria-hidden="true" />{backLabel(back.hash)}</button>}
        <a className="brand" href={link("inbox")}><img src="/brand-mark.png" alt="" width={26} height={26} /><span className="brand-name">Agentic Dashboard</span></a>
        {connected && <button type="button" className="icon-btn appbar-compose" onClick={() => dashboard.compose()} aria-label="새로 저장" title="새로 저장"><Plus size={20} aria-hidden="true" /></button>}
        {connected && <button type="button" className="icon-btn" onClick={() => { void refresh(); }} disabled={loading} aria-label="새로고침"><RefreshCw size={18} aria-hidden="true" /></button>}
      </header>

      <main id="main" tabIndex={-1} className={`workspace${!connected || singlePane(route.view) ? " single" : ""}`}>
        {!connected ? loading ? null : <section className="pane">
          <OwnerGate origin={location.origin} hash={formatRoute(route)} onToken={() => setModal({ mode: "login" })} />
        </section>
          : route.view === "more" ? <section className="pane" aria-label={title}><MorePane /></section>
          : route.view === "channels" ? <section className="pane" aria-label={title}><ChannelsView /></section>
          : route.view === "trash" ? <section className="pane" aria-label={title}><TrashPane /></section>
          : route.view === "settings" ? <section className="pane" aria-label={title}><SettingsPane /></section>
          : route.view === "briefing" ? <>
            <section className="pane list-pane" aria-label="브리핑 목록"><BriefingPane /></section>
            <section className="pane reader-pane" aria-label="상세">
              {route.id ? <BriefingReader key={`${route.id}:${briefingPart(route.params)}`} id={route.id} part={briefingPart(route.params)} />
                : <div className="reader-empty"><Empty icon={<Newspaper size={20} aria-hidden="true" />}>목록에서 브리핑을 고르면 여기에 보여요</Empty></div>}
            </section>
          </>
            : <>
              <section className="pane list-pane" aria-label={`${title} 목록`}>
                {route.view === "inbox" && <InboxPane />}
                {route.view === "library" && <LibraryPane />}
                {route.view === "archive" && <ArchivePane />}
                {route.view === "work" && <WorkPane />}
              </section>
              <section className="pane reader-pane" aria-label="상세">
                {selected ? <Reader key={selected.id} record={selected} />
                  : inboxBriefing ? <BriefingReader key={`inbox:${inboxBriefing}`} id={inboxBriefing} part="all" />
                  : <div className="reader-empty"><Empty>{route.id ? "항목을 찾을 수 없음" : "목록에서 항목을 고르면 여기에 보여요"}</Empty></div>}
              </section>
            </>}
      </main>

      <nav className="tabbar" aria-label="주 메뉴">
        {(["inbox", "library", "briefing"] as const).map(view => <TabLink key={view} view={view} current={route.view}
          count={connected && (view === "inbox" || view === "briefing") ? counts[view] : 0} />)}
        {(["work", "more"] as const).map(view => <TabLink key={view} view={view} current={route.view}
          count={view === "work" && connected ? records.filter(record => record.kind === "task" && !record.archivedAt && record.status === "review").length : 0} />)}
      </nav>
    </div>

    <DialogToast.Provider value={modal ? toastView : null}>
      {modal?.mode === "login" && <LoginDialog onClose={() => setModal(null)} />}
      {modal?.mode === "compose" && <Compose kind={modal.kind} onClose={() => setModal(null)} />}
      {modal?.mode === "editor" && <Editor key={modal.requestId} initial={modal.input} requestId={modal.requestId} onClose={() => setModal(null)} {...(modal.existing ? { existing: modal.existing } : {})} />}
      {modal?.mode === "share" && <ShareDialog record={modal.record} csrfToken={csrf} onClose={() => setModal(null)} />}
    </DialogToast.Provider>
    {!modal && toastView}
  </DashboardContext.Provider>;
}

/** A tab is current on its own screen (page) and on the screens under it (true: 보관함, 휴지통 and 채널 관리 under 더보기). */
function TabLink({ view, current, count }: { readonly view: View; readonly current: View; readonly count: number }) {
  const Icon = icons[view];
  return <a className="tab" href={formatRoute({ view, id: null, params: {} })} aria-current={current === view ? "page" : sectionOf(current) === view ? "true" : undefined}>
    <Icon size={20} aria-hidden="true" />{viewTitles[view]}{count > 0 && <span className="tab-badge" aria-label={`${count}건`}>{count}</span>}
  </a>;
}
