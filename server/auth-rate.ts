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
    if (!new URL(request.url).pathname.startsWith("/auth/")) return null;
    const current = Math.floor(now() / 60000);
    if (current !== minute) { buckets.clear(); minute = current; }
    const ip = authClientKey(request, socketAddress, trustedProxy);
    // Evict the oldest entry instead of turning bounded storage into a global sign-in lockout.
    if (!buckets.has(ip) && buckets.size >= 10000) {
      for (const oldest of buckets.keys()) { buckets.delete(oldest); break; }
    }
    const count = (buckets.get(ip) ?? 0) + 1;
    buckets.set(ip, count);
    return count <= 20 ? null : Response.json({ error: { code: "rate_limited", message: "Too many sign-in attempts." } },
      { status: 429, headers: { "Retry-After": "60", "Cache-Control": "no-store" } });
  };
}
