import { createHmac, timingSafeEqual } from "node:crypto";
import ky from "ky";
import { z } from "zod";
import { hash, secret } from "./agents";
import type { ControlDb } from "./control-db";
import { ApiError } from "./errors";
import { createJwks, decodePart, invalidOidc } from "./oidc-jwks";

export interface GoogleEndpoints {
  readonly authorization: string;
  readonly token: string;
  readonly jwks: string;
  readonly issuers: readonly string[];
}
export interface HostedAuth {
  readonly sessionSigningKey: string;
  readonly google: { readonly clientId: string; readonly clientSecret: string };
  readonly maxUsers: number;
  readonly endpoints?: GoogleEndpoints;
  /** Delivery is wired by the hosted operations layer; receives no identity or credentials. */
  readonly onCapacity?: () => void | Promise<void>;
}
const endpoints: GoogleEndpoints = {
  authorization: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token", jwks: "https://www.googleapis.com/oauth2/v3/certs",
  issuers: ["https://accounts.google.com", "accounts.google.com"],
};
const transaction = z.object({ state: z.string(), nonce: z.string(), verifier: z.string(), started: z.number() }).strict();
const claims = z.object({
  iss: z.string(), aud: z.union([z.string(), z.array(z.string()).min(1)]), azp: z.string().optional(),
  sub: z.string().min(1).max(255), exp: z.number(), iat: z.number(), nonce: z.string(),
  email_verified: z.boolean(), email: z.email(), name: z.string().max(500).optional(),
});
const same = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
export const oidcCookie = (value: string, secure: boolean, maxAge = 600) =>
  `oidc_tx=${value}; Path=/auth/google; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;

export function createOidc(options: { readonly hosted: HostedAuth; readonly origin: string; readonly control: ControlDb; readonly now: () => number }) {
  const { hosted, origin, control, now } = options;
  const provider = hosted.endpoints ?? endpoints;
  const verify = createJwks(provider.jwks, now);
  const sign = (body: string) => createHmac("sha256", hosted.sessionSigningKey).update(body).digest("base64url");
  return {
    async start() {
      const tx = { state: secret(), nonce: secret(), verifier: Buffer.from(crypto.getRandomValues(new Uint8Array(64))).toString("base64url"), started: now() };
      const body = Buffer.from(JSON.stringify(tx)).toString("base64url");
      const cookie = `${body}.${sign(body)}`;
      await control.startOAuth(hash(cookie), now() + 600000);
      const url = new URL(provider.authorization);
      url.search = new URLSearchParams({
        response_type: "code", client_id: hosted.google.clientId, redirect_uri: `${origin}/auth/google/callback`,
        scope: "openid email profile", state: tx.state, nonce: tx.nonce,
        code_challenge: new Bun.CryptoHasher("sha256").update(tx.verifier).digest("base64url"),
        code_challenge_method: "S256", prompt: "select_account",
      }).toString();
      return { location: url.href, cookie };
    },
    async callback(request: Request) {
      const params = new URL(request.url).searchParams;
      const code = params.get("code");
      const state = params.get("state");
      if (!code || !state || [...new Set(params.keys())].some(key => params.getAll(key).length !== 1)) throw invalidOidc();
      const cookies = (request.headers.get("cookie") ?? "").split(";").map(part => part.trim()).filter(part => part.startsWith("oidc_tx="));
      if (cookies.length !== 1) throw invalidOidc();
      const cookie = cookies[0]?.slice(8) ?? "";
      const [body, signature, extra] = cookie.split(".");
      if (!body || !signature || extra || !same(signature, sign(body))) throw invalidOidc();
      const parsed = transaction.safeParse(decodePart(body));
      if (!parsed.success) throw invalidOidc();
      const tx = parsed.data;
      if (!same(state, tx.state) || now() < tx.started || now() >= tx.started + 600000) throw invalidOidc();
      if (!await control.consumeOAuth(hash(cookie), now())) throw invalidOidc();
      let result: unknown;
      try {
        result = await ky.post(provider.token, { timeout: 10000, retry: 0, body: new URLSearchParams({
          code, client_id: hosted.google.clientId, client_secret: hosted.google.clientSecret,
          redirect_uri: `${origin}/auth/google/callback`, grant_type: "authorization_code", code_verifier: tx.verifier,
        }) }).json();
      } catch (error) { if (error instanceof Error) throw invalidOidc(); throw error; }
      const tokens = z.object({ id_token: z.string() }).safeParse(result);
      if (!tokens.success) throw invalidOidc();
      const identity = claims.safeParse(await verify(tokens.data.id_token));
      if (!identity.success) throw invalidOidc();
      const user = identity.data;
      const aud = typeof user.aud === "string" ? [user.aud] : user.aud;
      if (!provider.issuers.includes(user.iss) || !aud.includes(hosted.google.clientId) ||
        (user.azp !== undefined && user.azp !== hosted.google.clientId) || (aud.length > 1 && user.azp !== hosted.google.clientId) ||
        user.exp <= now() / 1000 - 60 || user.iat > now() / 1000 + 60 || user.iat < tx.started / 1000 - 60 ||
        !same(user.nonce, tx.nonce)) throw invalidOidc();
      if (!user.email_verified) throw new ApiError(403, "email_unverified", "A verified Google email is required.");
      try {
        return await control.googleUser({ sub: user.sub, email: user.email, name: user.name ?? "", now: now(), maxUsers: hosted.maxUsers });
      } catch (error) {
        if (error instanceof ApiError && error.code === "signup_capacity") await hosted.onCapacity?.();
        throw error;
      }
    },
  };
}
