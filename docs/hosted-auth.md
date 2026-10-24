# Hosted account foundation

`AUTH_MODE=local` keeps SQLite, owner-key login, optional trusted proxy login and environment-backed Gemini credentials. `AUTH_MODE=google` enables account sign-in, account-scoped agent tokens, bearer capture/MCP and encrypted personal Gemini keys. It uses only the main listener.

Switching an existing database to Google mode does not publish its local account. Local records, share codes, invitations and credentials stay stored but cannot be used on the hosted origin. A Google subject bound to the local row is refused rather than silently linked. No new anonymous user row is created, and local-account background services are not resumed. Hosted users' explicit share links continue to work. Use local mode to access the old account; any data migration is a separate decision.

This is an application foundation, not a public-service launch. Operator alert delivery, public legal policies, onboarding completion, account export/deletion, hosted storage and operational jobs belong to the remaining hosted-service plan. `OWNER_ALERT_EMAIL`, `CONTACT_EMAIL` and the task/bucket fields are parsed for that layer; capacity has an injectable `onCapacity` hook, not an email sender.

## Operator configuration

Set `APP_ORIGIN` to the exact public HTTPS origin and register `${APP_ORIGIN}/auth/google/callback` with the Google OIDC client. Loopback HTTP is accepted for isolated tests. Never derive origin or cookie security from a client header.

Provide `APP_SECRETS` as private JSON, with:

- `google.clientId` and `google.clientSecret`;
- `sessionSigningKey`, an independent random secret of at least 32 characters;
- `kek`, a version-number-to-base64 map of 32-byte AES keys, for example version `1`;
- `vapid.publicKey` and `vapid.privateKey` when push is enabled;
- optional `turso.authToken/platformToken/org` and `resend.apiKey` for the hosted operations layer.

Keep the JSON out of source, logs, screenshots and shell history. `DATABASE_AUTH_TOKEN` takes precedence over the Turso token in that JSON. `MAX_USERS` defaults to 50 active hosted accounts; existing accounts can still sign in at capacity.

### Sign-in limits and proxy topology

`/auth/*` permits 20 requests per client network per minute. IPv4 stays per address; IPv6 uses the expanded, lowercase /64 prefix. IPv4-mapped IPv6 uses the corresponding IPv4 address. The same network key binds the pending-sign-in budget across rate windows, without storing the IP itself.

`/auth/google/start` also permits at most 100 accepted starts per IPv6 /48 per minute, alongside the /64 budget. IPv4 and IPv4-mapped addresses retain their per-address budget. `AUTH_START_LIMIT` is the positive-integer ceiling on accepted starts across all clients (default 900/minute). Rejected requests do not spend the aggregate allowances. These additional budgets apply only to starts, not callbacks or logout, so a flood cannot use them to block an already pending callback. The limiter returns 429 with Retry-After: 60.

Pending OAuth transactions expire after ten minutes and are capped at 20 per client network. `PENDING_SIGN_IN_LIMIT` sets the positive-integer global row cap (default 10000). Each insertion removes expired rows, evicts the oldest pending starts as needed, and admits the new start atomically. An evicted browser must start sign-in again.

The higher pending default permits five times the previous maximum storage in exchange for more time to finish sign-in. At 900 starts/minute, ten minutes admits 9000 starts, below the 10000-row cap. Even eleven overlapping fixed-minute windows admit at most 9900, so the defaults prevent a capacity flush within one pending lifetime on one continuously running instance. Startup refuses settings where `AUTH_START_LIMIT * 10 >= PENDING_SIGN_IN_LIMIT`; custom settings also need headroom for minute-boundary bursts.

A saturated global start budget still rejects new starts until the next minute. Saturating the default requires about 45 IPv4 addresses at 20 starts/minute each, or 9 IPv6 /48s at 100 each, rather than the previous 15 IPv4 addresses. This is a trade-off, not full denial-of-service protection. For stronger protection, use Cloud Armor or equivalent edge rate limiting in addition to the application budgets.

Rate budgets are in-memory, per application instance, and reset on minute boundaries or process restart; the pending row cap is shared by the database. Multiple instances multiply the admitted start rate, so size the pending cap and per-instance ceiling together. The /48 counter map records only admitted starts and is bounded by the configured global start allowance each minute; rotating enough /64 keys to evict entries from the separate 10000-key client map cannot reset the aggregate or global counters.

Forwarded addresses are trusted only in Google mode with `AUTH_TRUST_PROXY=on`, or by default when Cloud Run supplies `K_SERVICE`. `AUTH_TRUST_PROXY=off` overrides that default. Local mode always uses the socket address.

`TRUSTED_PROXY_HOPS` is a positive integer counting from the right of `X-Forwarded-For`. It defaults to `1`, selecting the last entry for direct Cloud Run ingress. With an external HTTPS load balancer appending `<client>, <load-balancer-ip>`, set `TRUSTED_PROXY_HOPS=2` to select the client rather than sharing the load balancer's budget. Client-supplied entries to the left of that position are ignored. Missing or invalid entries at the configured position fall back to the socket, not another forwarded entry.

Configure the hop count to match the actual ingress chain, and restrict listener access to that trusted ingress. Do not enable forwarding trust on a directly reachable listener or mix proxy paths with different trusted chain lengths.

To rotate encryption keys, add a higher-numbered KEK while keeping the old versions, then run `bun scripts/rotate-kek.ts` with the same database configuration. It re-encrypts all key rows in one transaction. Remove old versions only after success and according to your backup-restoration policy.

Personal keys are managed in Settings. Model-list validation says **Key accepted**, not **Audio ready**. Reading and saving need no provider key. Hosted automatic audio starts off; title enrichment uses the account's key and `AI_FILL_MODEL` (default `gemini-3.5-flash-lite`).

Validation reports whether the selected script and speech models appear in the key's model list. It does not generate audio or spend model credits. A later visit labels this availability check as not checked; the first actual job separately reports credential, permission, missing-model and quota failures.

## Deletion reauthentication

Deletion intent requests `prompt=login`, `max_age=0` and an essential `auth_time`
ID-token claim. The signed claim must be recent, tied to the requested login
(allowing 60 seconds of clock skew), and no more than ten minutes old. Its
verified timestamp is stored separately from dashboard session creation.
Ordinary SSO sessions without that evidence cannot delete an account.

Google documents `auth_time` as opt-in: enable it for the OAuth client in Google
Auth Platform, or include it in a Custom Claims Template. Missing/stale claims
fail closed. Google's currently documented `prompt` values do not include
`login`; the requested `login`/`max_age` behavior must therefore be verified with
the actual configured Google client before deployment. The local issuer models
the requested behavior but is not proof of Google interoperability.
See the [Google OIDC documentation](https://developers.google.com/identity/openid-connect/openid-connect).

## Local mock OIDC and manual QA

No Google client, external account or real provider key is needed:

```sh
bun install --frozen-lockfile
bun run build
PORT=4390 bun scripts/mock-hosted.ts
```

Open `http://127.0.0.1:4390`. The sign-in button redirects through a local generated-RSA OIDC issuer and back to the real callback. Its helper is `tests/helpers/mock-oidc.ts`; it serves discovery, authorization, single-use PKCE code exchange and JWKS. The harness prints the discovery URL, not credentials. Each harness run uses a new temporary database and generated signing/encryption secrets.

Only this harness accepts keys beginning with `test-`. Audio deliberately fails as `vertex_auth` without calling any provider or playing sound, so operator-facing recovery can be checked. It is not a provider integration test and must never be used as a production entrypoint. Stop it with Ctrl-C to remove its temporary database.

Automated checks:

```sh
bun test tests/oidc.test.ts tests/hosted-agents.test.ts tests/gemini-settings.test.ts tests/mcp-forward.test.ts tests/config.test.ts
bun tests/hosted-surface.ts
```

The surface script drives real HTTP OIDC, creates a bearer, saves with `scripts/agent.ts`, reads through the loopback MCP forwarder, and verifies capture and origin rejection. All credentials and records are synthetic and isolated. The CLI takes attribution from its bearer; it does not accept a separate `--source` flag.

## Container

The Dockerfile includes ffmpeg 7.1 from a pinned multi-platform image digest. It listens on `0.0.0.0:8080`, and encoding prefers ffmpeg, then macOS afconvert, then WAV. Set the same origin/secrets/database configuration at runtime. Building or running a local QA container does not publish or deploy it.
