import type { PushDevice, PushKinds } from "../shared/contracts";
import { deletePushSubscription, loadPush, savePushSubscription, sendTestPush } from "./api";
import { config } from "./config";
import { getLocale } from "./i18n";
import type { Locale } from "./i18n";

/**
 * This device's Web Push subscription. Push needs a service worker and PushManager, which exist only in secure contexts
 * (HTTPS or localhost) and, on iPhone and iPad, only in the app added to the home screen (iOS 16.4 or later).
 */
export type PushSupport = "supported" | "ios-browser" | "unsupported";
const WORKER_TIMEOUT_MS = 10_000;

export function pushSupport(): PushSupport {
  if (typeof navigator === "undefined") return "unsupported";
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if ("serviceWorker" in navigator && "PushManager" in window && "Notification" in window) return "supported";
  return ios && !standalone ? "ios-browser" : "unsupported";
}

export function registerWorker() {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js").catch((error: unknown) => {
    console.error(`service worker registration failed: ${error instanceof Error ? error.name : "unknown"}`);
  });
}

/** navigator.serviceWorker.ready never settles when registration failed; bound it. */
async function worker(): Promise<ServiceWorkerRegistration | null> {
  let timer = 0;
  const timeout = new Promise<null>(resolve => { timer = window.setTimeout(() => resolve(null), WORKER_TIMEOUT_MS); });
  try { return await Promise.race([navigator.serviceWorker.ready, timeout]); }
  finally { window.clearTimeout(timer); }
}
const keyBytes = (base64url: string) => {
  const binary = atob(base64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(base64url.length / 4) * 4, "="));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
};
const sameKey = (current: ArrayBuffer | null, expected: Uint8Array) =>
  current !== null && current.byteLength === expected.length && new Uint8Array(current).every((byte, index) => byte === expected[index]);

/** The server reads the device's language from the subscription it is sent. */
const withLocale = (subscription: PushSubscription, locale: Locale) => ({ ...subscription.toJSON(), locale });

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushSupport() !== "supported") return null;
  const registration = await navigator.serviceWorker.getRegistration();
  return await registration?.pushManager.getSubscription() ?? null;
}

export async function deviceState(): Promise<PushDevice | null> {
  const subscription = await currentSubscription();
  if (!subscription || Notification.permission !== "granted") return null;
  return (await loadPush(subscription.endpoint)).device;
}

/**
 * Asks permission when needed (a tap must start this on iOS), subscribes with the server's key (replacing a subscription
 * made for another key) and stores it on the server. Resolves the stored device, or the reason it could not.
 */
export async function enablePush(csrfToken: string, kinds?: PushKinds): Promise<PushDevice | "denied" | "unsupported" | "unavailable"> {
  if (pushSupport() !== "supported") return "unsupported";
  const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
  if (permission !== "granted") return "denied";
  const registration = await worker();
  if (!registration) return "unsupported";
  const key = keyBytes((await loadPush()).publicKey);
  let subscription = await registration.pushManager.getSubscription();
  if (subscription && !sameKey(subscription.options.applicationServerKey, key)) { await subscription.unsubscribe(); subscription = null; }
  // The browser's push service can refuse (AbortError "push service not available"); that is not a server failure.
  try { subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }); }
  catch (error) { if (error instanceof DOMException) return "unavailable"; throw error; }
  return await savePushSubscription(withLocale(subscription, getLocale()), kinds, csrfToken);
}

/** On every load with permission granted: hand an existing subscription back to the server, keeping its kinds. */
export async function syncPush(csrfToken: string): Promise<void> {
  const subscription = await currentSubscription();
  if (!subscription || Notification.permission !== "granted") return;
  await savePushSubscription(withLocale(subscription, getLocale()), undefined, csrfToken);
}

/** Tells the server which language this device's notifications are in; nothing to do in demo mode or without a granted subscription. */
export async function syncPushLocale(csrfToken: string, locale: Locale): Promise<void> {
  if (config.features.demo) return;
  const subscription = await currentSubscription();
  if (!subscription || Notification.permission !== "granted") return;
  await savePushSubscription(withLocale(subscription, locale), undefined, csrfToken);
}

/** The server forgets the device first, then the browser drops the subscription. */
export async function disablePush(csrfToken: string): Promise<void> {
  const subscription = await currentSubscription();
  if (!subscription) return;
  try { await deletePushSubscription(subscription.endpoint, csrfToken); }
  finally { await subscription.unsubscribe(); }
}

export async function testPush(csrfToken: string) {
  const subscription = await currentSubscription();
  if (!subscription) return null;
  return await sendTestPush(subscription.endpoint, csrfToken);
}
