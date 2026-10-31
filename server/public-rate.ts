import { authClientKey } from "./auth-rate";

/** Non-OIDC public surfaces only. /auth/* always uses main's canonical sign-in budgets. */
export function publicRequestLimiter(now: () => number, hops = 0) {
  const buckets = new Map<string, number>();
  let minute = Math.floor(now() / 60000);
  return (request: Request, socketAddress?: string) => {
    const path = new URL(request.url).pathname;
    const share = path.startsWith("/s/") || path.startsWith("/api/v1/shared/");
    const ownerLogin = request.method === "POST" && path === "/api/v1/auth/session";
    if (!share && !ownerLogin) return null;
    const current = Math.floor(now() / 60000);
    if (current !== minute) { buckets.clear(); minute = current; }
    const key = `${share ? "share" : "owner-login"}:${authClientKey(request, socketAddress, hops)}`;
    if (!buckets.has(key) && buckets.size >= 10000) {
      for (const oldest of buckets.keys()) { buckets.delete(oldest); break; }
    }
    const count = (buckets.get(key) ?? 0) + 1;
    buckets.set(key, count);
    if (count <= (share ? 60 : 20)) return null;
    return Response.json({ error: { code: "rate_limited", message: "Too many requests from this address." } }, {
      status: 429, headers: { "Cache-Control": "no-store", "Retry-After": String(Math.max(1, Math.ceil(((minute + 1) * 60000 - now()) / 1000))) },
    });
  };
}
