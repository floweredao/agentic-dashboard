import { DIGEST_PARTS } from "../shared/contracts";
import type { Comment, DigestPart, DigestSummary, DashboardRecord, RecordInput, RecordKind, RecordPatch } from "../shared/contracts";
import { zonedDate, zonedInstant } from "../shared/time";
import { config } from "./config";
import { formatMonthDay, localized, strings } from "./i18n";
import type { Route } from "./router";

type Option = { readonly id: string; readonly label: string };
type ModelText = {
  readonly spaces: Record<Space, { readonly title: string; readonly short: string }>;
  readonly kinds: Record<RecordKind, string>;
  readonly share: string; readonly manual: string; readonly other: string;
  readonly inboxStates: Record<InboxState, string>;
  readonly today: string; readonly yesterday: string;
  readonly projectStatuses: { readonly idea: string; readonly planning: string; readonly active: string; readonly paused: string; readonly done: string };
  readonly taskStatuses: { readonly todo: string; readonly active: string; readonly review: string; readonly paused: string; readonly done: string };
  readonly filters: Record<Space, readonly Option[]>;
  readonly justNow: string; readonly hoursAgo: (hours: number) => string; readonly daysAgo: (days: number) => string;
};
const text = strings<ModelText>({
  en: {
    spaces: {
      projects: { title: "Side projects", short: "Projects" }, tasks: { title: "General work", short: "Work" },
      research: { title: "Research reports", short: "Research" }, social: { title: "Saved social posts", short: "Social" },
    },
    kinds: { project: "Project", task: "Task", research: "Research", "work-report": "Work", note: "Note", social: "Link" },
    share: "Shared links", manual: "Written here", other: "Other",
    inboxStates: { all: "All", pending: "To review", approved: "Reviewed" },
    today: "Today", yesterday: "Yesterday",
    projectStatuses: { idea: "Idea", planning: "Planning", active: "In progress", paused: "On hold", done: "Done" },
    taskStatuses: { todo: "Not started", active: "In progress", review: "Needs review", paused: "On hold", done: "Done" },
    filters: {
      projects: [{ id: "all", label: "All" }, { id: "active", label: "In progress" }, { id: "idea", label: "Idea" }, { id: "paused", label: "On hold" }, { id: "done", label: "Done" }],
      tasks: [{ id: "today", label: "Today" }, { id: "week", label: "This week" }, { id: "all", label: "All tasks" }, { id: "review", label: "Needs review" }, { id: "done", label: "Done" }, { id: "notes", label: "Task notes" }],
      research: [{ id: "pending", label: "To review" }, { id: "all", label: "All" }, { id: "starred", label: "Starred" }],
      social: [{ id: "x", label: "X" }, { id: "threads", label: "Threads" }, { id: "starred", label: "Starred" }],
    },
    justNow: "Just now", hoursAgo: hours => `${hours}h ago`, daysAgo: days => `${days}d ago`,
  },
  ko: {
    spaces: {
      projects: { title: "사이드 프로젝트", short: "프로젝트" }, tasks: { title: "일반 업무", short: "업무" },
      research: { title: "조사 보고", short: "조사 보고" }, social: { title: "소셜 저장", short: "소셜 저장" },
    },
    kinds: { project: "프로젝트", task: "할 일", research: "조사", "work-report": "작업", note: "메모", social: "링크" },
    share: "iPhone 공유", manual: "직접 작성", other: "기타",
    inboxStates: { all: "전체", pending: "미확인", approved: "확인함" },
    today: "오늘", yesterday: "어제",
    projectStatuses: { idea: "아이디어", planning: "기획", active: "진행 중", paused: "보류", done: "완료" },
    taskStatuses: { todo: "시작 전", active: "진행 중", review: "확인 필요", paused: "보류", done: "끝남" },
    filters: {
      projects: [{ id: "all", label: "전체" }, { id: "active", label: "진행 중" }, { id: "idea", label: "아이디어" }, { id: "paused", label: "보류" }, { id: "done", label: "완료" }],
      tasks: [{ id: "today", label: "오늘" }, { id: "week", label: "이번 주" }, { id: "all", label: "전체 할 일" }, { id: "review", label: "확인 필요" }, { id: "done", label: "끝남" }, { id: "notes", label: "할 일 메모" }],
      research: [{ id: "pending", label: "미확인" }, { id: "all", label: "전체" }, { id: "starred", label: "별표" }],
      social: [{ id: "x", label: "X" }, { id: "threads", label: "Threads" }, { id: "starred", label: "별표" }],
    },
    justNow: "방금 전", hoursAgo: hours => `${hours}시간 전`, daysAgo: days => `${days}일 전`,
  },
});

export type Screen = "home" | "projects" | "tasks" | "research" | "social" | "archive" | "mobile";
export type Space = "projects" | "tasks" | "research" | "social";
export const spaces = localized(() => ({
  projects: { ...text().spaces.projects, color: "pink", kind: "project" },
  tasks: { ...text().spaces.tasks, color: "blue", kind: "task" },
  research: { ...text().spaces.research, color: "green", kind: "research" },
  social: { ...text().spaces.social, color: "yellow", kind: "social" },
} as const));
export const spaceKeys: readonly Space[] = ["projects", "tasks", "research", "social"];
export const kindLabels: Record<RecordKind, string> = localized(() => text().kinds);
/** Where a record came in: a registered agent's name, `share` (a link captured through the trusted proxy) or `manual`. */
export type Channel = string;
/**
 * Every channel in display order: registered agents and any other source seen in records (by name), then `share` when
 * the trusted proxy can capture links, then `manual`.
 */
export function channelsFor(agents: readonly string[], records: readonly Pick<DashboardRecord, "source">[]): Channel[] {
  const named = new Set(agents);
  for (const record of records) if (record.source !== "manual") named.add(record.source);
  named.delete("share");
  named.delete("manual");
  return [...[...named].sort(), ...(config.features.trustedLogin ? ["share"] : []), "manual"];
}
/** The current channels (channelsFor over the loaded agents and records). The App updates it as they load. */
export let channelKeys: readonly Channel[] = channelsFor([], []);
export function setChannelKeys(keys: readonly Channel[]) { channelKeys = keys; }
/** Agent channels are named after the agent; `share` and `manual` have their own names. */
export const channelLabel = (channel: Channel) => channel === "share" ? text().share : channel === "manual" ? text().manual : channel;
export const channelGlyph = (channel: Channel) => channel.slice(0, 1).toUpperCase();
/** The colour class: `ch-share` and `ch-manual` have their own, an agent's name hashes onto ch-0..ch-7. */
export function channelClass(channel: Channel): string {
  if (channel === "share" || channel === "manual") return `ch-${channel}`;
  let hash = 0;
  for (const char of channel) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return `ch-${hash % 8}`;
}
export function channelOf(record: Pick<DashboardRecord, "source" | "kind" | "fields">): Channel {
  if (record.source !== "manual") return record.source;
  return record.kind === "social" && record.fields.captureEnrichment !== undefined ? "share" : "manual";
}
export const isChannel = (value: string): value is Channel => (channelKeys as readonly string[]).includes(value);
/** Kinds that arrive as saved material (not project/task planning records). */
export const recordKinds = ["research", "work-report", "social", "note"] as const;
export type MaterialKind = typeof recordKinds[number];
export const isMaterialKind = (value: string): value is MaterialKind => (recordKinds as readonly string[]).includes(value);
/** Items waiting for the owner: unconfirmed or revisit-due material, newest first. */
export function inboxItems(records: readonly DashboardRecord[], today = localDate()) {
  return records.filter(record => isRecord(record) && inQueue(record, today))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
/** The inbox's review filter (`?state=`): all (every unarchived material) is the default; pending is the queue above; approved is confirmed material. */
export type InboxState = "pending" | "approved" | "all";
export const inboxStates: readonly { readonly id: InboxState; readonly label: string }[] = localized(() =>
  (["all", "pending", "approved"] as const).map(id => ({ id, label: text().inboxStates[id] })));
export const inboxStateOf = (params: Readonly<Record<string, string>>): InboxState =>
  params.state === "approved" || params.state === "pending" ? params.state : "all";
/** Unarchived material for one review filter, newest first. */
export function inboxView(records: readonly DashboardRecord[], state: InboxState, today = localDate()) {
  if (state === "pending") return inboxItems(records, today);
  return records.filter(record => isRecord(record) && record.archivedAt === null && (state === "all" || record.reviewState === "approved"))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
/** Case-insensitive match over the text a person remembers: title, body, summary, conclusion, tags, host. */
export function matchesQuery(record: DashboardRecord, query: string) {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [record.title, record.body, textField(record, "summary"), textField(record, "conclusion"), record.tags.join(" "), record.links.map(link => link.url).join(" ")]
    .join("\n").toLocaleLowerCase().includes(needle);
}
/** When a part of a digest (or its summary) was read; null while it waits. */
export const partReadAt = (item: Pick<DigestSummary, "articlesReadAt" | "messagesReadAt">, part: DigestPart) => part === "messages" ? item.messagesReadAt : item.articlesReadAt;
/** The number of items a part holds, from a digest's sections or a summary's outline. */
export const digestPartItems = (item: { readonly sections: readonly { kind: DigestPart; items: readonly unknown[] }[] } | Pick<DigestSummary, "outline">, part: DigestPart) =>
  "outline" in item ? item.outline.reduce((sum, section) => sum + (section.kind === part ? section.items : 0), 0)
    : item.sections.reduce((sum, section) => sum + (section.kind === part ? section.items.length : 0), 0);
/** Whether a summary has any section of a part, even an empty one. */
export const digestHasPart = (item: Pick<DigestSummary, "outline">, part: DigestPart) => item.outline.some(section => section.kind === part);
/** The App's per-part read overlay (`<id>:<part>` -> readAt) applied over a loaded digest summary. */
export function withDigestReads(item: DigestSummary, reads: ReadonlyMap<string, string | null>): DigestSummary {
  const articles = reads.has(`${item.id}:articles`) ? { articlesReadAt: reads.get(`${item.id}:articles`) ?? null } : {};
  const messages = reads.has(`${item.id}:messages`) ? { messagesReadAt: reads.get(`${item.id}:messages`) ?? null } : {};
  return { ...item, ...articles, ...messages };
}
/** A digest waits to be read while any part with items is unread. */
export const digestUnread = (item: DigestSummary) => DIGEST_PARTS.some(part => digestPartItems(item, part) > 0 && partReadAt(item, part) === null);
/** `Inbox 2 · World 2 · AI 7`: the sections with items, in their stored order. */
export const digestCounts = (item: DigestSummary) =>
  item.outline.filter(section => section.items > 0).map(section => `${section.title} ${section.items}`).join(" · ");
/** Case-insensitive match over a digest's title (its slot title, passed in), article headlines and message headline. */
export function digestMatches(item: DigestSummary, query: string, title: string) {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [title, ...item.headlines, item.messageHeadline ?? ""].join("\n").toLocaleLowerCase().includes(needle);
}
/** Digests for one review filter, newest first: all of them, pending those with an unread part, approved the fully read ones. */
export function inboxDigestView(items: readonly DigestSummary[], state: InboxState) {
  return items.filter(item => state === "all" || (state === "pending") === digestUnread(item))
    .sort((a, b) => b.scheduledAt.localeCompare(a.scheduledAt));
}
/** The digests the inbox lists for a route: the filter's, plus the open one while it stays selected, narrowed by the search. */
export function listedDigestsFor(route: Route, items: readonly DigestSummary[], titleOf: (slot: string) => string) {
  const view = inboxDigestView(items, inboxStateOf(route.params));
  const opened = route.id !== null && !view.some(item => item.id === route.id) ? items.find(item => item.id === route.id) : undefined;
  return (opened ? [...view, opened].sort((a, b) => b.scheduledAt.localeCompare(a.scheduledAt)) : view)
    .filter(item => digestMatches(item, route.params.q ?? "", titleOf(item.slot)));
}
/** The inbox badge (tab, sidebar, document title): queued records plus digests with an unread part. */
export const inboxBadge = (records: readonly DashboardRecord[], digests: readonly DigestSummary[], today = localDate()) =>
  inboxItems(records, today).length + digests.filter(digestUnread).length;
export type LibraryFilter = {
  readonly type?: string; readonly channel?: string; readonly starred?: boolean; readonly q?: string;
};
/** Unarchived saved material for the library, newest first; archived items live in the archive view. */
export function libraryItems(records: readonly DashboardRecord[], filter: LibraryFilter) {
  return records.filter(record => isRecord(record)
    && record.archivedAt === null
    && (!filter.type || record.kind === filter.type)
    && (!filter.channel || channelOf(record) === filter.channel)
    && (!filter.starred || record.fields.starred === true)
    && matchesQuery(record, filter.q ?? ""))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
/** Group label for a timestamp relative to today in the dashboard's zone: today, yesterday, or a date. */
export function dayLabel(iso: string, today = localDate()) {
  const day = localDate(new Date(iso));
  if (day === today) return text().today;
  if (day === addDays(today, -1)) return text().yesterday;
  return dateLabel(day);
}
/** Consecutive runs of records sharing a day label, preserving order. */
export function groupByDay<T extends Pick<DashboardRecord, "createdAt">>(items: readonly T[], today = localDate()) {
  const groups: { label: string; items: T[] }[] = [];
  for (const item of items) {
    const label = dayLabel(item.createdAt, today);
    const last = groups.at(-1);
    if (last && last.label === label) last.items.push(item); else groups.push({ label, items: [item] });
  }
  return groups;
}
/** Everything the owner put away, of any kind, most recently archived first. */
export function archivedItems(records: readonly DashboardRecord[]) {
  return records.filter(record => record.archivedAt !== null)
    .sort((a, b) => (b.archivedAt ?? "").localeCompare(a.archivedAt ?? ""));
}
/** Which top-level view shows a record by default. */
export function homeViewOf(record: DashboardRecord, today = localDate()): "inbox" | "library" | "archive" | "work" {
  if (record.archivedAt) return "archive";
  if (!isRecord(record)) return "work";
  return inQueue(record, today) ? "inbox" : "library";
}
/** The records a list pane shows for a route (membership only; panes apply their own order). The trash is not a record list. */
export function listedFor(route: Route, records: readonly DashboardRecord[], today = localDate()): DashboardRecord[] {
  const params = route.params;
  if (route.view === "inbox") {
    // The open record keeps its row after it is confirmed, so the reader does not lose its place until another one is opened.
    const queue = inboxView(records, inboxStateOf(params), today);
    const opened = route.id !== null && !queue.some(record => record.id === route.id)
      ? records.find(record => record.id === route.id && isRecord(record) && record.archivedAt === null) : undefined;
    return (opened ? [...queue, opened].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : queue)
      .filter(record => matchesQuery(record, params.q ?? ""));
  }
  if (route.view === "library") {
    return libraryItems(records, { type: params.type ?? "", channel: params.channel ?? "", starred: params.starred === "1", q: params.q ?? "" });
  }
  if (route.view === "archive") return archivedItems(records);
  if (route.view === "work") {
    return params.show === "projects" ? viewRecords(records, "projects", params.status ?? "all", today) : viewRecords(records, "tasks", params.filter ?? "all", today);
  }
  return [];
}
/** A list route without extra conditions that contains the record (the archive for anything archived, unarchived work items, all material). */
export function homeRouteOf(record: DashboardRecord, today = localDate()): Pick<Route, "view" | "params"> {
  if (record.archivedAt) return { view: "archive", params: {} };
  if (record.kind === "task") return { view: "work", params: { filter: "all" } };
  if (record.kind === "project") return { view: "work", params: { show: "projects" } };
  return { view: homeViewOf(record, today), params: {} };
}
/** After an item leaves a queue: the one below it, else the one above it, else none. */
export function nextInQueue(queue: readonly DashboardRecord[], id: string): DashboardRecord | null {
  const index = queue.findIndex(item => item.id === id);
  return index < 0 ? null : queue[index + 1] ?? queue[index - 1] ?? null;
}
export const projectStatuses = localized(() => text().projectStatuses);
export const taskStatuses = localized(() => text().taskStatuses);
/** One task's or project's timeline, oldest first. */
export const timelineOf = (comments: readonly Comment[], id: string) => comments.filter(comment => comment.recordId === id);
/** The owner's comments on an item that no agent has marked done yet (awaiting a reply). */
export const waitingReplies = (comments: readonly Comment[], id: string) =>
  comments.filter(comment => comment.recordId === id && comment.source === "manual" && comment.doneAt === null).length;
/** An item's latest change: its own update or its newest timeline entry. */
export function lastActivity(record: DashboardRecord, comments: readonly Comment[]) {
  return timelineOf(comments, record.id).reduce((latest, comment) => comment.createdAt > latest ? comment.createdAt : latest, record.updatedAt);
}
export const sourceLabels: Record<string, string> = localized(() => ({ manual: text().manual }));
export const filters: Record<Space, readonly Option[]> = localized(() => text().filters);

export function isRecord(record: Pick<DashboardRecord, "kind">) {
  return record.kind !== "project" && record.kind !== "task";
}

export function spaceOf(record: Pick<DashboardRecord, "kind">): Space {
  switch (record.kind) {
    case "project": return "projects";
    case "task": case "note": return "tasks";
    case "research": case "work-report": return "research";
    case "social": return "social";
  }
}

export function textField(record: Pick<DashboardRecord, "fields">, key: string): string {
  const value = record.fields[key];
  return typeof value === "string" ? value : "";
}

const fullId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The loaded record a full id names, or the only one whose id starts with an 8-hex short id; otherwise null. */
export function recordByRef<T extends Pick<DashboardRecord, "id">>(records: readonly T[], token: string): T | null {
  const key = token.toLowerCase();
  if (fullId.test(key)) return records.find(record => record.id.toLowerCase() === key) ?? null;
  if (!/^[0-9a-f]{8}$/.test(key)) return null;
  const matches = records.filter(record => record.id.toLowerCase().startsWith(key));
  return matches.length === 1 ? matches[0] ?? null : null;
}

export function idsField(record: Pick<DashboardRecord, "fields">, key: string): string[] {
  const value = record.fields[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** The calendar date (YYYY-MM-DD) of an instant in the dashboard's time zone. */
export function localDate(date = new Date()): string {
  return zonedDate(date, config.timeZone);
}
/** @deprecated Use localDate; kept until every view has moved to it. */
/** Calendar arithmetic on a YYYY-MM-DD date; the zone does not matter. */
export function addDays(date: string, days: number) {
  const day = new Date(`${date}T12:00:00Z`);
  day.setUTCDate(day.getUTCDate() + days);
  return day.toISOString().slice(0, 10);
}
export function weekBounds(today = localDate()) {
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  const start = addDays(today, -weekday);
  return { start, end: addDays(start, 6) };
}
export function isToday(record: DashboardRecord, today = localDate()) {
  return record.kind === "task" && record.status !== "done"
    && (record.fields.today === true || record.dueDate === today);
}
export function inQueue(record: DashboardRecord, today = localDate()) {
  if (record.archivedAt) return false;
  if (record.kind === "task") return record.status !== "done" && (isToday(record, today) || record.status === "review");
  if (!isRecord(record)) return false;
  return record.reviewState === "pending" || revisitDue(record, today);
}
/** A material record whose revisit date has arrived. A separate marker: it never changes the review status. */
export function revisitDue(record: DashboardRecord, today = localDate()) {
  const revisit = textField(record, "revisitDate");
  return isRecord(record) && revisit !== "" && revisit <= today;
}
/** Confirming only moves a pending record to approved (the status is reviewState alone); null when there is nothing to confirm. */
export function confirmationChanges(record: DashboardRecord): RecordPatch["changes"] | null {
  return record.reviewState === "pending" ? { reviewState: "approved" } : null;
}
export function viewRecords(records: readonly DashboardRecord[], space: Space, filter: string, today = localDate()) {
  const week = weekBounds(today);
  return records.filter(record => {
    if (record.archivedAt) return false;
    if (space === "tasks" && filter === "notes") return record.kind === "note";
    if (spaceOf(record) !== space || record.kind === "note") return false;
    if (filter === "all") return true;
    if (filter === "today") return isToday(record, today);
    if (filter === "week") return record.dueDate !== null && record.dueDate >= week.start && record.dueDate <= week.end;
    if (filter === "starred") return record.fields.starred === true;
    if (filter === "pending" || filter === "approved") return record.reviewState === filter;
    if (filter === "x" || filter === "threads") return record.fields.origin === filter;
    return record.status === filter;
  });
}
/** Month and day of a YYYY-MM-DD date (noon in the dashboard's zone) or of an instant. */
export function dateLabel(date: string) {
  return formatMonthDay(date.length === 10 ? zonedInstant(date, "12:00", config.timeZone) : date);
}
export function relativeTime(date: string) {
  const hours = Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 3_600_000));
  return hours === 0 ? text().justNow : hours < 24 ? text().hoursAgo(hours) : text().daysAgo(Math.floor(hours / 24));
}
export function displaySource(record: DashboardRecord) {
  if (record.source !== "manual") return channelLabel(record.source);
  if (record.fields.origin === "x") return "X";
  if (record.fields.origin === "threads") return "Threads";
  return record.fields.origin === "other" ? text().other : sourceLabels["manual"] ?? "";
}
/** Home overview numbers; archived records never count. `daily` ends on `today` (dates in the dashboard's zone). */
export function digest(records: readonly DashboardRecord[], today = localDate(), days = 14) {
  const live = records.filter(record => !record.archivedAt);
  const week = weekBounds(today);
  const createdOn = (record: DashboardRecord) => localDate(new Date(record.createdAt));
  const counts = new Map<string, number>();
  for (const record of live) counts.set(createdOn(record), (counts.get(createdOn(record)) ?? 0) + 1);
  return {
    total: live.length,
    weekNew: live.filter(record => createdOn(record) >= week.start && createdOn(record) <= week.end).length,
    queue: live.filter(record => inQueue(record, today)).length,
    samples: live.filter(record => record.fields.demo === true || record.fields.sample === true).length,
    bySpace: spaceKeys.map(space => {
      const inSpace = live.filter(record => spaceOf(record) === space);
      return { space, count: inSpace.length, pending: inSpace.filter(record => isRecord(record) && record.reviewState === "pending").length };
    }),
    bySource: [...new Set(live.map(record => record.source).filter(source => source !== "manual")).values()].sort().concat("manual")
      .map(source => ({ source, count: live.filter(record => record.source === source).length })),
    daily: Array.from({ length: days }, (_, index) => {
      const date = addDays(today, index - days + 1);
      return { date, count: counts.get(date) ?? 0 };
    }),
  };
}
/** One-line preview: conclusion, then summary, then body, whitespace collapsed. */
export function excerpt(record: DashboardRecord) {
  const text = textField(record, "conclusion") || textField(record, "summary") || record.body;
  return text.replace(/\s+/g, " ").trim();
}
export function hostOf(record: Pick<DashboardRecord, "links">) {
  const url = record.links[0]?.url;
  return url ? new URL(url).hostname.replace(/^www\./, "") : "";
}
function aiFillState(record: DashboardRecord) {
  const state = record.fields.aiFill;
  if (state === null || typeof state !== "object" || Array.isArray(state) || state.status !== "filled") return null;
  const original = state.original;
  if (original === null || typeof original !== "object" || Array.isArray(original)) return null;
  return { state, title: typeof original.title === "string" ? original.title : record.title,
    summary: typeof original.summary === "string" ? original.summary : "" };
}
export const aiFilled = (record: DashboardRecord) => aiFillState(record) !== null;
/** Restores the values saved before the model filled them; the reverted mark stops the server refilling. */
export function aiFillRevert(record: DashboardRecord) {
  const fill = aiFillState(record);
  if (!fill) return null;
  return { title: fill.title || record.title, fields: { ...record.fields, summary: fill.summary, aiFill: { ...fill.state, status: "reverted" } } };
}
export function blankRecord(kind: RecordKind): RecordInput {
  return {
    kind, title: "", body: "", status: kind === "project" ? "idea" : kind === "task" ? "todo" : "new",
    projectId: null, taskId: null, dueDate: null, tags: [], links: [],
    fields: kind === "task" ? { today: true } : {},
  };
}
