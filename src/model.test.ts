import { expect, test } from "bun:test";
import { DashboardRecordSchema, DigestSummarySchema } from "../shared/contracts";
import { applyLocale } from "./i18n";
import { aiFilled, aiFillRevert, channelOf, confirmationChanges, digest, viewRecords, weekBounds, excerpt, groupByDay, homeRouteOf, hostOf, inboxItems, inboxStateOf, inQueue, libraryItems, listedFor, nextInQueue, revisitDue } from "./model";
import { dateLabel, digestCounts, digestUnread, inboxBadge, listedDigestsFor, withDigestReads } from "./model";

test("date labels read the language at the moment they are formatted", () => {
  try {
    applyLocale("en");
    expect(dateLabel("2026-10-02")).toBe("October 2");
    applyLocale("ko");
    expect(dateLabel("2026-10-02")).toBe("10월 2일");
  } finally { applyLocale("ko"); }
});

const record = DashboardRecordSchema.parse({
  id: "0db63b14-e45e-4b84-9e6c-dee3fc02592a", kind: "research", title: "Due record",
  source: "omo", createdBy: "omo", reviewState: "pending", archivedAt: null,
  createdAt: "2026-09-20T00:00:00Z", updatedAt: "2026-09-20T00:00:00Z", version: 1,
  fields: { revisitDate: "2026-09-20", summary: "Keep this", starred: true },
});

test("confirming only sets reviewState and keeps the revisit marker and content", () => {
  // Given: a pending record whose review date has arrived.
  expect(inQueue(record, "2026-09-21")).toBe(true);
  // When: confirmation changes are applied.
  const changes = confirmationChanges(record);
  expect(changes).toEqual({ reviewState: "approved" });
  const confirmed = DashboardRecordSchema.parse({ ...record, ...changes });
  // Then: it is approved, the due revisit still queues it, and nothing else changes.
  expect(confirmed.fields).toEqual({ revisitDate: "2026-09-20", summary: "Keep this", starred: true });
  expect(revisitDue(confirmed, "2026-09-21")).toBe(true);
  expect(inQueue(confirmed, "2026-09-21")).toBe(true);
  // And: an approved record has nothing to confirm.
  expect(confirmationChanges(confirmed)).toBeNull();
  // And: clearing the revisit date empties the queue.
  expect(inQueue({ ...confirmed, fields: { ...confirmed.fields, revisitDate: null } }, "2026-09-21")).toBe(false);
});

test("inQueue holds pending or revisit-due material only", () => {
  const pending = { ...record, fields: {} };
  const approvedDue = { ...record, reviewState: "approved" as const };
  const approved = { ...record, reviewState: "approved" as const, fields: {} };
  const approvedFuture = { ...record, reviewState: "approved" as const, fields: { revisitDate: "2026-09-28" } };
  expect(inQueue(pending, "2026-09-21")).toBe(true);
  expect(inQueue(approvedDue, "2026-09-21")).toBe(true);
  expect(inQueue(approved, "2026-09-21")).toBe(false);
  expect(inQueue(approvedFuture, "2026-09-21")).toBe(false);
  expect(inQueue({ ...approvedDue, archivedAt: "2026-09-21T00:00:00Z" }, "2026-09-21")).toBe(false);
});

const make = (id: string, patch: Record<string, unknown>) => DashboardRecordSchema.parse({
  id, kind: "social", title: "t", source: "manual", createdBy: "owner", reviewState: "approved", archivedAt: null,
  createdAt: "2026-09-20T00:00:00Z", updatedAt: "2026-09-20T00:00:00Z", version: 1, fields: {}, ...patch,
});

test("digest counts live records by space, source and Seoul day", () => {
  // Given: records across spaces, one archived, one created just after midnight in Seoul.
  const records = [
    make("00000000-0000-4000-8000-000000000001", { kind: "research", source: "omo", createdBy: "omo", reviewState: "pending", createdAt: "2026-09-20T16:00:00Z" }),
    make("00000000-0000-4000-8000-000000000002", { kind: "note", source: "chatgpt", createdBy: "chatgpt", createdAt: "2026-09-21T01:00:00Z" }),
    make("00000000-0000-4000-8000-000000000003", { fields: { demo: true }, createdAt: "2026-09-01T00:00:00Z" }),
    make("00000000-0000-4000-8000-000000000004", { archivedAt: "2026-09-21T00:00:00Z" }),
  ];
  // When: the home digest is computed for 2026-09-21.
  const result = digest(records, "2026-09-21", 7);
  // Then: archived records are ignored and the Seoul date decides the bucket.
  expect(result.total).toBe(3);
  expect(result.samples).toBe(1);
  expect(result.queue).toBe(1);
  expect(result.weekNew).toBe(2);
  expect(result.bySpace.map(item => [item.space, item.count, item.pending])).toEqual([["projects", 0, 0], ["tasks", 1, 0], ["research", 1, 1], ["social", 1, 0]]);
  expect(result.bySource).toEqual([{ source: "chatgpt", count: 1 }, { source: "omo", count: 1 }, { source: "manual", count: 1 }]);
  expect(result.daily).toHaveLength(7);
  expect(result.daily.at(-1)).toEqual({ date: "2026-09-21", count: 2 });
  expect(result.daily.at(0)?.date).toBe("2026-09-15");
});

test("excerpt prefers the conclusion, then summary, then body, collapsed", () => {
  expect(excerpt(make("00000000-0000-4000-8000-000000000005", { body: "본문", fields: { summary: "요약", conclusion: "결론\n  한 줄" } }))).toBe("결론 한 줄");
  expect(excerpt(make("00000000-0000-4000-8000-000000000006", { body: "본문", fields: { summary: "요약" } }))).toBe("요약");
  expect(excerpt(make("00000000-0000-4000-8000-000000000007", { body: "# 제목\n\n본문   내용" }))).toBe("# 제목 본문 내용");
});

test("hostOf returns the first link host without www", () => {
  expect(hostOf(make("00000000-0000-4000-8000-000000000008", { links: [{ label: "원문", url: "https://www.threads.com/@a/post/1" }] }))).toBe("threads.com");
  expect(hostOf(make("00000000-0000-4000-8000-000000000009", {}))).toBe("");
});

test("confirmation does not discard a future revisit commitment", () => {
  const future = { ...record, fields: { ...record.fields, revisitDate: "2026-09-28" } };
  const confirmed = DashboardRecordSchema.parse({ ...future, ...confirmationChanges(future) });
  expect(confirmed.reviewState).toBe("approved");
  expect(confirmed.fields.revisitDate).toBe("2026-09-28");
  expect(inQueue(confirmed, "2026-09-21")).toBe(false);
});

test("reverting an automatic fill restores the saved title and summary and blocks refilling", () => {
  // Given: a link whose placeholder title and summary were filled by the model.
  const filled = DashboardRecordSchema.parse({ ...record, kind: "social", title: "잭 도시의 첫 트윗", fields: { summary: "첫 트윗이다.", origin: "x",
    aiFill: { status: "filled", attempts: 1, filled: ["title", "summary"], original: { title: "jack (@jack) on X", summary: "" } } } });
  expect(aiFilled(filled)).toBe(true);
  // When: the owner reverts it.
  const changes = aiFillRevert(filled);
  const reverted = DashboardRecordSchema.parse({ ...filled, ...changes });
  // Then: original values return, other fields stay, and the fill is marked reverted.
  expect(reverted.title).toBe("jack (@jack) on X");
  expect(reverted.fields).toMatchObject({ summary: "", origin: "x", aiFill: { status: "reverted" } });
  expect(aiFilled(reverted)).toBe(false);
  expect(aiFillRevert(reverted)).toBeNull();
});

test("channelOf separates agent sources, iPhone share captures and direct entries", () => {
  expect(channelOf(make("00000000-0000-4000-8000-000000000010", { source: "chatgpt", createdBy: "chatgpt" }))).toBe("chatgpt");
  expect(channelOf(make("00000000-0000-4000-8000-000000000011", { fields: { captureEnrichment: { status: "available" } } }))).toBe("share");
  expect(channelOf(make("00000000-0000-4000-8000-000000000012", { kind: "note" }))).toBe("manual");
});

test("inbox holds only unconfirmed or due material, newest first", () => {
  // Given: a pending report, a newer pending link, a confirmed note and a pending-looking task.
  const items = [
    make("00000000-0000-4000-8000-000000000020", { kind: "research", reviewState: "pending", createdAt: "2026-09-19T00:00:00Z" }),
    make("00000000-0000-4000-8000-000000000021", { reviewState: "pending", createdAt: "2026-09-20T00:00:00Z" }),
    make("00000000-0000-4000-8000-000000000022", { kind: "note" }),
    make("00000000-0000-4000-8000-000000000023", { kind: "task", status: "review", reviewState: "pending" }),
  ];
  // When / Then: only the two pending materials remain, newest first.
  expect(inboxItems(items, "2026-09-21").map(item => item.id.slice(-2))).toEqual(["21", "20"]);
});

test("library filters by kind, channel and star, never lists archived material, and searches saved summaries", () => {
  // Given: live, starred and archived material from different channels.
  const items = [
    make("00000000-0000-4000-8000-000000000030", { fields: { summary: "검색용설명 링크" } }),
    make("00000000-0000-4000-8000-000000000031", { kind: "research", source: "omo", createdBy: "omo", fields: { starred: true } }),
    make("00000000-0000-4000-8000-000000000032", { archivedAt: "2026-09-21T00:00:00Z" }),
    make("00000000-0000-4000-8000-000000000033", { kind: "project" }),
  ];
  const ids = (filter: Parameters<typeof libraryItems>[1]) => libraryItems(items, filter).map(item => item.id.slice(-2)).sort();
  // When / Then: each filter narrows to the matching records only.
  expect(ids({})).toEqual(["30", "31"]);
  expect(ids({ q: "검색용설명" })).toEqual(["30"]);
  expect(ids({ type: "research" })).toEqual(["31"]);
  expect(ids({ channel: "omo" })).toEqual(["31"]);
  expect(ids({ starred: true })).toEqual(["31"]);
});

test("the archive lists archived records of every kind, latest first, and the trash lists no records", () => {
  // Given: an archived note, a later-archived task and a live link.
  const note = make("00000000-0000-4000-8000-0000000000b1", { kind: "note", archivedAt: "2026-09-21T00:00:00Z" });
  const task = make("00000000-0000-4000-8000-0000000000b2", { kind: "task", status: "done", archivedAt: "2026-09-22T00:00:00Z" });
  const live = make("00000000-0000-4000-8000-0000000000b3", {});
  const all = [note, live, task];
  // Then: the archive route lists both archived records, most recently archived first, and the trash route lists nothing.
  expect(listedFor({ view: "archive", id: null, params: {} }, all, "2026-09-22").map(item => item.id)).toEqual([task.id, note.id]);
  expect(listedFor({ view: "trash", id: null, params: {} }, all, "2026-09-22")).toEqual([]);
  // And: archived records of any kind live in the archive; the live link stays in the library.
  expect(homeRouteOf(note)).toEqual({ view: "archive", params: {} });
  expect(homeRouteOf(task)).toEqual({ view: "archive", params: {} });
  expect(homeRouteOf(live, "2026-09-22")).toEqual({ view: "library", params: {} });
});

test("the inbox keeps the open record listed after it is confirmed, in date order, only while it is selected", () => {
  // Given: two pending links around a confirmed one, plus an archived link and a task under review.
  const older = make("00000000-0000-4000-8000-0000000000c1", { reviewState: "pending", createdAt: "2026-09-19T00:00:00Z" });
  const opened = make("00000000-0000-4000-8000-0000000000c2", { createdAt: "2026-09-20T00:00:00Z" });
  const newer = make("00000000-0000-4000-8000-0000000000c3", { reviewState: "pending", createdAt: "2026-09-21T00:00:00Z" });
  const archived = make("00000000-0000-4000-8000-0000000000c4", { archivedAt: "2026-09-21T00:00:00Z" });
  const task = make("00000000-0000-4000-8000-0000000000c5", { kind: "task", status: "review" });
  const all = [older, opened, newer, archived, task];
  const ids = (id: string | null, params: Record<string, string> = { state: "pending" }) => listedFor({ view: "inbox", id, params }, all, "2026-09-22").map(item => item.id);
  // Then: under 미확인 the confirmed record is listed between its neighbours while it is the open one, and not otherwise.
  expect(ids(opened.id)).toEqual([newer.id, opened.id, older.id]);
  expect(ids(null)).toEqual([newer.id, older.id]);
  expect(ids(newer.id)).toEqual([newer.id, older.id]);
  // And: an archived record or a task never sticks, and the search still applies to the open record.
  expect(ids(archived.id)).toEqual([newer.id, older.id]);
  expect(ids(task.id)).toEqual([newer.id, older.id]);
  expect(ids(opened.id, { state: "pending", q: "없는 검색어" })).toEqual([]);
});

test("the inbox 확인 filter lists every unarchived material by default, the queue for 미확인 and confirmed material for 확인함", () => {
  // Given: pending, confirmed and rejected material, an archived record and a task under review.
  const pending = make("00000000-0000-4000-8000-0000000000d1", { reviewState: "pending", createdAt: "2026-09-21T00:00:00Z" });
  const approved = make("00000000-0000-4000-8000-0000000000d2", { title: "알파 메모", createdAt: "2026-09-20T00:00:00Z" });
  const rejected = make("00000000-0000-4000-8000-0000000000d3", { reviewState: "rejected", createdAt: "2026-09-19T00:00:00Z" });
  const archived = make("00000000-0000-4000-8000-0000000000d4", { archivedAt: "2026-09-21T00:00:00Z" });
  const task = make("00000000-0000-4000-8000-0000000000d5", { kind: "task", status: "review" });
  const all = [rejected, task, approved, archived, pending];
  const ids = (params: Record<string, string>) => listedFor({ view: "inbox", id: null, params }, all, "2026-09-22").map(item => item.id);
  // Then: no or an unknown state is 전체, all unarchived material newest first; 미확인 is the queue; 확인함 lists only approved material.
  expect(ids({})).toEqual([pending.id, approved.id, rejected.id]);
  expect(ids({ state: "bogus" })).toEqual([pending.id, approved.id, rejected.id]);
  expect(ids({ state: "pending" })).toEqual([pending.id]);
  expect(ids({ state: "approved" })).toEqual([approved.id]);
  expect(inboxStateOf({})).toBe("all");
  // And: the search narrows whichever filter is chosen.
  expect(ids({ q: "알파" })).toEqual([approved.id]);
  expect(ids({ state: "pending", q: "알파" })).toEqual([]);
});

test("groupByDay labels Seoul days as 오늘, 어제 and dates", () => {
  const groups = groupByDay([
    { createdAt: "2026-09-21T01:00:00Z" }, { createdAt: "2026-09-20T16:30:00Z" },
    { createdAt: "2026-09-20T01:00:00Z" }, { createdAt: "2026-09-10T01:00:00Z" },
  ], "2026-09-21");
  expect(groups.map(group => [group.label, group.items.length])).toEqual([["오늘", 2], ["어제", 1], ["9월 10일", 1]]);
});

test("a reader route lists its record, and every record has a home route that lists it", () => {
  // Given: an archived link, a task outside today, and a project.
  const archived = make("00000000-0000-4000-8000-0000000000a1", { archivedAt: "2026-09-21T00:00:00Z" });
  const task = make("00000000-0000-4000-8000-0000000000a2", { kind: "task", status: "todo", reviewState: "approved" });
  const project = make("00000000-0000-4000-8000-0000000000a3", { kind: "project", status: "active", reviewState: "approved" });
  const all = [archived, task, project];
  // Then: the default library and today's work list leave them out, the default 할 일 list (전체) has the task, and their home routes include them.
  expect(listedFor({ view: "library", id: null, params: {} }, all, "2026-09-22").map(item => item.id)).not.toContain(archived.id);
  expect(listedFor({ view: "work", id: null, params: { filter: "today" } }, all, "2026-09-22").map(item => item.id)).not.toContain(task.id);
  expect(listedFor({ view: "work", id: null, params: {} }, all, "2026-09-22").map(item => item.id)).toContain(task.id);
  for (const item of all) {
    const home = homeRouteOf(item);
    expect(listedFor({ ...home, id: item.id }, all, "2026-09-22").map(listed => listed.id)).toContain(item.id);
  }
});

test("leaving the queue opens the next item, then the previous one, then nothing", () => {
  const [a, b, c] = ["a", "b", "c"].map((letter, index) => make(`00000000-0000-4000-8000-00000000000${index + 1}`, { title: letter }));
  if (!a || !b || !c) throw new Error("fixture");
  expect(nextInQueue([a, b, c], b.id)?.id).toBe(c.id);
  expect(nextInQueue([a, b, c], c.id)?.id).toBe(b.id);
  expect(nextInQueue([a], a.id)).toBeNull();
});

test("the week runs Sunday to Saturday in Seoul", () => {
  expect(weekBounds("2026-09-27")).toEqual({ start: "2026-09-27", end: "2026-10-03" });
  expect(weekBounds("2026-09-28").start).toBe("2026-09-27");
  expect(weekBounds("2026-10-03").start).toBe("2026-09-27");
  const task = make("00000000-0000-4000-8000-000000000031", { kind: "task", status: "todo", dueDate: "2026-09-27" });
  expect(viewRecords([task], "tasks", "week", "2026-09-30").map(item => item.id)).toEqual([task.id]);
  expect(viewRecords([task], "tasks", "week", "2026-10-04")).toEqual([]);
});

const brief = (id: string, patch: Record<string, unknown> = {}) => DigestSummarySchema.parse({
  id, date: "2026-09-21", slot: "morning", scheduledAt: "2026-09-20T23:00:00Z", createdBy: "omo",
  createdAt: "2026-09-20T23:00:00Z", updatedAt: "2026-09-20T23:00:00Z", version: 1, articlesReadAt: null, messagesReadAt: null, readAt: null,
  counts: { inbox: 2, local: 2, ai: 7 }, outline: [{ key: "inbox", title: "Inbox", kind: "messages", items: 2 }, { key: "local", title: "Local", kind: "articles", items: 2 }, { key: "ai", title: "AI", kind: "articles", items: 7 }],
  headlines: ["첫 기사"], messageHeadline: "중요 메일", urgent: 0, todo: 0, ...patch,
});
const articlesOnly = (items: number) => ({ counts: { local: items }, outline: [{ key: "local", title: "Local", kind: "articles", items }] });
const title = (slot: string) => slot === "morning" ? "아침 다이제스트" : "저녁 다이제스트";

test("a digest is unread while any part with items is unread, and the read overlay wins over the summary", () => {
  // Given: a morning digest with articles and messages, an articles-only evening whose articles are read, and one with an empty messages section.
  const morning = brief("00000000-0000-4000-8000-0000000000e1");
  const evening = brief("00000000-0000-4000-8000-0000000000e2", { slot: "evening", ...articlesOnly(3), articlesReadAt: "2026-09-21T13:00:00Z" });
  const emptyMessages = brief("00000000-0000-4000-8000-0000000000e3", { counts: { inbox: 0, local: 1 },
    outline: [{ key: "inbox", title: "Inbox", kind: "messages", items: 0 }, { key: "local", title: "Local", kind: "articles", items: 1 }], articlesReadAt: "2026-09-21T13:00:00Z" });
  // Then: the morning waits, the read evening and the read articles with an empty messages section do not.
  expect([morning, evening, emptyMessages].map(digestUnread)).toEqual([true, false, false]);
  // When: the overlay marks the morning's articles read, the messages still wait; with both read it is done.
  const articlesRead = new Map([[`${morning.id}:articles`, "2026-09-21T00:00:00Z"]]);
  expect(digestUnread(withDigestReads(morning, articlesRead))).toBe(true);
  expect(digestUnread(withDigestReads(morning, new Map([...articlesRead, [`${morning.id}:messages`, "2026-09-21T00:00:00Z"]])))).toBe(false);
  // And: the meta counts list sections with items under their titles, in stored order.
  expect(digestCounts(morning)).toBe("Inbox 2 · Local 2 · AI 7");
});

test("the inbox lists digests per 확인 filter newest first, keeps the open one under 미확인 and matches the search", () => {
  // Given: an unread morning, a read evening of the day before, and an unread older morning.
  const unread = brief("00000000-0000-4000-8000-0000000000f1", { scheduledAt: "2026-09-21T23:00:00Z", headlines: ["반도체 소식"] });
  const read = brief("00000000-0000-4000-8000-0000000000f2", { slot: "evening", scheduledAt: "2026-09-21T12:00:00Z",
    articlesReadAt: "2026-09-21T13:00:00Z", messagesReadAt: "2026-09-21T13:00:00Z" });
  const older = brief("00000000-0000-4000-8000-0000000000f3", { scheduledAt: "2026-09-19T23:00:00Z", messageHeadline: "계약서 회신" });
  const all = [older, read, unread];
  const ids = (params: Record<string, string>, id: string | null = null) => listedDigestsFor({ view: "inbox", id, params }, all, title).map(item => item.id);
  // Then: 전체 lists every digest newest first, 미확인 the unread ones, 확인함 the read one.
  expect(ids({})).toEqual([unread.id, read.id, older.id]);
  expect(ids({ state: "pending" })).toEqual([unread.id, older.id]);
  expect(ids({ state: "approved" })).toEqual([read.id]);
  // And: the open, read digest stays listed under 미확인 in its place.
  expect(ids({ state: "pending" }, read.id)).toEqual([unread.id, read.id, older.id]);
  // And: the search matches the slot title, an article headline and the message headline.
  expect(ids({ q: "저녁" })).toEqual([read.id]);
  expect(ids({ q: "반도체" })).toEqual([unread.id]);
  expect(ids({ q: "계약서" })).toEqual([older.id]);
  expect(ids({ state: "pending", q: "없는 말" }, read.id)).toEqual([]);
});

test("the 받은 항목 badge counts queued records plus digests with an unread part", () => {
  // Given: one pending record, one approved record, one unread and one read digest.
  const records = [make("00000000-0000-4000-8000-0000000000f4", { reviewState: "pending" }), make("00000000-0000-4000-8000-0000000000f5", {})];
  const digests = [brief("00000000-0000-4000-8000-0000000000f6"),
    brief("00000000-0000-4000-8000-0000000000f7", { articlesReadAt: "2026-09-21T00:00:00Z", messagesReadAt: "2026-09-21T00:00:00Z" })];
  // Then: the badge is 1 record + 1 digest.
  expect(inboxBadge(records, digests, "2026-09-22")).toBe(2);
  expect(inboxBadge(records, [], "2026-09-22")).toBe(1);
});
