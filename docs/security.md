# Security

The dashboard supports local owner-key installations and optional Google-authenticated accounts. This page explains what protects each mode and what the operator still has to do.

## What you must do

- **Serve it over HTTPS beyond localhost.** Keys and session cookies travel with every request. For a local host keep `HOST=127.0.0.1` behind an HTTPS reverse proxy; the Cloud Run container uses its main ingress port (see [deploy.md](deploy.md)).
- **Guard local owner keys and hosted sessions.** Each grants control of its account. Don't paste them into agents; give each agent its own token.
- **Keep `data/` private and backed up.** It holds the SQLite database, `credentials.json` (the owner key), `vapid.json` (push signing keys) and `audio/`. `credentials.json` and `vapid.json` are created readable only by you; keep the folder itself private too. Never commit them.
- **Never commit `.env`.** It may hold `GEMINI_API_KEY` or other provider keys.

## Local keys

- `bun run setup` (or `./agentic-dashboard owner-key`) creates the owner key in `data/credentials.json`.
- `bun run agents add <name>` prints an agent key once. The server keeps only its SHA-256 hash, so a lost key can't be recovered, only replaced.
- `bun run agents rotate <name>` issues a new key and stops the old one. `bun run agents remove <name>` revokes it; the agent's records stay.
- Rotate a key whenever it may have leaked, and remove agents you no longer use. `bun run agents list` shows when each was last used.

## Built-in protections

- **Scoped agents.** Within its account, an agent sees its own records, other agents' unarchived material and the owner's unarchived tasks and projects. It can change or trash only what it wrote; only the owner can restore or permanently delete. See [CONTRACT.md](../CONTRACT.md).
- **Sessions.** Local owner sessions use an `HttpOnly`, `SameSite=Strict` cookie that lasts 7 days. Hosted sessions use 30-day `SameSite=Lax` cookies, with `__Host-session` and Secure selected only from the configured HTTPS origin. Both require a CSRF token on every owner mutation. Hosted sign-in rotates the previous browser session.
- **Origin and Host checks.** Requests must use an allowed `Host` and, when a browser sends one, an allowed `Origin`. Local mode allows loopback addresses and `APP_ORIGIN`; hosted mode allows only its configured origin.
- **Rate limits.** API requests allow 300/minute per agent credential or browser account; unknown credentials share a bucket. Auth and public shares have additional network limits described below.
- **Headers.** A strict Content-Security-Policy, `X-Frame-Options: DENY`, `nosniff` and `no-referrer`. HTML and API data use `no-store`; existing content-hashed assets use public immutable caching.
- **Input validation.** Every body is parsed with zod and size-capped. Markdown is rendered to elements, never raw HTML.
- **Logs.** The server never logs request bodies, cookies or keys.

## Hosted threat model and account isolation

Google subjects, not email addresses, identify accounts. Owners have full authority only inside their account; agents are less privileged within that same account. Tenant tables carry `user_id`, and each request selects a fixed tenant service graph rather than mutating a global current user. Record IDs from another account return 404, including delete attempts; relationship validation can return 400. Explicit share/invitation codes are capabilities, not ID-based access. An existing push endpoint moves to the account that most recently subscribed it.

This protects against another account guessing IDs, a token being reused across tenants, and background jobs mixing content or recipients. It does not protect against a compromised operator, database credential, runtime identity or encryption key. Operators can access stored content and decrypt personal keys. Agents inside an account are not isolated from each other's shared material; issue tokens only to trusted tools.

Hosted tokens are created, rotated and revoked from **Agent connections**. Raw tokens appear only once; only SHA-256 hashes are stored. Rotation immediately invalidates the old credential. Revoked names stay reserved and cannot be reactivated; reconnect under a new name. Invitations are hashed, single-use and expire after 15 minutes. Capture requires a capture-enabled agent bearer, and MCP requires an agent bearer on every request, including initialization and notifications; neither accepts a browser session as authority.

`MAX_USERS` defaults to 50 active accounts. Existing accounts can sign in at capacity. `/auth/*` permits 20 requests per client network/minute; public share routes permit 60. Starts also have IPv6 /48 and global budgets; see [hosted-auth.md](hosted-auth.md#sign-in-limits-and-proxy-topology). API/network budgets are per instance, not a distributed denial-of-service guarantee. Narration defaults to 10 jobs per account/day and 60 service-wide; account overrides cannot spend another account's allowance.

Private GCS audio lives under `u/<userId>/`. The authenticated route redirects to a ten-minute signed URL; anyone holding that URL can fetch it until expiry. Cloud Tasks and maintenance routes verify service-account OIDC signatures, audience and identity; job leases suppress duplicate work. Daily private database backups retain 14 days. They contain secrets, unlike user exports, so restrict bucket access and follow the offline restore/tombstone rules.

Users can export or delete their account in Settings. Export is capped at 64 MiB for each tar/gzip file, one concurrent export per account and two per instance; idle generation/download aborts after 60 seconds and removes scratch files. Deletion needs exact email confirmation and recent signed provider authentication. It removes tenant rows and credentials, then the audio prefix; failed object deletion is retried by maintenance. Offline restores honor retained target tombstones; operators must preserve them when restoring an older backup. Verify the real Google client's reauthentication behavior before launch; [hosted-auth.md](hosted-auth.md#deletion-reauthentication) records the current integration caveat.

### Evidence and remaining operator duties

`tests/isolation.test.ts` enumerates every registered HTTP route and MCP tool, exercises account B against account A's content, and checks that A is unchanged. `tests/tenant-app.test.ts`, `tests/oidc.test.ts`, `tests/hosted-agents.test.ts` and the `tests/account-*.test.ts` files cover tenant selection, sessions, revocation, onboarding, export and deletion. `tests/jobs.test.ts` and `tests/operations.test.ts` cover task authentication, duplicate delivery, backup/restore and operator-only alerts. Run `bun test` for the current suite; local mock OIDC checks are not proof of real Google configuration, cloud IAM, backup delivery or alert receipt.

Application logs include operational error classes, record/job IDs and provider/model/status/token-count metadata, not saved bodies or credential values. IP-based limiter state is memory-only; pending sign-in rows use opaque client tags. Hosting/access logs are controlled by the operator and may retain network metadata: configure their access and retention separately. Keep secrets and account data out of QA artifacts, and never use production data for screenshots.

## Optional listeners

- **Agent ingress** (`ENABLE_AGENT_INGRESS`): a separate loopback listener on `AGENT_PORT` that accepts only record saves and reads with an agent key. Expose this one instead of the main listener when agents live outside your network and you don't want the owner UI reachable there.
- **MCP** (`ENABLE_MCP` in local mode): the optional loopback listener requires an agent bearer on every request. Google mode serves the same bearer protocol on the main `/mcp` endpoint instead. A configured `MCP_AGENT` never substitutes for request credentials.

## Authentication request limits

Direct listeners and local mode ignore `X-Forwarded-For` and rate-limit by socket address. Google mode trusts the hop selected from the right by `TRUSTED_PROXY_HOPS` (default 1) only when `AUTH_TRUST_PROXY=on`, or when Cloud Run supplies `K_SERVICE` and no override is set. Enable this only behind an exclusive trusted ingress with that fixed topology; caller-supplied leading hops never select a bucket. `AUTH_TRUST_PROXY=off` disables forwarded trust.

The bounded rate map evicts oldest entries so a key flood cannot lock every fresh client out. A separate atomic database bound keeps at most 20 pending OAuth transactions per opaque client tag, including across minute windows or rate-map eviction. No raw client IP is stored in the transaction row or signed cookie.

## Trusted proxy sign-in

Google mode does not expose the legacy `local` account. Old local share links, invitations, sessions and agent tokens are not accepted on the hosted origin, even when the database was upgraded from self-hosting. Anonymous hosted requests have no persisted account and cannot fall through to local authority. Local data remains available only in explicit local mode; moving it into a hosted account requires a separate operator decision.

`TRUSTED_USER_HEADER` with `OWNER_LOGIN` lets an identity-aware proxy sign the owner in. Use it only when the proxy removes that header from incoming client requests and is the only path to the listener. Otherwise a client can forge the header and become the owner.

Trusted-header bootstrap and owner-key login are local-only. Google mode verifies PKCE, signed state, nonce and RS256 ID-token claims and consumes a database transaction exactly once before issuing a session. Accounts are keyed by subject, never email. Keep `APP_SECRETS.sessionSigningKey` independent from the encryption key.

Personal Gemini keys are AES-256-GCM encrypted with per-user authenticated data. Keep all required KEK versions in `APP_SECRETS.kek` until `scripts/rotate-kek.ts` succeeds, then retire old versions. A valid model-list response is not proof of audio-model permission or quota. Hosted readers are directed to their own key settings or the operator; only local users see server-admin audio guidance. See [hosted-auth.md](hosted-auth.md) for configuration and isolated QA.

## Shares

A share link (`/s/<code>`) is readable without sign-in by anyone who has the code and can reach the server, including on a public host. Sharing starts only when the owner chooses Share. It includes the record's title, source, dates, status, summary, conclusion, body, next steps, links, tags and previous-record reference, not personal notes or attached HTML/audio. Stop sharing in the reader revokes the link; it cannot remove copies a recipient already saved.

## Reporting a vulnerability

Please open a private security advisory on the repository rather than a public issue.
