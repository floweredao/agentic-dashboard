import { z } from "zod";

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const sha256 = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("base64url");
const authorization = z.object({
  redirect_uri: z.url(), state: z.string(), nonce: z.string(), code_challenge: z.string(),
  code_challenge_method: z.literal("S256"), client_id: z.string(),
});

/** A real HTTP issuer with generated RSA keys and single-use, PKCE-bound codes. No Google account is needed. */
export async function mockOidc(now: () => number = Date.now) {
  const algorithm = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
  let pair = await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]);
  let kid = crypto.randomUUID();
  let jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const codes = new Map<string, z.infer<typeof authorization>>();
  const state: { claims: Readonly<Record<string, unknown>>; header: Readonly<Record<string, unknown>>; badSignature: boolean; jwksStatus: number; jwksCalls: number } =
    { claims: {}, header: {}, badSignature: false, jwksStatus: 200, jwksCalls: 0 };
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/.well-known/openid-configuration") return Response.json({
        issuer: url.origin, authorization_endpoint: `${url.origin}/authorize`, token_endpoint: `${url.origin}/token`, jwks_uri: `${url.origin}/jwks`,
      });
      if (url.pathname === "/jwks") {
        state.jwksCalls++;
        return Response.json({ keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] },
          { status: state.jwksStatus, headers: { "Cache-Control": "public, max-age=300", Age: "10" } });
      }
      if (url.pathname === "/authorize") {
        const input = authorization.parse(Object.fromEntries(url.searchParams));
        const code = crypto.randomUUID();
        codes.set(code, input);
        const callback = new URL(input.redirect_uri);
        callback.searchParams.set("code", code);
        callback.searchParams.set("state", input.state);
        return Response.redirect(callback);
      }
      if (url.pathname === "/token" && request.method === "POST") {
        const form = new URLSearchParams(await request.text());
        const code = form.get("code") ?? "";
        const input = codes.get(code);
        codes.delete(code);
        if (!input || sha256(form.get("code_verifier") ?? "") !== input.code_challenge ||
          form.get("redirect_uri") !== input.redirect_uri || form.get("client_id") !== input.client_id ||
          form.get("grant_type") !== "authorization_code") return Response.json({ error: "invalid_grant" }, { status: 400 });
        const seconds = Math.floor(now() / 1000);
        const body = `${encode({ alg: "RS256", kid, ...state.header })}.${encode({
          iss: url.origin, aud: input.client_id, sub: "mock-subject", email: "reader@example.test",
          email_verified: true, name: "Example Reader", exp: seconds + 300, iat: seconds, nonce: input.nonce, ...state.claims,
        })}`;
        const signature = await crypto.subtle.sign(algorithm, pair.privateKey, new TextEncoder().encode(body));
        const bytes = new Uint8Array(signature);
        if (state.badSignature) bytes[0] = (bytes[0] ?? 0) ^ 255;
        return Response.json({ id_token: `${body}.${Buffer.from(bytes).toString("base64url")}` });
      }
      return new Response("Not found", { status: 404 });
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  return {
    state, origin,
    endpoints: { authorization: `${origin}/authorize`, token: `${origin}/token`, jwks: `${origin}/jwks`, issuers: [origin] },
    async serviceToken(claims: Readonly<Record<string, unknown>>) {
      const body = `${encode({ alg: "RS256", kid })}.${encode({ iss: origin, sub: "mock-service",
        iat: Math.floor(now() / 1000), exp: Math.floor(now() / 1000) + 300, email_verified: true, ...claims })}`;
      const signature = await crypto.subtle.sign(algorithm, pair.privateKey, new TextEncoder().encode(body));
      return `${body}.${Buffer.from(signature).toString("base64url")}`;
    },
    async rotate() {
      pair = await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]);
      kid = crypto.randomUUID();
      jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    },
    close() { server.stop(true); },
  };
}
