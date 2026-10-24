import { useSyncExternalStore } from "react";
import { HTTPError } from "ky";

/** Retry-After supports delta seconds and an HTTP-date. Invalid or elapsed values impose no wait. */
export function retryAfterMs(header: string | null, now = Date.now()): number {
  if (header === null) return 0;
  const delay = /^\d+$/.test(header.trim()) ? Number(header) * 1000 : Date.parse(header) - now;
  return Number.isFinite(delay) ? Math.max(0, delay) : 0;
}

let until = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
const changed = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const rateLimited = () => Date.now() < until;
export function clearRateLimit() { clearTimeout(timer); until = 0; changed(); }

/** One browser credential shares the server's rate bucket, so its buttons share the deadline. */
export function rememberRateLimit(error: unknown) {
  if (!(error instanceof HTTPError) || error.response.status !== 429) return;
  if (error.response.headers.get("X-RateLimit-Scope") === "narration") return;
  const delay = retryAfterMs(error.response.headers.get("Retry-After"));
  if (!delay) return;
  until = Math.max(until, Date.now() + delay);
  clearTimeout(timer);
  timer = setTimeout(() => { until = 0; changed(); }, Math.min(until - Date.now(), 2_147_483_647));
  changed();
}

export const useRateLimited = () => useSyncExternalStore(subscribe, rateLimited, () => false);
