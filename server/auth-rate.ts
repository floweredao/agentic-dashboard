/** Cloud Run supplies the forwarded chain; a direct listener supplies the socket address instead. */
export function authLimiter(now: () => number) {
  const buckets = new Map<string, number>();
  let minute = Math.floor(now() / 60000);
  return (request: Request, socketAddress?: string) => {
    const path = new URL(request.url).pathname;
    const share = path.startsWith("/s/") || path.startsWith("/api/v1/shared/");
    if (!share && !path.startsWith("/auth/") && path !== "/api/v1/auth/session") return null;
    const current = Math.floor(now() / 60000);
    if (current !== minute) { buckets.clear(); minute = current; }
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || socketAddress || "unknown";
    const key = `${share ? "share" : "auth"}:${ip}`;
    const retry = String(Math.max(1, Math.ceil(((minute + 1) * 60000 - now()) / 1000)));
    // Bounded even if a public client sends arbitrary forwarded values.
    if (!buckets.has(key) && buckets.size >= 10000) return Response.json({ error: { code: "rate_limited", message: "Try again shortly." } },
      { status: 429, headers: { "Retry-After": retry, "Cache-Control": "no-store" } });
    const count = (buckets.get(key) ?? 0) + 1;
    buckets.set(key, count);
    return count <= (share ? 60 : 20) ? null : Response.json({ error: { code: "rate_limited", message: "Too many requests from this address." } },
      { status: 429, headers: { "Retry-After": retry, "Cache-Control": "no-store" } });
  };
}
