import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import webpush from "web-push";
import { z } from "zod";
import { MESSAGE_IMPORTANCE, PushKindsSchema, PushSubscriptionSchema } from "../shared/contracts";
import type { Comment, Digest, DashboardRecord, PushDevice, PushKinds, PushLocale, PushPayload, Source } from "../shared/contracts";
import { headlines } from "./digests";
import { ApiError } from "./errors";
import { messages, type Locale } from "./messages";
import type { Store } from "./store";

export type PushTarget = { readonly endpoint: string; readonly keys: { readonly p256dh: string; readonly auth: string } };
/** Sends one payload to one device and answers the push service's HTTP status, or null when it could not be reached. */
export type Deliver = (target: PushTarget, payload: PushPayload) => Promise<number | null>;
export interface PushOptions {
  readonly vapidPath: string;
  /** The VAPID `sub` claim: an https URL or mailto: address the push services can reach the sender at. */
  readonly subject: string;
  readonly deliver?: Deliver;
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  readonly allowEndpoint?: (url: URL) => boolean;
  readonly locale?: Locale;
}
export type Push = ReturnType<typeof createPush>;

export const DEFAULT_PUSH_KINDS: PushKinds = { digest: true, review: true, reply: true };
/** A queued alert matters for hours, not days: a stale digest alert is noise. */
const TTL_SECONDS = 12 * 60 * 60;
const TIMEOUT_MS = 10_000;
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /(?:^|\.)push\.apple\.com$/, /^updates\.push\.services\.mozilla\.com$/, /(?:^|\.)notify\.windows\.com$/];
/** Only the browsers' own push services: the server never posts to an address a client made up. */
export const pushEndpointAllowed = (url: URL) => url.protocol === "https:" && !url.port && PUSH_HOSTS.some(host => host.test(url.hostname));
const rowSchema = z.object({ endpoint: z.string(), p256dh: z.string(), auth: z.string(), kinds: z.string(), locale: z.string().nullable(), created_at: z.string(), updated_at: z.string() });
const vapidSchema = z.object({ publicKey: z.string().min(1), privateKey: z.string().min(1) }).strict();
const agentLabel = (source: Source, locale: Locale) => source === "manual" ? messages(locale).owner : source;
const decoded = (value: string) => /^[A-Za-z0-9_-]+=*$/.test(value) ? Buffer.from(value, "base64url").length : -1;
const clip = (text: string, max: number) => text.length <= max ? text : `${text.slice(0, max - 1)}…`;
const firstLine = (text: string) => text.trim().split("\n")[0]?.trim() ?? "";

/**
 * A payload built for one language remembers how to build itself for another, so the callers that build it once
 * (`notify([{ kind, payload: reviewPayload(...) }])`) still reach every device in its own language.
 */
const localizers = new WeakMap<PushPayload, (locale: Locale) => PushPayload>();
function localizable(locale: Locale, build: (locale: Locale) => PushPayload): PushPayload {
  const payload = build(locale);
  localizers.set(payload, build);
  return payload;
}

/** Columns a character takes: two for Hangul and other wide East Asian script, one for the rest. */
const columns = (char: string) => {
  const code = char.codePointAt(0) ?? 0;
  return (code >= 0x1100 && code <= 0x11ff) || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) ? 2 : 1;
};
const width = (text: string) => [...text].reduce((sum, char) => sum + columns(char), 0);
/** Cuts text to `units` columns, ending with … when anything was cut. */
function fit(text: string, units: number) {
  if (width(text) <= units) return text;
  let kept = "";
  let used = 0;
  for (const char of text) {
    if (used + columns(char) > units - 1) break;
    kept += char;
    used += columns(char);
  }
  return `${kept.trimEnd()}…`;
}
/**
 * A phone's lock screen shows a notification's title on one line and about four body lines, about 44 columns each (22
 * Korean characters) before cutting it off; a line per item keeps every item visible instead of one long item wrapping
 * over the rest. https://developer.apple.com/design/human-interface-guidelines/notifications
 */
const LINE = 44;
const BODY_LINES = 4;

/**
 * Title: which digest and how much (`Morning digest · 3 messages · 12 articles`, `… · 1 message added` when a section
 * arrives late). Body: the most important added message with its importance and how many more, then one headline per
 * line; messages alone list the next messages instead.
 */
export function digestPayload(digest: Digest, added: readonly string[], created: boolean, locale: Locale = "en"): PushPayload {
  return localizable(locale, locale => {
    const text = messages(locale);
    const addedSections = digest.sections.filter(section => added.includes(section.key));
    const messageItems = addedSections.flatMap(section => section.kind === "messages" ? section.items : [])
      .sort((a, b) => MESSAGE_IMPORTANCE.indexOf(a.importance) - MESSAGE_IMPORTANCE.indexOf(b.importance));
    const articleCount = addedSections.reduce((sum, section) => sum + (section.kind === "articles" ? section.items.length : 0), 0);
    const counts = [messageItems.length ? text.digestMessageCount(messageItems.length) : "", articleCount ? text.digestArticleCount(articleCount) : ""].filter(Boolean);
    const title = [text.digestLabel(digest.slot), ...counts].join(" · ") + (created ? "" : text.digestAdded);
    const item = (importance: (typeof MESSAGE_IMPORTANCE)[number], subject: string, more = "") => {
      const head = `${text.importance[importance]} · `;
      return `${head}${fit(subject, Math.max(16, LINE - width(head) - width(more)))}${more}`;
    };
    const lines: string[] = [];
    const [top, ...rest] = messageItems;
    if (top) lines.push(item(top.importance, top.subject, rest.length ? text.digestMore(rest.length) : ""));
    for (const headline of headlines(digest, BODY_LINES - lines.length, added)) lines.push(`· ${fit(headline, LINE - 2)}`);
    if (!articleCount) for (const each of rest.slice(0, BODY_LINES - lines.length)) lines.push(`· ${item(each.importance, each.subject)}`);
    // Only messages added opens the messages part, only articles the articles part; both open the whole digest.
    const hasMessages = addedSections.some(section => section.kind === "messages");
    const hasArticles = addedSections.some(section => section.kind === "articles");
    const part = hasMessages && !hasArticles ? "?part=messages" : hasArticles && !hasMessages ? "?part=articles" : "";
    return { kind: "digest", title, body: lines.join("\n"), url: `/#/digest/${digest.id}${part}`, tag: `digest-${digest.id}` };
  });
}
export function reviewPayload(record: DashboardRecord, source: Source, report: string, locale: Locale = "en"): PushPayload {
  return localizable(locale, locale => {
    const line = firstLine(report);
    const text = messages(locale);
    return { kind: "review", title: text.reviewTitle(clip(record.title, 60)), body: `${agentLabel(source, locale)}: ${line ? clip(line, 160) : text.reviewAsked}`,
      url: `/#/work/${record.id}`, tag: `task-${record.id}` };
  });
}
export function replyPayload(record: DashboardRecord, comment: Comment, locale: Locale = "en"): PushPayload {
  return localizable(locale, locale => {
    const text = messages(locale);
    return { kind: "reply", title: text.replyTitle(agentLabel(comment.source, locale), clip(record.title, 60)), body: clip(comment.body.trim() || text.statusChanged, 200),
      url: `/#/work/${record.id}`, tag: `task-${record.id}` };
  });
}
export const testPayload = (locale: Locale = "en"): PushPayload =>
  ({ kind: "test", title: messages(locale).testTitle, body: messages(locale).testBody, url: "/#/settings", tag: "test" });

/** Owner-only and written whole: a crash mid-write must not leave half a key file, and a new key would orphan every device. */
function writePrivate(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

/**
 * Web Push to the owner's devices. Each device's subscription (its push-service endpoint and encryption keys) is stored with
 * the kinds it wants. Payloads are encrypted (RFC 8291 aes128gcm) and signed with the server's VAPID key (RFC 8292) by
 * web-push's generateRequestDetails and sent with fetch. A 404 or 410 means the device dropped the subscription.
 */
export function createPush(store: Store, options: PushOptions) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS push_subscriptions(endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
    kinds TEXT NOT NULL CHECK(json_valid(kinds)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  // Add-only migration: older databases gain the device language (NULL means the server's default language); no row is rewritten.
  const columns = new Set(store.db.query("PRAGMA table_info(push_subscriptions)").all().map(column => z.object({ name: z.string() }).parse(column).name));
  if (!columns.has("locale")) store.db.exec("ALTER TABLE push_subscriptions ADD COLUMN locale TEXT");
  const defaultLocale: Locale = options.locale ?? "en";
  /** A device that never said its language (NULL, or a database from before this column) uses the server's default language. */
  const localeOf = (value: string | null): PushLocale => value === "en" || value === "ko" ? value : defaultLocale;
  const allow = options.allowEndpoint ?? pushEndpointAllowed;
  const pending = new Set<Promise<unknown>>();
  let vapid: z.infer<typeof vapidSchema> | null = null;

  /** Created on first need; a malformed file is an error, never a silent rotation. */
  function keys() {
    if (vapid) return vapid;
    if (existsSync(options.vapidPath)) {
      const parsed = vapidSchema.safeParse(JSON.parse(readFileSync(options.vapidPath, "utf8")));
      if (!parsed.success) throw new Error(`${options.vapidPath} is malformed; restore it, or delete it and subscribe every device again`);
      chmodSync(options.vapidPath, 0o600);
      vapid = parsed.data;
    } else {
      const generated = webpush.generateVAPIDKeys();
      vapid = { publicKey: generated.publicKey, privateKey: generated.privateKey };
      writePrivate(options.vapidPath, vapid);
    }
    return vapid;
  }
  const now = () => new Date(store.now()).toISOString();
  const rows = () => store.db.query("SELECT * FROM push_subscriptions").all().map(value => rowSchema.parse(value));
  const row = (endpoint: string) => {
    const value = store.db.query("SELECT * FROM push_subscriptions WHERE endpoint=?").get(endpoint);
    return value ? rowSchema.parse(value) : null;
  };
  const view = (value: z.infer<typeof rowSchema>): PushDevice => ({ kinds: PushKindsSchema.parse(JSON.parse(value.kinds)), locale: localeOf(value.locale), createdAt: value.created_at, updatedAt: value.updated_at });

  const send: Deliver = async (target, payload) => {
    const { publicKey, privateKey } = keys();
    const details = webpush.generateRequestDetails({ endpoint: target.endpoint, keys: { ...target.keys } }, JSON.stringify(payload), {
      vapidDetails: { subject: options.subject, publicKey, privateKey }, TTL: TTL_SECONDS, urgency: "normal", contentEncoding: "aes128gcm",
    });
    const headers = Object.fromEntries(Object.entries(details.headers).filter(([name]) => name.toLowerCase() !== "content-length").map(([name, value]) => [name, String(value)]));
    try {
      const response = await (options.fetch ?? fetch)(details.endpoint, { method: details.method, headers,
        body: details.body ? new Uint8Array(details.body) : null, signal: AbortSignal.timeout(TIMEOUT_MS) });
      return response.status;
    } catch (error) {
      // The endpoint identifies the device; only the failure class is logged.
      console.error(`push delivery failed: ${error instanceof Error ? error.name : "unknown"}`);
      return null;
    }
  };
  async function deliver(value: z.infer<typeof rowSchema>, payload: PushPayload) {
    const status = await (options.deliver ?? send)({ endpoint: value.endpoint, keys: { p256dh: value.p256dh, auth: value.auth } }, payload);
    if (status === 404 || status === 410) store.db.query("DELETE FROM push_subscriptions WHERE endpoint=?").run(value.endpoint);
    return status;
  }
  const track = <T,>(work: Promise<T>) => {
    pending.add(work);
    void work.finally(() => pending.delete(work));
    return work;
  };

  return {
    publicKey: () => keys().publicKey,
    device: (endpoint: string) => { const value = row(endpoint); return value ? view(value) : null; },
    count: () => z.object({ count: z.number() }).parse(store.db.query("SELECT count(*) AS count FROM push_subscriptions").get()).count,
    /** Stores or refreshes a device; without `kinds` or `locale` an existing device keeps its choice and a new one gets every kind and the server's language. */
    subscribe(raw: unknown, kinds?: PushKinds): PushDevice {
      const parsed = PushSubscriptionSchema.safeParse(raw);
      const url = parsed.success && URL.canParse(parsed.data.endpoint) ? new URL(parsed.data.endpoint) : null;
      if (!parsed.success || !url || !allow(url) || decoded(parsed.data.keys.p256dh) !== 65 || decoded(parsed.data.keys.auth) !== 16) {
        throw new ApiError(400, "invalid_subscription", "Send the browser's PushSubscription for a known push service");
      }
      keys();
      const { endpoint, locale, keys: { p256dh, auth } } = parsed.data;
      const existing = row(endpoint);
      const chosen = kinds ?? (existing ? PushKindsSchema.parse(JSON.parse(existing.kinds)) : DEFAULT_PUSH_KINDS);
      const timestamp = now();
      store.db.query(`INSERT INTO push_subscriptions(endpoint,p256dh,auth,kinds,locale,created_at,updated_at) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh,auth=excluded.auth,kinds=excluded.kinds,locale=excluded.locale,updated_at=excluded.updated_at`)
        .run(endpoint, p256dh, auth, JSON.stringify(chosen), locale ?? existing?.locale ?? null, existing?.created_at ?? timestamp, timestamp);
      return view(row(endpoint) ?? (() => { throw new Error("subscription vanished"); })());
    },
    unsubscribe(endpoint: string) { store.db.query("DELETE FROM push_subscriptions WHERE endpoint=?").run(endpoint); },
    async test(endpoint: string) {
      const value = row(endpoint);
      if (!value) throw new ApiError(404, "not_found", "This device is not subscribed");
      const status = await track(deliver(value, testPayload(localeOf(value.locale))));
      return { delivered: status !== null && status >= 200 && status < 300, status };
    },
    /**
     * Sends each device the first of `choices` whose kind it wants (a reply that also asks for review reaches a device once).
     * Fire and forget: returns how many devices were chosen; `idle()` waits for the sends.
     */
    notify(choices: readonly { readonly kind: keyof PushKinds; readonly payload: PushPayload }[]): number {
      let chosen = 0;
      for (const value of rows()) {
        const kinds = PushKindsSchema.parse(JSON.parse(value.kinds));
        const choice = choices.find(item => kinds[item.kind]);
        if (!choice) continue;
        chosen += 1;
        const payload = localizers.get(choice.payload)?.(localeOf(value.locale)) ?? choice.payload;
        void track(deliver(value, payload).catch((error: unknown) => {
          console.error(`push delivery failed: ${error instanceof Error ? error.name : "unknown"}`);
        }));
      }
      return chosen;
    },
    async idle() { while (pending.size) await Promise.allSettled([...pending]); },
  };
}
