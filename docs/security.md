# Security

The dashboard supports local owner-key installations and optional Google-authenticated accounts. This page explains what protects each mode and what the operator still has to do.

## What you must do

- **Serve it over HTTPS beyond localhost.** Keys and session cookies travel with every request. Keep `HOST=127.0.0.1` and put an HTTPS reverse proxy in front (see [deploy.md](deploy.md)).
- **Guard the owner key.** It can read, change and delete everything. Don't paste it into agents; give each agent its own key.
- **Keep `data/` private and backed up.** It holds the SQLite database, `credentials.json` (the owner key), `vapid.json` (push signing keys) and `audio/`. `credentials.json` and `vapid.json` are created readable only by you; keep the folder itself private too. Never commit them.
- **Never commit `.env`.** It may hold `GEMINI_API_KEY` or other provider keys.

## Keys

- `bun run setup` (or `./agentic-dashboard owner-key`) creates the owner key in `data/credentials.json`.
- `bun run agents add <name>` prints an agent key once. The server keeps only its SHA-256 hash, so a lost key can't be recovered, only replaced.
- `bun run agents rotate <name>` issues a new key and stops the old one. `bun run agents remove <name>` revokes it; the agent's records stay.
- Rotate a key whenever it may have leaked, and remove agents you no longer use. `bun run agents list` shows when each was last used.

## Built-in protections

- **Scoped agents.** An agent sees only its own records, shared material and the owner's open tasks and projects. It can change only what it wrote and can't delete anything. See [CONTRACT.md](../CONTRACT.md).
- **Sessions.** Local owner sessions use an `HttpOnly`, `SameSite=Strict` cookie that lasts 7 days. Hosted sessions use 30-day `SameSite=Lax` cookies, with `__Host-session` and Secure selected only from the configured HTTPS origin. Both require a CSRF token on every owner mutation. Hosted sign-in rotates the previous browser session.
- **Origin and Host checks.** Requests must use an allowed `Host` and, when a browser sends one, an allowed `Origin`: the loopback addresses and `APP_ORIGIN`.
- **Rate limits.** 300 requests per minute per credential. Unknown credentials share one bucket, so guessing keys doesn't buy extra attempts.
- **Headers.** A strict Content-Security-Policy, `X-Frame-Options: DENY`, `nosniff`, `no-referrer` and `no-store` on every response.
- **Input validation.** Every body is parsed with zod and size-capped. Markdown is rendered to elements, never raw HTML.
- **Logs.** The server never logs request bodies, cookies or keys.

## Optional listeners

- **Agent ingress** (`ENABLE_AGENT_INGRESS`): a separate loopback listener on `AGENT_PORT` that accepts only record saves and reads with an agent key. Expose this one instead of the main listener when agents live outside your network and you don't want the owner UI reachable there.
- **MCP** (`ENABLE_MCP` in local mode): the optional loopback listener requires an agent bearer on every request. Google mode serves the same bearer protocol on the main `/mcp` endpoint instead. A configured `MCP_AGENT` never substitutes for request credentials.

## Authentication request limits

Direct listeners and local mode ignore `X-Forwarded-For` and rate-limit by socket address. Google mode trusts the rightmost forwarded hop only when `AUTH_TRUST_PROXY=on`, or when Cloud Run supplies `K_SERVICE` and no override is set. Enable this only behind an exclusive trusted ingress that appends the real client IP; caller-supplied leading hops never select a bucket. `AUTH_TRUST_PROXY=off` disables forwarded trust.

The bounded rate map evicts oldest entries so a key flood cannot lock every fresh client out. A separate atomic database bound keeps at most 20 pending OAuth transactions per opaque client tag, including across minute windows or rate-map eviction. No raw client IP is stored in the transaction row or signed cookie.

## Trusted proxy sign-in

`TRUSTED_USER_HEADER` with `OWNER_LOGIN` lets an identity-aware proxy sign the owner in. Use it only when the proxy removes that header from incoming client requests and is the only path to the listener. Otherwise a client can forge the header and become the owner.

Trusted-header bootstrap and owner-key login are local-only. Google mode verifies PKCE, signed state, nonce and RS256 ID-token claims and consumes a database transaction exactly once before issuing a session. Accounts are keyed by subject, never email. Keep `APP_SECRETS.sessionSigningKey` independent from the encryption key.

Personal Gemini keys are AES-256-GCM encrypted with per-user authenticated data. Keep all required KEK versions in `APP_SECRETS.kek` until `scripts/rotate-kek.ts` succeeds, then retire old versions. A valid model-list response is not proof of audio-model permission or quota. Hosted readers are directed to their own key settings or the operator; only local users see server-admin audio guidance. See [hosted-auth.md](hosted-auth.md) for configuration and isolated QA.

## Shares

A share link (`/s/<code>`) is readable without sign-in by anyone who has the code and can reach the server, including on a public host. Sharing starts only when the owner chooses Share. It includes the record's title, source, dates, status, summary, conclusion, body, next steps, links, tags and previous-record reference, not personal notes or attached HTML/audio. Stop sharing in the reader revokes the link; it cannot remove copies a recipient already saved.

## Reporting a vulnerability

Please open a private security advisory on the repository rather than a public issue.
