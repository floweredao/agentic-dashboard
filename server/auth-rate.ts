/** Cloud Run supplies the forwarded chain; a direct listener supplies the socket address instead. */
export function authLimiter(now: () => number) {
  const buckets = new Map<string, number>();
  let minute = Math.floor(now() / 60000);
  return (request: Request, socketAddress?: string) => {
    if (!new URL(request.url).pathname.startsWith("/auth/")) return null;
    const current = Math.floor(now() / 60000);
    if (current !== minute) { buckets.clear(); minute = current; }
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || socketAddress || "unknown";
    // Bounded even if a public client sends arbitrary forwarded values.
    if (!buckets.has(ip) && buckets.size >= 10000) return Response.json({ error: { code: "rate_limited", message: "Try again shortly." } },
      { status: 429, headers: { "Retry-After": "60", "Cache-Control": "no-store" } });
    const count = (buckets.get(ip) ?? 0) + 1;
    buckets.set(ip, count);
    return count <= 20 ? null : Response.json({ error: { code: "rate_limited", message: "Too many sign-in attempts." } },
      { status: 429, headers: { "Retry-After": "60", "Cache-Control": "no-store" } });
  };
}
