import { parseArgs } from "node:util";
import { HTTPError } from "ky";
import { z } from "zod";
import { DocumentStateSchema, NarrationStateSchema, NarrationStyleSchema } from "../shared/contracts";
import type { NarrationState } from "../shared/contracts";
import { getDocument, getNarration, getRecord, putDocument, listComments, listDigests, markComment, postComment, postDigest, readShared, requestNarration, searchRecords, sendRecord, updateRecord } from "./agent-client";

let readingShared = false;
type Action = "save" | "get" | "update" | "search" | "task" | "report" | "comments" | "mark" | "reply" | "timeline" | "narrate" | "digest" | "digests";
let action: Action = "save";
const labels: Record<Action, string> = {
  save: "Save", get: "Read", update: "Update", search: "Search", task: "Create task", report: "Report",
  comments: "List comments", mark: "Mark comment", reply: "Reply", timeline: "Read timeline", narrate: "Narration",
  digest: "Upload digest", digests: "List digests",
};
/** What an agent needs from a narration: its state, and an absolute audio URL once there is audio. */
const narrationSummary = (state: NarrationState, base: string) => {
  const narration = state.narration;
  return {
    available: state.available, status: narration?.status ?? "none", style: narration?.style ?? null, stale: narration?.stale ?? false,
    progress: narration?.progress ?? null, attempts: narration?.attempts ?? 0, error: narration?.error ?? null,
    durationMs: narration?.audio?.durationMs ?? null, audioUrl: narration?.audio ? new URL(narration.audio.url, base).href : null,
  };
};
const pageSchema = z.object({ items: z.array(z.object({
  id: z.string(), kind: z.string(), title: z.string(), source: z.string(), reviewState: z.string(), createdAt: z.string(),
  fields: z.record(z.string(), z.unknown()),
}).passthrough()), nextCursor: z.string().nullable() });
const queueSchema = z.object({ items: z.array(z.object({
  id: z.string(), recordId: z.string(), recordTitle: z.string(), body: z.string(), createdAt: z.string(),
  seenAt: z.string().nullable(), doneAt: z.string().nullable(),
}).passthrough()) });
const savedSchema = z.object({ record: z.object({ id: z.string(), title: z.string(), status: z.string(), version: z.number() }).passthrough() }).passthrough();
const commentSchema = z.object({
  comment: z.object({ id: z.string(), recordId: z.string(), replyTo: z.string().nullable(), status: z.string().nullable(), createdAt: z.string() }).passthrough(),
  record: z.object({ status: z.string(), version: z.number() }).passthrough().nullable(),
  replayed: z.boolean(),
});
const statusSchema = z.enum(["todo", "active", "review", "paused", "done"]);
const text = (value: unknown) => typeof value === "string" ? value : "";
const list = (value: string | undefined) => (value ?? "").split(",").map(item => item.trim()).filter(Boolean);
const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
try {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      token: { type: "string" },
      file: { type: "string" },
      "request-id": { type: "string" },
      url: { type: "string" },
      shared: { type: "string" },
      get: { type: "string" },
      update: { type: "string" },
      search: { type: "string" },
      kind: { type: "string" },
      limit: { type: "string" },
      cursor: { type: "string" },
      "expected-version": { type: "string" },
      "new-task": { type: "string" },
      text: { type: "string" },
      tags: { type: "string" },
      status: { type: "string" },
      evidence: { type: "string" },
      report: { type: "string" },
      comments: { type: "boolean" },
      state: { type: "string" },
      wait: { type: "boolean" },
      interval: { type: "string" },
      timeout: { type: "string" },
      "no-ack": { type: "boolean" },
      seen: { type: "string" },
      done: { type: "string" },
      reply: { type: "string" },
      resolve: { type: "boolean" },
      timeline: { type: "string" },
      narrate: { type: "string" },
      narration: { type: "string" },
      force: { type: "boolean" },
      style: { type: "string" },
      digest: { type: "string" },
      quiet: { type: "boolean" },
      digests: { type: "boolean" },
      from: { type: "string" },
      to: { type: "string" },
      html: { type: "string" },
      help: { type: "boolean" },
    },
  });
  const base = values.url ?? process.env["DASHBOARD_URL"] ?? "http://127.0.0.1:4310";
  // The agent's own key: --token, or DASHBOARD_TOKEN (preferred; it keeps the key out of shell history and process lists).
  const connect = async () => ({ url: base, token: z.string().trim().min(1, "Set DASHBOARD_TOKEN to this agent's key").parse(values.token ?? process.env["DASHBOARD_TOKEN"]) });
  const requestId = () => z.string().min(1).max(128).parse(values["request-id"] ?? crypto.randomUUID());
  const status = () => values.status === undefined ? undefined : statusSchema.parse(values.status);
  /** --html <file>: the full document to attach; only its size and time are printed, never the HTML. */
  const attach = async (connection: Awaited<ReturnType<typeof connect>>, id: string) => {
    if (values.html === undefined) return {};
    const html = await Bun.file(z.string().min(1).parse(values.html)).text();
    const { document } = DocumentStateSchema.parse(await putDocument(connection, id, html));
    return { document: document && { bytes: document.bytes, updatedAt: document.updatedAt } };
  };
  if (values.help) {
    console.log(
      "Every command reads the agent's key from DASHBOARD_TOKEN (or --token) and the dashboard from DASHBOARD_URL (or --url; default http://127.0.0.1:4310).\n\n" +
      "Save:        bun run agent --file record.json --request-id unique-id [--html document.html]\n" +
        "Read:        bun run agent --get <record-id>   (with the attached document's size and time)\n" +
        "Update:      bun run agent --update <record-id> [--expected-version <n> --file changes.json] [--html document.html]\n" +
        "Search:      bun run agent --search \"words\" [--kind research|work-report|note|social|task|project] [--limit 1-50] [--cursor <nextCursor>]\n" +
        "Shared:      bun run agent --shared <code|share-url>\n" +
        "New task:    bun run agent --new-task \"Title\" --tags topic1,topic2 [--text \"Details\"] [--status todo|active|review|paused|done] [--evidence <record-id,...>] [--request-id id]\n" +
        "Report:      bun run agent --report <task-id> [--text \"What happened\"] [--status active|review|done|...] [--request-id id]\n" +
        "Comments:    bun run agent --comments [--state new|open|all] [--no-ack]   (fetched new comments are marked seen)\n" +
        "Wait:        bun run agent --comments --wait [--interval 5] [--timeout 0]   (prints when a new comment arrives; exit code 2 on timeout)\n" +
        "Reply:       bun run agent --reply <comment-id> --text \"Answer\" [--resolve] [--status review]\n" +
        "Mark:        bun run agent --seen <comment-id> | --done <comment-id>\n" +
        "Timeline:    bun run agent --timeline <task-id>\n" +
        "Narrate:     bun run agent --narrate <record-id> [--style read|podcast] [--force] [--wait] [--interval 5] [--timeout 900]   (done 0, failed 1, timeout 2; without --style the last style, read at first)\n" +
        "Narration:   bun run agent --narration <record-id>\n" +
        "Digest:      bun run agent --digest digest.json [--quiet]   (the POST /api/v1/digests body)\n" +
        "Digests:     bun run agent --digests [--from YYYY-MM-DD] [--to YYYY-MM-DD]",
    );
  } else if (values.digest !== undefined) {
    action = "digest";
    const input = z.record(z.string(), z.unknown()).parse(await Bun.file(z.string().min(1).parse(values.digest)).json());
    if (values.quiet) input["notify"] = false;
    const result = z.object({ digest: z.object({ id: z.string(), date: z.string(), slot: z.string(), version: z.number(),
      sections: z.array(z.object({ key: z.string(), items: z.array(z.unknown()) }).passthrough()) }).passthrough(),
      created: z.boolean(), changed: z.array(z.string()), notified: z.boolean() }).parse(await postDigest(await connect(), input));
    const { digest } = result;
    print({ id: digest.id, date: digest.date, slot: digest.slot, version: digest.version, created: result.created, changed: result.changed,
      notified: result.notified, counts: Object.fromEntries(digest.sections.map(section => [section.key, section.items.length])) });
  } else if (values.digests) {
    action = "digests";
    print(await listDigests(await connect(), { ...(values.from ? { from: values.from } : {}), ...(values.to ? { to: values.to } : {}) }));
  } else if (values.shared !== undefined) {
    readingShared = true;
    const shared = z.string().trim().min(1).parse(values.shared);
    const url = /^https?:\/\//i.test(shared)
      ? shared
      : new URL(`/s/${encodeURIComponent(shared)}`, base).href;
    process.stdout.write(await readShared(url));
  } else if (values.search !== undefined) {
    action = "search";
    const page = pageSchema.parse(await searchRecords(await connect(), {
      q: values.search.trim(),
      ...(values.kind ? { kind: values.kind } : {}),
      ...(values.limit ? { limit: z.coerce.number().int().min(1).max(50).parse(values.limit) } : {}),
      ...(values.cursor ? { cursor: values.cursor } : {}),
    }));
    // Search lists what to open; --get <id> prints the full record.
    print({
      items: page.items.map(({ id, kind, title, source, reviewState, createdAt, fields }) =>
        ({ id, kind, title, source, reviewState, createdAt, summary: text(fields.summary), conclusion: text(fields.conclusion) })),
      nextCursor: page.nextCursor,
    });
  } else if (values.get !== undefined) {
    action = "get";
    const id = z.string().trim().min(1).parse(values.get);
    const connection = await connect();
    const record = z.record(z.string(), z.unknown()).parse(await getRecord(connection, id));
    const { document } = DocumentStateSchema.parse(await getDocument(connection, id));
    print({ ...record, document: document && { bytes: document.bytes, updatedAt: document.updatedAt } });
  } else if (values.update !== undefined) {
    action = "update";
    const id = z.string().trim().min(1).parse(values.update);
    const connection = await connect();
    if (values.file === undefined && values.html === undefined) z.string().parse(values.file);
    const updated = values.file === undefined ? {} : z.record(z.string(), z.unknown()).parse(await updateRecord(connection, id, {
      expectedVersion: z.coerce.number().int().positive().parse(values["expected-version"]),
      changes: await Bun.file(values.file).json(),
    }));
    print({ ...updated, ...await attach(connection, id) });
  } else if (values["new-task"] !== undefined) {
    action = "task";
    const id = requestId();
    const evidenceIds = list(values.evidence);
    const result = savedSchema.parse(await sendRecord(await connect(), { requestId: id, record: {
      kind: "task", title: z.string().trim().min(1).parse(values["new-task"]), body: values.text ?? "",
      status: status() ?? "active", tags: list(values.tags), fields: evidenceIds.length ? { evidenceIds } : {},
    } }));
    print({ requestId: id, id: result.record.id, title: result.record.title, status: result.record.status, version: result.record.version });
  } else if (values.report !== undefined || values.reply !== undefined) {
    action = values.report !== undefined ? "report" : "reply";
    const id = requestId();
    const target = values.report !== undefined
      ? { recordId: z.string().trim().min(1).parse(values.report) }
      : { replyTo: z.string().trim().min(1).parse(values.reply), ...(values.resolve ? { done: true } : {}) };
    const nextStatus = status();
    const result = commentSchema.parse(await postComment(await connect(), {
      requestId: id, ...target, body: values.text ?? "", ...(nextStatus ? { status: nextStatus } : {}),
    }));
    print({ requestId: id, comment: result.comment, ...(result.record ? { status: result.record.status, version: result.record.version } : {}), replayed: result.replayed });
  } else if (values.comments) {
    action = "comments";
    const connection = await connect();
    const state = z.enum(["new", "open", "all"]).parse(values.state ?? (values.wait ? "new" : "open"));
    const interval = z.coerce.number().min(2).max(300).parse(values.interval ?? "5");
    const timeout = z.coerce.number().min(0).parse(values.timeout ?? "0");
    const started = Date.now();
    let items = queueSchema.parse(await listComments(connection, { state })).items;
    // --wait polls the same list until an unseen comment arrives, so a watcher can block on this command.
    while (values.wait && items.length === 0) {
      if (timeout > 0 && Date.now() - started >= timeout * 1000) {
        print({ items: [], timedOut: true });
        process.exit(2);
      }
      await Bun.sleep(interval * 1000);
      items = queueSchema.parse(await listComments(connection, { state })).items;
    }
    const acked = values["no-ack"] ? [] : items.filter(item => item.seenAt === null && item.doneAt === null).map(item => item.id);
    for (const id of acked) await markComment(connection, id, "seen");
    print({ items: items.map(({ id, recordId, recordTitle, body, createdAt, seenAt, doneAt }) =>
      ({ id, recordId, recordTitle, body, createdAt, seenAt, doneAt })), markedSeen: acked });
  } else if (values.seen !== undefined || values.done !== undefined) {
    action = "mark";
    const mark = values.done !== undefined ? "done" : "seen";
    print(await markComment(await connect(), z.string().trim().min(1).parse(values.done ?? values.seen), mark));
  } else if (values.narrate !== undefined || values.narration !== undefined) {
    action = "narrate";
    const connection = await connect();
    const id = z.string().trim().min(1).parse(values.narrate ?? values.narration);
    const interval = z.coerce.number().min(2).max(300).parse(values.interval ?? "5");
    const timeout = z.coerce.number().min(0).parse(values.timeout ?? "900");
    const style = values.style === undefined ? undefined : NarrationStyleSchema.parse(values.style);
    const started = Date.now();
    let state = NarrationStateSchema.parse(values.narrate !== undefined
      ? await requestNarration(connection, id, values.force === true, style) : await getNarration(connection, id));
    // --wait follows the job until it settles, so an agent can save, narrate and report the audio in one step.
    while (values.wait && state.narration && ["queued", "scripting", "speaking"].includes(state.narration.status)) {
      if (timeout > 0 && Date.now() - started >= timeout * 1000) {
        print({ ...narrationSummary(state, base), timedOut: true });
        process.exit(2);
      }
      await Bun.sleep(interval * 1000);
      state = NarrationStateSchema.parse(await getNarration(connection, id));
    }
    print(narrationSummary(state, base));
    if (state.narration?.status === "failed") process.exitCode = 1;
  } else if (values.timeline !== undefined) {
    action = "timeline";
    print(await listComments(await connect(), { recordId: z.string().trim().min(1).parse(values.timeline) }));
  } else {
    const file = z.string().min(1).parse(values.file);
    const id = z.string().min(1).max(128).parse(values["request-id"]);
    const connection = await connect();
    const saved = savedSchema.parse(await sendRecord(connection, {
      requestId: id,
      record: await Bun.file(file).json(),
    }));
    print({ ...saved, ...await attach(connection, saved.record.id) });
  }
} catch (error) {
  const label = labels[action];
  if (readingShared && error instanceof HTTPError && error.response.status === 404) {
    console.error("Shared record not found.");
  } else if (readingShared && error instanceof HTTPError) {
    console.error(`Reading the shared record failed: HTTP ${error.response.status}`);
  } else if (error instanceof HTTPError) {
    console.error(`${label} failed: HTTP ${error.response.status}`);
    console.error(await error.response.text());
    if (action === "update" && error.response.status === 409) {
      console.error("Someone changed it first. Read it again with --get, rebuild the changes on the latest content and send them with the new --expected-version.");
    }
  } else if (error instanceof z.ZodError) {
    const hint: Partial<Record<Action, string>> = {
      update: "the record id, --expected-version, --file (changes.json)",
      search: "the search words, --kind, --limit (1-50)",
      get: "the record id",
      task: "the title or target id, --status (todo|active|review|paused|done)",
      report: "the title or target id, --status (todo|active|review|paused|done)",
      reply: "the title or target id, --status (todo|active|review|paused|done)",
      digest: "the digest JSON file, --quiet",
      digests: "--from/--to (YYYY-MM-DD)",
      comments: "--state (new|open|all), --interval (2-300 s), --timeout (s)",
      narrate: "the record id, --style (read|podcast), --interval (2-300 s), --timeout (s)",
    };
    console.error(`Invalid input: check ${hint[action] ?? "--file and --request-id"} and DASHBOARD_TOKEN. ${error.issues.map(issue => issue.message).join("; ")}`);
  } else if (error instanceof Error) {
    console.error(`${readingShared ? "Reading the shared record" : label} failed: ${error.message}`);
  } else {
    console.error(`${label} failed: unknown error`);
  }
  process.exitCode = 1;
}
