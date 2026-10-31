import { afterAll, afterEach, expect, test } from "bun:test";

import { createECDH, randomBytes } from "node:crypto";

import { Database } from "bun:sqlite";

import { mkdtempSync, rmSync } from "node:fs";

import { tmpdir } from "node:os";

import { LEGACY_CORE } from "./fixtures/legacy-schema";

import { join } from "node:path";

import { z } from "zod";

import type { PushPayload } from "../shared/contracts";

import { agentRecord, bearer, fixture, payload, recordResult } from "./backend-helper";

type Sent = { endpoint: string; payload: PushPayload };

let sent: Sent[] = [];

let status = 201;

const stub = { push: { deliver: async (target: { endpoint: string }, message: PushPayload) => { sent.push({ endpoint: target.endpoint, payload: message }); return status; } } };

let f = (await fixture(10000, Date.now, stub));

afterEach(async () => { (await f.close()); sent = []; status = 201; f = (await fixture(10000, Date.now, stub)); });

afterAll(async () => (await f.close()));

function device(endpoint = `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`) {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return { ecdh, auth, subscription: { endpoint, expirationTime: null,
    keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: auth.toString("base64url") } } };
}

async function subscribe(body: Record<string, unknown>, headers?: Record<string, string>) {
  return f.call("/api/v1/push/subscription", "PUT", body, headers ?? await f.login());
}

const settle = async () => (await f.app.push.idle());

const morning = (sections: unknown[], extra: Record<string, unknown> = {}) => ({ date: "2026-10-01", slot: "morning", sections, ...extra });

const articles = (key: string, title: string, items: unknown[]) => ({ key, title, kind: "articles", items });

const messages = (key: string, title: string, items: unknown[]) => ({ key, title, kind: "messages", items });

const article = (key: string, title: string) => ({ key, title, source: "연합뉴스", summary: "요약", url: `https://news.example.com/${key}` });

const upload = (body: unknown) => f.call("/api/v1/digests", "POST", body, bearer("omo"));

/** RFC 8291 aes128gcm decryption with the device's private key, so the test reads exactly what the push service delivers. */

const byEndpoint = (items: Sent[]) => Object.fromEntries(items.map(item => [item.endpoint, item.payload]));

const deviceLocale = async (endpoint: string, headers: Record<string, string>) =>
  z.object({ device: z.object({ locale: z.string() }) }).parse(await (await f.call(`/api/v1/push?endpoint=${encodeURIComponent(endpoint)}`, "GET", undefined, headers)).json()).device.locale;

test("Each device is told in its own language; a device that never said gets the server's LOCALE", async () => {
  const owner = await f.login();
  const en = device().subscription;
  const ko = device().subscription;
  const unset = device().subscription;
  await subscribe({ subscription: { ...en, locale: "en" } }, owner);
  await subscribe({ subscription: { ...ko, locale: "ko" } }, owner);
  await subscribe({ subscription: unset }, owner);
  expect([await deviceLocale(en.endpoint, owner), await deviceLocale(ko.endpoint, owner), await deviceLocale(unset.endpoint, owner)]).toEqual(["en", "ko", "en"]);
  // A refresh without a locale keeps the device's language.
  await subscribe({ subscription: ko }, owner);
  expect(await deviceLocale(ko.endpoint, owner)).toBe("ko");
  // The test button.
  for (const target of [en, ko, unset]) await f.call("/api/v1/push/test", "POST", { endpoint: target.endpoint }, owner);
  const test = (title: string): PushPayload => ({ kind: "test", title, body: title === "대시보드 알림" ? "이 기기에서 알림을 받을 수 있어요." : "This device can receive notifications.", url: "/#/settings", tag: "test" });
  expect(byEndpoint(sent)).toEqual({ [en.endpoint]: test("Dashboard notifications"), [ko.endpoint]: test("대시보드 알림"), [unset.endpoint]: test("Dashboard notifications") });
  // Review and reply.
  sent = [];
  const created = await f.call("/api/v1/records", "POST", payload(agentRecord({ kind: "task", title: "푸시 작업", status: "active" })), bearer("omo"));
  const task = recordResult.parse(await created.json()).record;
  await f.call("/api/v1/comments", "POST", { requestId: crypto.randomUUID(), recordId: task.id, body: "1차 끝, 확인 부탁", status: "review" }, bearer("omo"));
  await settle();
  const review = (title: string): PushPayload => ({ kind: "review", title, body: "omo: 1차 끝, 확인 부탁", url: `/#/work/${task.id}`, tag: `task-${task.id}` });
  expect(byEndpoint(sent)).toEqual({ [en.endpoint]: review("Needs review · 푸시 작업"), [ko.endpoint]: review("확인 필요 · 푸시 작업"), [unset.endpoint]: review("Needs review · 푸시 작업") });
  sent = [];
  const comment = z.object({ comment: z.object({ id: z.string() }) }).parse(await (await f.call("/api/v1/comments", "POST",
    { requestId: crypto.randomUUID(), recordId: task.id, body: "색 바꿔줘" }, owner)).json()).comment;
  await f.call("/api/v1/comments", "POST", { requestId: crypto.randomUUID(), replyTo: comment.id, body: "바쳤어요", done: true }, bearer("omo"));
  await settle();
  const reply = (title: string): PushPayload => ({ kind: "reply", title, body: "바쳤어요", url: `/#/work/${task.id}`, tag: `task-${task.id}` });
  expect(byEndpoint(sent)).toEqual({ [en.endpoint]: reply("omo replied · 푸시 작업"), [ko.endpoint]: reply("omo 답글 · 푸시 작업"), [unset.endpoint]: reply("omo replied · 푸시 작업") });
  // Digest.
  sent = [];
  const response = await upload(morning([articles("domestic", "Domestic", [article("a", "국내 첫 소식")]),
    messages("inbox", "Inbox", [{ key: "m", importance: "urgent", from: "X", subject: "계정 확인" }, { key: "n", importance: "check", from: "Carrier", subject: "접속 알림" }])]));
  const id = z.object({ digest: z.object({ id: z.string() }) }).parse(await response.json()).digest.id;
  await settle();
  const digest = (title: string, body: string): PushPayload => ({ kind: "digest", title, body, url: `/#/digest/${id}`, tag: `digest-${id}` });
  const english = digest("Morning digest · 2 messages · 1 article", "Act now · 계정 확인 +1 more\n· 국내 첫 소식");
  expect(byEndpoint(sent)).toEqual({ [en.endpoint]: english, [unset.endpoint]: english,
    [ko.endpoint]: digest("아침 다이제스트 · 메시지 2 · 기사 1", "즉시 조치 · 계정 확인 외 1건\n· 국내 첫 소식") });
  // A late section is announced as an addition in each language.
  sent = [];
  await upload({ date: "2026-10-01", slot: "evening", sections: [articles("domestic", "Domestic", [article("e", "저녁 소식")])] });
  await upload({ date: "2026-10-01", slot: "evening", sections: [messages("inbox", "Inbox", [{ key: "q", importance: "todo", from: "Bank", subject: "서류 제출" }])] });
  await settle();
  expect(sent.filter(item => item.endpoint === en.endpoint).map(item => item.payload.title)).toEqual(["Evening digest · 1 article", "Evening digest · 1 message added"]);
  expect(sent.filter(item => item.endpoint === ko.endpoint).map(item => item.payload.title)).toEqual(["저녁 다이제스트 · 기사 1", "저녁 다이제스트 · 메시지 1 추가"]);
});

test("With LOCALE ko a device that never said its language is told in Korean, and an English device still gets English", async () => {
  (await f.close());
  f = (await fixture(10000, Date.now, { ...stub, locale: "ko" }));
  const owner = await f.login();
  const en = device().subscription;
  const unset = device().subscription;
  await subscribe({ subscription: { ...en, locale: "en" } }, owner);
  await subscribe({ subscription: unset }, owner);
  expect([await deviceLocale(en.endpoint, owner), await deviceLocale(unset.endpoint, owner)]).toEqual(["en", "ko"]);
  await upload(morning([articles("domestic", "Domestic", [article("a", "국내 첫 소식")])]));
  await settle();
  expect(Object.fromEntries(sent.map(item => [item.endpoint, item.payload.title]))).toEqual({ [en.endpoint]: "Morning digest · 1 article", [unset.endpoint]: "아침 다이제스트 · 기사 1" });
});

test("A database from before device languages opens, keeps its subscriptions and gives them the server's language", async () => {
  const dir = mkdtempSync(join(tmpdir(), "legacy-push-"));
  const databasePath = join(dir, "legacy.sqlite");
  const { subscription } = device();
  const database = new Database(databasePath);
  database.exec(LEGACY_CORE);
    database.exec(`CREATE TABLE push_subscriptions(endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
      kinds TEXT NOT NULL CHECK(json_valid(kinds)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    database.query("INSERT INTO push_subscriptions VALUES(?,?,?,?,?,?)").run(subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth,
      JSON.stringify({ digest: true, review: true, reply: true }), "2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z");
    database.close();
  const old = await fixture(10000, Date.now, { ...stub, databasePath });
  try {
    const owner = await old.login();
    const state = z.object({ devices: z.number(), device: z.object({ locale: z.string() }) }).parse(await (await old.call(
      `/api/v1/push?endpoint=${encodeURIComponent(subscription.endpoint)}`, "GET", undefined, owner)).json());
    expect(state).toMatchObject({ devices: 1, device: { locale: "en" } });
    expect((await old.call("/api/v1/push/subscription", "PUT", { subscription: { ...subscription, locale: "ko" } }, owner)).status).toBe(200);
    expect((await old.app.push.device(subscription.endpoint))?.locale).toBe("ko");
  } finally { await old.close(); rmSync(dir, { recursive: true, force: true }); }
});
