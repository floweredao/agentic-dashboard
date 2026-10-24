import ky from "ky";
import { z } from "zod";
import { ApiError } from "./errors";

const rsa = z.object({
  kty: z.literal("RSA"), kid: z.string().min(1).max(256), n: z.string(), e: z.string(),
  alg: z.literal("RS256").optional(), use: z.literal("sig").optional(),
});
const jwks = z.object({ keys: z.array(rsa).max(100) });
const header = z.object({ alg: z.literal("RS256"), kid: z.string().min(1).max(256), typ: z.string().optional() }).strict();
export const invalidOidc = () => new ApiError(400, "oidc_invalid", "Sign-in could not be verified. Start again.");
export function decodePart(value: string): unknown {
  try { return JSON.parse(Buffer.from(value, "base64url").toString("utf8")); }
  catch (error) { if (error instanceof SyntaxError) throw invalidOidc(); throw error; }
}

/** One shared bounded cache; token-controlled URLs and embedded keys are never trusted. */
export function createJwks(url: string, now: () => number) {
  let keys: readonly z.infer<typeof rsa>[] = [];
  let expires = 0;
  let forcedAt = -Infinity;
  let pending: Promise<void> | null = null;
  function refresh() {
    if (pending) return pending;
    pending = (async () => {
      const response = await ky.get(url, { timeout: 10000, retry: 0 });
      const parsed = jwks.parse(await response.json());
      const maxAge = Number(/(?:^|,)\s*max-age=(\d+)/i.exec(response.headers.get("cache-control") ?? "")?.[1] ?? 300);
      const age = Number(response.headers.get("age") ?? 0);
      expires = now() + Math.max(0, Math.min(21600, maxAge) - (Number.isFinite(age) ? age : 0)) * 1000;
      keys = parsed.keys;
    })().finally(() => { pending = null; });
    return pending;
  }
  return async (token: string) => {
    if (token.length > 20000) throw invalidOidc();
    const parts = token.split(".");
    const [encodedHeader, payload, signature] = parts;
    if (parts.length !== 3 || !encodedHeader || !payload || !signature) throw invalidOidc();
    const parsed = header.safeParse(decodePart(encodedHeader));
    if (!parsed.success) throw invalidOidc();
    let key = keys.find(item => item.kid === parsed.data.kid);
    const known = key !== undefined;
    if (now() >= expires || (!key && now() - forcedAt >= 30000)) {
      if (!key) forcedAt = now();
      try { await refresh(); }
      catch (error) {
        if (!(error instanceof Error)) throw error;
        if (!known) throw new ApiError(503, "oidc_unavailable", "Sign-in is temporarily unavailable.");
        // Previously trusted keys remain usable during a provider fetch outage.
      }
      key = keys.find(item => item.kid === parsed.data.kid) ?? key;
    }
    if (!key) throw invalidOidc();
    const publicKey = await crypto.subtle.importKey("jwk", { kty: key.kty, n: key.n, e: key.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, Buffer.from(signature, "base64url"),
      new TextEncoder().encode(`${encodedHeader}.${payload}`));
    if (!valid) throw invalidOidc();
    return decodePart(payload);
  };
}
