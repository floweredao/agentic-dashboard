import { isIP } from "node:net";

/** Trusted ingress selects a hop from the right; direct listeners ignore XFF entirely. */
export function authClientKey(request: Request, socketAddress: string | undefined, trustedProxy: boolean | number) {
  const hops = typeof trustedProxy === "boolean" ? Number(trustedProxy) : trustedProxy;
  const appended = hops > 0 ? request.headers.get("x-forwarded-for")?.split(",").at(-hops)?.trim() : undefined;
  const address = appended && isIP(appended) ? appended : socketAddress ?? "unknown";
  if (isIP(address) !== 6) return address;
  // URL canonicalization also converts dotted IPv4 tails into hexadecimal words.
  const canonical = new URL(`http://[${address.split("%")[0]}]/`).hostname.slice(1, -1);
  const [left = "", right] = canonical.split("::");
  const head = left ? left.split(":") : [];
  const tail = right ? right.split(":") : [];
  const words = right === undefined ? head : [...head, ...Array<string>(8 - head.length - tail.length).fill("0"), ...tail];
  if (words.slice(0, 5).every(word => Number.parseInt(word, 16) === 0) && words[5] === "ffff") {
    return words.slice(6).flatMap(word => {
      const value = Number.parseInt(word, 16);
      return [value >> 8, value & 255];
    }).join(".");
  }
  return [...words.slice(0, 4).map(word => word.padStart(4, "0")), "0000", "0000", "0000", "0000"].join(":") + "/64";
}

export function authLimiter(now: () => number, trustedProxy: boolean | number = false, startLimit = 300) {
  const buckets = new Map<string, number>();
  const startNetworks = new Map<string, number>();
  let starts = 0;
  let minute = Math.floor(now() / 60000);
  return (request: Request, socketAddress?: string) => {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/auth/")) return null;
    const current = Math.floor(now() / 60000);
    if (current !== minute) { buckets.clear(); startNetworks.clear(); starts = 0; minute = current; }
    const ip = authClientKey(request, socketAddress, trustedProxy);
    const starting = path === "/auth/google/start";
    const network = starting && ip.endsWith("/64") ? ip.split(":").slice(0, 3).join(":") : undefined;
    const networkCount = network === undefined ? 0 : startNetworks.get(network) ?? 0;
    // Evict the oldest entry instead of turning bounded storage into a global sign-in lockout.
    if (!buckets.has(ip) && buckets.size >= 10000) {
      for (const oldest of buckets.keys()) { buckets.delete(oldest); break; }
    }
    const count = (buckets.get(ip) ?? 0) + 1;
    buckets.set(ip, count);
    if (count <= 20 && networkCount < 100 && (!starting || starts < startLimit)) {
      if (starting) starts++;
      if (network !== undefined) startNetworks.set(network, networkCount + 1);
      return null;
    }
    return Response.json({ error: { code: "rate_limited", message: "Too many sign-in attempts." } },
      { status: 429, headers: { "Retry-After": "60", "Cache-Control": "no-store" } });
  };
}
