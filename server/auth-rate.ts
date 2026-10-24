import { isIP } from "node:net";

/** Only a trusted proxy can supply the appended client hop; direct listeners ignore XFF entirely. */
export function authClientKey(request: Request, socketAddress: string | undefined, trustedProxy: boolean) {
  const appended = trustedProxy ? request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() : undefined;
  return appended && isIP(appended) ? appended : socketAddress ?? "unknown";
}

export function authLimiter(now: () => number, trustedProxy = false) {
  const buckets = new Map<string, number>();
  let minute = Math.floor(now() / 60000);
  return (request: Request, socketAddress?: string) => {
    const path = new URL(request.url).pathname;
    const share = path.startsWith("/s/") || path.startsWith("/api/v1/shared/");
    if (!share && !path.startsWith("/auth/") && path !== "/api/v1/auth/session") return null;
    const current = Math.floor(now() / 60000);
    if (current !== minute) { buckets.clear(); minute = current; }
    const ip = authClientKey(request, socketAddress, trustedProxy);
    const key = `${share ? "share" : "auth"}:${ip}`;
    const retry = String(Math.max(1, Math.ceil(((minute + 1) * 60000 - now()) / 1000)));
    // Reuse PR-C's bounded eviction; new clients must never inherit a full-map lockout.
    if (!buckets.has(key) && buckets.size >= 10000) {
      for (const oldest of buckets.keys()) { buckets.delete(oldest); break; }
    }
    const count = (buckets.get(key) ?? 0) + 1;
    buckets.set(key, count);
    return count <= (share ? 60 : 20) ? null : Response.json({ error: { code: "rate_limited", message: "Too many requests from this address." } },
      { status: 429, headers: { "Retry-After": retry, "Cache-Control": "no-store" } });
  };
}
