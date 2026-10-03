import { afterAll, afterEach, expect, test } from "bun:test";
import { createDecipheriv, createECDH, createHmac, randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { PushPayload } from "../shared/contracts";
import { agentRecord, bearer, fixture, payload, recordResult } from "./backend-helper";

type Sent = { endpoint: string; payload: PushPayload };
let sent: Sent[] = [];
let status = 201;
const stub = { push: { deliver: async (target: { endpoint: string }, message: PushPayload) => { sent.push({ endpoint: target.endpoint, payload: message }); return status; } } };
let f = fixture(10000, Date.now, stub);
afterEach(() => { f.close(); sent = []; status = 201; f = fixture(10000, Date.now, stub); });
afterAll(() => f.close());

function device(endpoint = `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`) {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return { ecdh, auth, subscription: { endpoint, expirationTime: null,
    keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: auth.toString("base64url") } } };
}
const deviceView = z.object({ device: z.object({ kinds: z.object({ digest: z.boolean(), review: z.boolean(), reply: z.boolean() }) }).nullable() });
async function subscribe(body: Record<string, unknown>, headers?: Record<string, string>) {
  return f.call("/api/v1/push/subscription", "PUT", body, headers ?? await f.login());
}
const settle = () => f.app.push.idle();
const morning = (sections: unknown[], extra: Record<string, unknown> = {}) => ({ date: "2026-10-01", slot: "morning", sections, ...extra });
const articles = (key: string, title: string, items: unknown[]) => ({ key, title, kind: "articles", items });
const messages = (key: string, title: string, items: unknown[]) => ({ key, title, kind: "messages", items });
const article = (key: string, title: string) => ({ key, title, source: "연합뉴스", summary: "요약", url: `https://news.example.com/${key}` });
const upload = (body: unknown) => f.call("/api/v1/digests", "POST", body, bearer("omo"));

test("The owner gets the public VAPID key; the key pair is stored owner-only and the private key never leaves", async () => {
  const response = await f.call("/api/v1/push", "GET", undefined, await f.login());
  expect(response.status).toBe(200);
  const text = await response.text();
  const body = z.object({ publicKey: z.string(), device: z.null(), devices: z.number() }).parse(JSON.parse(text));
  expect(Buffer.from(body.publicKey, "base64url")).toHaveLength(65);
  const path = join(f.dir, "vapid.json");
  expect(statSync(path).mode & 0o777).toBe(0o600);
  const stored = z.object({ publicKey: z.string(), privateKey: z.string() }).parse(JSON.parse(readFileSync(path, "utf8")));
  expect(stored.publicKey).toBe(body.publicKey);
  expect(text).not.toContain(stored.privateKey);
  // And: the key survives a restart, so subscribed devices keep working.
  f.restart();
  const again = z.object({ publicKey: z.string() }).parse(await (await f.call("/api/v1/push", "GET", undefined, await f.login())).json());
  expect(again.publicKey).toBe(body.publicKey);
  // And: agents and anonymous callers cannot use the push routes.
  expect((await f.call("/api/v1/push", "GET", undefined, bearer("omo"))).status).toBe(403);
  expect((await f.call("/api/v1/push", "GET")).status).toBe(401);
});

test("A device subscribes with every kind on, changes its kinds, and unsubscribes", async () => {
  const { subscription } = device();
  const owner = await f.login();
  expect((await subscribe({ subscription }, owner)).status).toBe(200);
  const query = `/api/v1/push?endpoint=${encodeURIComponent(subscription.endpoint)}`;
  expect(deviceView.parse(await (await f.call(query, "GET", undefined, owner)).json()).device?.kinds).toEqual({ digest: true, review: true, reply: true });
  // When: the device turns digests off, then subscribes again without kinds (a reload).
  await subscribe({ subscription, kinds: { digest: false, review: true, reply: true } }, owner);
  await subscribe({ subscription }, owner);
  expect(deviceView.parse(await (await f.call(query, "GET", undefined, owner)).json()).device?.kinds).toEqual({ digest: false, review: true, reply: true });
  f.restart();
  const fresh = await f.login();
  expect(deviceView.parse(await (await f.call(query, "GET", undefined, fresh)).json()).device?.kinds.digest).toBe(false);
  // Then: deleting it leaves nothing to send to.
  expect((await f.call("/api/v1/push/subscription", "DELETE", { endpoint: subscription.endpoint }, fresh)).status).toBe(204);
  expect(deviceView.parse(await (await f.call(query, "GET", undefined, fresh)).json()).device).toBeNull();
});

test("Subscriptions need the owner, CSRF, a push-service endpoint and valid keys", async () => {
  const owner = await f.login();
  const { "X-CSRF-Token": _csrf, ...noCsrf } = owner;
  expect((await subscribe({ subscription: device().subscription }, noCsrf)).status).toBe(403);
  expect((await subscribe({ subscription: device().subscription }, bearer("omo"))).status).toBe(403);
  for (const endpoint of ["http://fcm.googleapis.com/fcm/send/x", "https://127.0.0.1/push", "https://evil.example.com/push"]) {
    const response = await subscribe({ subscription: device(endpoint).subscription }, owner);
    expect(response.status).toBe(400);
    expect(z.object({ error: z.object({ code: z.string() }) }).parse(await response.json()).error.code).toBe("invalid_subscription");
  }
  const bad = device().subscription;
  expect((await subscribe({ subscription: { ...bad, keys: { p256dh: "short", auth: bad.keys.auth } } }, owner)).status).toBe(400);
});

test("The test button sends one confirmation to that device only", async () => {
  const owner = await f.login();
  const one = device().subscription;
  const two = device().subscription;
  await subscribe({ subscription: one }, owner);
  await subscribe({ subscription: two }, owner);
  const response = await f.call("/api/v1/push/test", "POST", { endpoint: one.endpoint }, owner);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ delivered: true, status: 201 });
  expect(sent).toEqual([{ endpoint: one.endpoint, payload: { kind: "test", title: "Dashboard notifications", body: "This device can receive notifications.", url: "/#/settings", tag: "test" } }]);
  expect((await f.call("/api/v1/push/test", "POST", { endpoint: "https://fcm.googleapis.com/fcm/send/unknown" }, owner)).status).toBe(404);
});

test("A new digest notifies devices that want digests, with its first headlines and a link to it", async () => {
  const owner = await f.login();
  const wants = device().subscription;
  const quiet = device().subscription;
  await subscribe({ subscription: wants }, owner);
  await subscribe({ subscription: quiet, kinds: { digest: false, review: true, reply: true } }, owner);
  // When: the morning digest arrives with articles and messages.
  const response = await upload(morning([
    articles("domestic", "Domestic", [article("a", "국내 첫 소식"), article("b", "국내 둘째")]), articles("world", "World", [article("c", "해외 첫 소식")]),
    articles("ai", "AI", [article("d", "AI 첫 소식")]),
    messages("inbox", "Inbox", [{ key: "m", importance: "urgent", from: "X", subject: "계정 확인", url: "https://mail.example.com/1" }, { key: "n", importance: "check", from: "Carrier", subject: "접속 알림" }]),
  ]));
  const id = z.object({ digest: z.object({ id: z.string() }), notified: z.boolean() }).parse(await response.json());
  await settle();
  // Then: one push to the device that wants digests.
  expect(id.notified).toBe(true);
  expect(sent).toEqual([{ endpoint: wants.endpoint, payload: { kind: "digest", title: "Morning digest arrived",
    body: "2 messages · 1 urgent\n· 국내 첫 소식\n· 해외 첫 소식\n· AI 첫 소식", url: `/#/digest/${id.digest.id}`, tag: `digest-${id.digest.id}` } }]);
  // When: the same digest is sent again, a filled section is corrected, and a quiet backfill arrives.
  sent = [];
  await upload(morning([articles("domestic", "Domestic", [article("a", "국내 첫 소식"), article("b", "국내 둘째")])]));
  await upload(morning([articles("domestic", "Domestic", [article("a", "국내 첫 소식 (수정)")])]));
  await upload({ date: "2026-09-29", slot: "evening", notify: false, sections: [articles("domestic", "Domestic", [article("z", "지난 소식")])] });
  await settle();
  expect(sent).toEqual([]);
  // When: a section that was missing arrives later, the device hears about the addition.
  const evening = z.object({ digest: z.object({ id: z.string() }) }).parse(await (await upload({ date: "2026-10-01", slot: "evening",
    sections: [articles("domestic", "Domestic", [article("e", "저녁 소식")])] })).json()).digest.id;
  await settle();
  // Both parts open the whole digest (above); articles alone open the articles part; messages alone the messages part.
  expect(sent.map(item => item.payload.url)).toEqual([`/#/digest/${evening}?part=articles`]);
  sent = [];
  await upload({ date: "2026-10-01", slot: "evening", sections: [messages("inbox", "Inbox", [{ key: "q", importance: "todo", from: "Bank", subject: "서류 제출" }])] });
  await settle();
  expect(sent.map(item => [item.payload.title, item.payload.body, item.payload.url])).toEqual([["Evening digest: Inbox added", "1 message", `/#/digest/${evening}?part=messages`]]);
});

test("Digest notifications follow LOCALE: Korean titles name the slot and the added sections", async () => {
  f.close();
  f = fixture(10000, Date.now, { ...stub, locale: "ko" });
  await subscribe({ subscription: device().subscription });
  await upload(morning([articles("domestic", "국내", [article("a", "국내 첫 소식")])]));
  await upload(morning([messages("inbox", "메일함", [{ key: "q", importance: "urgent", from: "Bank", subject: "서류 제출" }])]));
  await settle();
  expect(sent.map(item => [item.payload.title, item.payload.body])).toEqual([
    ["아침 다이제스트 왔어요", "· 국내 첫 소식"], ["아침 다이제스트에 메일함이 추가됐어요", "메시지 1건 · 즉시 조치 1건"],
  ]);
});

test("An agent asking for review or replying to the owner notifies devices by kind", async () => {
  const owner = await f.login();
  const all = device().subscription;
  const replies = device().subscription;
  await subscribe({ subscription: all }, owner);
  await subscribe({ subscription: replies, kinds: { digest: true, review: false, reply: true } }, owner);
  const created = await f.call("/api/v1/records", "POST", payload(agentRecord({ kind: "task", title: "푸시 작업", status: "active" })), bearer("omo"));
  const task = recordResult.parse(await created.json()).record;
  // When: OmO reports and moves its task to 확인 필요.
  await f.call("/api/v1/comments", "POST", { requestId: crypto.randomUUID(), recordId: task.id, body: "1차 끝, 확인 부탁\n세부 내용", status: "review" }, bearer("omo"));
  await settle();
  // Then: only the device that wants review hears, with the report's first line.
  expect(sent).toEqual([{ endpoint: all.endpoint, payload: { kind: "review", title: "Needs review · 푸시 작업", body: "omo: 1차 끝, 확인 부탁",
    url: `/#/work/${task.id}`, tag: `task-${task.id}` } }]);
  // When: the owner comments and OmO answers it; and OmO posts a plain report.
  sent = [];
  const comment = z.object({ comment: z.object({ id: z.string() }) }).parse(await (await f.call("/api/v1/comments", "POST",
    { requestId: crypto.randomUUID(), recordId: task.id, body: "색 바꿔줘" }, owner)).json()).comment;
  await settle();
  expect(sent).toEqual([]);
  await f.call("/api/v1/comments", "POST", { requestId: crypto.randomUUID(), replyTo: comment.id, body: "바꿨어요", done: true }, bearer("omo"));
  await f.call("/api/v1/comments", "POST", { requestId: crypto.randomUUID(), recordId: task.id, body: "참고로 남김" }, bearer("omo"));
  await settle();
  // Then: both devices hear the reply once; the plain report notifies nobody.
  expect(sent.map(item => [item.endpoint, item.payload.kind, item.payload.title, item.payload.body]).sort()).toEqual([
    [all.endpoint, "reply", "omo replied · 푸시 작업", "바꿨어요"], [replies.endpoint, "reply", "omo replied · 푸시 작업", "바꿨어요"],
  ].sort());
});

test("A push service answering 404 or 410 removes that device", async () => {
  const owner = await f.login();
  const gone = device().subscription;
  await subscribe({ subscription: gone }, owner);
  status = 410;
  const response = await f.call("/api/v1/push/test", "POST", { endpoint: gone.endpoint }, owner);
  expect(await response.json()).toEqual({ delivered: false, status: 410 });
  const query = `/api/v1/push?endpoint=${encodeURIComponent(gone.endpoint)}`;
  expect(deviceView.parse(await (await f.call(query, "GET", undefined, owner)).json()).device).toBeNull();
});

/** RFC 8291 aes128gcm decryption with the device's private key, so the test reads exactly what the push service delivers. */
function decrypt(body: Uint8Array, ecdh: ReturnType<typeof createECDH>, auth: Buffer) {
  const buffer = Buffer.from(body);
  const salt = buffer.subarray(0, 16);
  const idLength = buffer.readUInt8(20);
  const serverKey = buffer.subarray(21, 21 + idLength);
  const ciphertext = buffer.subarray(21 + idLength);
  const hmac = (key: Buffer, data: Buffer) => createHmac("sha256", key).update(data).digest();
  const shared = ecdh.computeSecret(serverKey);
  const ikm = hmac(hmac(auth, shared), Buffer.concat([Buffer.from("WebPush: info\0"), ecdh.getPublicKey(), serverKey, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  return plain.subarray(0, plain.lastIndexOf(2)).toString("utf8");
}

test("The real sender encrypts the payload for the device and signs it with the VAPID key", async () => {
  // Given: the default sender with only the network replaced, and a device whose private key the test holds.
  const requests: Request[] = [];
  const real = fixture(10000, Date.now, { push: { fetch: async (input: string | URL | Request, init?: RequestInit) => {
    requests.push(new Request(input, init));
    return new Response(null, { status: 201 });
  } } });
  try {
    const owner = await real.login();
    const { ecdh, auth, subscription } = device();
    await real.call("/api/v1/push/subscription", "PUT", { subscription }, owner);
    const key = z.object({ publicKey: z.string() }).parse(await (await real.call("/api/v1/push", "GET", undefined, owner)).json()).publicKey;
    // When: the owner sends a test notification.
    expect(await (await real.call("/api/v1/push/test", "POST", { endpoint: subscription.endpoint }, owner)).json()).toEqual({ delivered: true, status: 201 });
    // Then: one aes128gcm POST to the endpoint, signed for our key, that decrypts to the payload.
    expect(requests).toHaveLength(1);
    const request = requests[0];
    if (!request) throw new Error("no request");
    expect(request.url).toBe(subscription.endpoint);
    expect(request.method).toBe("POST");
    expect(request.headers.get("content-encoding")).toBe("aes128gcm");
    expect(request.headers.get("ttl")).toBe("43200");
    expect(request.headers.get("authorization")).toStartWith("vapid t=");
    expect(request.headers.get("authorization")).toContain(`k=${key}`);
    const message = JSON.parse(decrypt(new Uint8Array(await request.arrayBuffer()), ecdh, auth));
    expect(message).toMatchObject({ kind: "test", url: "/#/settings" });
  } finally { real.close(); }
});

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
  const english = digest("Morning digest arrived", "2 messages · 1 urgent\n· 국내 첫 소식");
  expect(byEndpoint(sent)).toEqual({ [en.endpoint]: english, [unset.endpoint]: english,
    [ko.endpoint]: digest("아침 다이제스트 왔어요", "메시지 2건 · 즉시 조치 1건\n· 국내 첫 소식") });
  // A late section is announced as an addition in each language.
  sent = [];
  await upload({ date: "2026-10-01", slot: "evening", sections: [articles("domestic", "Domestic", [article("e", "저녁 소식")])] });
  await upload({ date: "2026-10-01", slot: "evening", sections: [messages("inbox", "Inbox", [{ key: "q", importance: "todo", from: "Bank", subject: "서류 제출" }])] });
  await settle();
  expect(sent.filter(item => item.endpoint === en.endpoint).map(item => item.payload.title)).toEqual(["Evening digest arrived", "Evening digest: Inbox added"]);
  expect(sent.filter(item => item.endpoint === ko.endpoint).map(item => item.payload.title)).toEqual(["저녁 다이제스트 왔어요", "저녁 다이제스트에 Inbox가 추가됐어요"]);
});

test("With LOCALE ko a device that never said its language is told in Korean, and an English device still gets English", async () => {
  f.close();
  f = fixture(10000, Date.now, { ...stub, locale: "ko" });
  const owner = await f.login();
  const en = device().subscription;
  const unset = device().subscription;
  await subscribe({ subscription: { ...en, locale: "en" } }, owner);
  await subscribe({ subscription: unset }, owner);
  expect([await deviceLocale(en.endpoint, owner), await deviceLocale(unset.endpoint, owner)]).toEqual(["en", "ko"]);
  await upload(morning([articles("domestic", "Domestic", [article("a", "국내 첫 소식")])]));
  await settle();
  expect(Object.fromEntries(sent.map(item => [item.endpoint, item.payload.title]))).toEqual({ [en.endpoint]: "Morning digest arrived", [unset.endpoint]: "아침 다이제스트 왔어요" });
});

test("A database from before device languages opens, keeps its subscriptions and gives them the server's language", async () => {
  const old = fixture(10000, Date.now, stub);
  try {
    const { subscription } = device();
    const database = new Database(old.options.databasePath);
    database.exec("DROP TABLE push_subscriptions");
    database.exec(`CREATE TABLE push_subscriptions(endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
      kinds TEXT NOT NULL CHECK(json_valid(kinds)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    database.query("INSERT INTO push_subscriptions VALUES(?,?,?,?,?,?)").run(subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth,
      JSON.stringify({ digest: true, review: true, reply: true }), "2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z");
    database.close();
    old.restart();
    const owner = await old.login();
    const state = z.object({ devices: z.number(), device: z.object({ locale: z.string() }) }).parse(await (await old.call(
      `/api/v1/push?endpoint=${encodeURIComponent(subscription.endpoint)}`, "GET", undefined, owner)).json());
    expect(state).toMatchObject({ devices: 1, device: { locale: "en" } });
    expect((await old.call("/api/v1/push/subscription", "PUT", { subscription: { ...subscription, locale: "ko" } }, owner)).status).toBe(200);
    expect(old.app.push.device(subscription.endpoint)?.locale).toBe("ko");
  } finally { old.close(); }
});
