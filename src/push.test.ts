import { afterEach, beforeEach, expect, test } from "bun:test";
import { configure } from "./config";
import { syncPush, syncPushLocale } from "./push";

const subscription = {
  endpoint: "https://fcm.googleapis.com/fcm/send/example", toJSON: () => ({ endpoint: "https://fcm.googleapis.com/fcm/send/example", keys: { p256dh: "a", auth: "b" } }),
};
const device = { kinds: { digest: true, review: true, reply: true }, locale: "en", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" };
const names = ["navigator", "window", "Notification"] as const;
const saved = Object.fromEntries(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
const NativeRequest = globalThis.Request;
const nativeFetch = globalThis.fetch;
let sent: { readonly method: string; readonly url: string; readonly body: unknown }[] = [];

beforeEach(() => {
  sent = [];
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
    userAgent: "", platform: "", maxTouchPoints: 0, languages: ["en-US"],
    serviceWorker: { getRegistration: async () => ({ pushManager: { getSubscription: async () => subscription } }) },
  } });
  Object.defineProperty(globalThis, "window", { configurable: true, value: { PushManager: class {}, Notification: class {}, matchMedia: () => ({ matches: false }) } });
  Object.defineProperty(globalThis, "Notification", { configurable: true, value: { permission: "granted" } });
  globalThis.Request = class extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) { super(typeof input === "string" ? new URL(input, "http://localhost") : input, init); }
  } as typeof Request;
  globalThis.fetch = (async (request: Request) => {
    sent.push({ method: request.method, url: new URL(request.url).pathname, body: await request.clone().json() });
    return Response.json({ device });
  }) as typeof fetch;
});
afterEach(() => {
  configure({ features: { demo: false } });
  globalThis.Request = NativeRequest;
  globalThis.fetch = nativeFetch;
  for (const name of names) {
    const descriptor = saved[name];
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

test("syncPushLocale tells the server this device's language without touching its kinds", async () => {
  await syncPushLocale("csrf-1", "en");
  expect(sent).toEqual([{ method: "PUT", url: "/api/v1/push/subscription", body: { subscription: { ...subscription.toJSON(), locale: "en" } } }]);
});

test("a subscription handed back on load carries the language of the page", async () => {
  await syncPush("csrf-1");
  expect(sent.map(request => request.body)).toEqual([{ subscription: { ...subscription.toJSON(), locale: "ko" } }]);
});

test("demo mode never writes the language to the server", async () => {
  configure({ features: { demo: true } });
  await syncPushLocale("csrf-1", "en");
  expect(sent).toEqual([]);
});
