# Hosted accounts

`AUTH_MODE=local` keeps SQLite, owner-key login, optional trusted proxy login and environment-backed Gemini credentials. `AUTH_MODE=google` enables account sign-in, account-scoped agent tokens, bearer capture/MCP and encrypted personal Gemini keys. It uses only the main listener.

Switching an existing database to Google mode does not publish its local account. Local records, share codes, invitations and credentials stay stored but cannot be used on the hosted origin. A Google subject bound to the local row is refused rather than silently linked. No new anonymous user row is created, and local-account background services are not resumed. Hosted users' explicit share links continue to work. Use local mode to access the old account; any data migration is a separate decision.

The included tooling can deploy this mode; there is no public multi-user instance yet. The read-only demo is not an account service. [Deploying](deploy.md#hosted-google-sign-in-deployment-tooling) covers Cloud Run, Turso, private GCS audio/backups, Cloud Tasks, Scheduler, Secret Manager and budget alerts. Tooling has local tests and dry-run verification, not production acceptance evidence.

## First sign-in and account controls

New accounts enter `/welcome`: choose language and time zone, connect an agent, configure digests, optionally add a personal Gemini key, and review home-screen/push setup. Finish requires a real external agent save through REST without a browser Origin or bearer MCP; the browser's test record alone does not count. Returning onboarded accounts open the dashboard. Settings can replay setup and change account preferences.

Settings also offers a credential-free `.tar.gz` export and account deletion. Export includes saved content, documents, comments, digests, scripts and referenced audio, but no token/session hashes, Gemini ciphertext or push encryption credentials. It is not the operator backup or an import format. Generation and download each stop after 60 seconds without byte progress. The tar and gzip each have a 64 MiB cap; one export per account and two per instance protect memory. Busy-account responses are 429, full-instance responses 503, with `Retry-After: 60`; ordinary reading remains available.

Deletion requires exact email confirmation and recent provider reauthentication, not merely a new dashboard session. It revokes sessions/tokens, removes tenant rows, scrubs identity/key fields and deletes the audio prefix (maintenance retries failures). The Google subject remains in a tombstone; signing in later creates a new empty account. Backups expire after 14 days and restores honor tombstones. See the reauthentication interoperability caveat below before offering deletion on a live Google client.

`/privacy` and `/terms` are public, localized pages linked from sign-in, setup and Settings. Set the real public `CONTACT_EMAIL` and declare the actual `DATABASE_REGION`; the database region is not inferred from Cloud Run.

## Operator configuration

Set `APP_ORIGIN` to the exact public HTTPS origin and register `${APP_ORIGIN}/auth/google/callback` with the Google OIDC client. Loopback HTTP is accepted for isolated tests. Never derive origin or cookie security from a client header.

Provide `APP_SECRETS` as private JSON, with:

- `google.clientId` and `google.clientSecret`;
- `sessionSigningKey`, an independent random secret of at least 32 characters;
- `kek`, a version-number-to-base64 map of 32-byte AES keys, for example version `1`;
- `vapid.publicKey` and `vapid.privateKey` when push is enabled;
- optional `turso.authToken/platformToken/org` and `resend.apiKey` for database access, usage monitoring and operator alerts.

Keep the JSON out of source, logs, screenshots and shell history. `DATABASE_AUTH_TOKEN` takes precedence over the Turso token in that JSON. `MAX_USERS` defaults to 50 active hosted accounts; existing accounts can still sign in at capacity.

`OWNER_ALERT_EMAIL` plus the Resend key enable operator-only sign-up, capacity, maintenance-failure and usage alerts; no email goes to users. Turso usage monitoring also needs the platform token and organization. Daily maintenance backs up database rows to private GCS, checks usage, and retries deleted-account audio cleanup. Keep backup credentials private. Internal task routes require a verified Google service-account OIDC token with the configured audience; a public Cloud Run listener does not make them public actions.

Hosted narration defaults to 10 jobs per account per server-zone day and 60 across the service. `NARRATION_DAILY_LIMIT`, `NARRATION_GLOBAL_DAILY_LIMIT` and `OWNER_USER_LIMITS` configure these limits. Automatic narration starts off. Provider quota is separate; adding a key does not promise generation capacity.

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

## Runtime environment reference

This inventory covers every setting parsed by `server/config.ts`, including
advanced overrides not shown in `.env.example`. Deployment-file fields such as
`PROJECT_ID` are tooling inputs, not application environment variables; see
[deploy.md](deploy.md#one-private-configuration-file).

| Variables | Meaning and mode |
|---|---|
| `HOST`, `PORT` | Main binding, default `127.0.0.1:4310`; container uses `0.0.0.0:8080` |
| `AUTH_MODE`, `APP_SECRETS` | `local` by default; `google` requires the secret JSON described above |
| `APP_ORIGIN`, `APP_NAME` | Exact browser origin and display name; default name `Agentic Dashboard` |
| `DATA_DIR`, `DATABASE_PATH`, `CREDENTIALS_PATH` | Data root `data`; optional overrides for `dashboard.sqlite` and local `credentials.json` |
| `DATABASE_URL`, `DATABASE_AUTH_TOKEN` | Local/file or remote libSQL/HTTPS backend and private remote credential; URL overrides database path |
| `STATIC_DIR` | Built web assets, default `dist` |
| `TIME_ZONE`, `LOCALE` | Server calendar/day-reset zone (host zone by default) and push/default UI language (`en` by default); account calendar preferences are separate |
| `AUTH_TRUST_PROXY`, `K_SERVICE`, `TRUSTED_PROXY_HOPS` | Forwarded-address trust, automatic Cloud Run detection, and right-counted trusted hop; Google mode only |
| `AUTH_START_LIMIT`, `PENDING_SIGN_IN_LIMIT` | Global per-instance starts/minute and shared pending-row cap, default `900` / `10000`; cap must exceed ten times starts |
| `MAX_USERS` | Maximum active hosted accounts, default `50`; `0` closes new sign-ups |
| `TRUSTED_USER_HEADER`, `OWNER_LOGIN` | Local trusted proxy login; set both or neither, unavailable in Google mode |
| `ENABLE_AGENT_INGRESS`, `AGENT_PORT`, `PUBLIC_API_BASE_URL` | Local-only extra record listener, off / `4312`; optional public agent API address used in setup |
| `ENABLE_MCP`, `MCP_PORT`, `MCP_AGENT` | Local-only extra MCP listener, off / `4313`, requiring an active named agent and bearer; Google mode uses main `/mcp` |
| `PUSH`, `VAPID_PATH`, `VAPID_SUBJECT` | Push on by default; optional local key-file override and `mailto:`/HTTPS subject. Hosted keys and subject come from secrets/origin |
| `DIGEST`, `NARRATION` | Feature switches, both on by default; narration also needs a usable provider/key |
| `NARRATION_TTS_MODEL`, `NARRATION_SCRIPT_MODEL`, `NARRATION_KEY_SCRIPT_MODEL` | Speech (`gemini-3.8-flash-tts`), Vertex script (`gemini-4-argon`) and key script (`gemini-3.8-flash`) model names |
| `NARRATION_VOICE`, `NARRATION_PODCAST_VOICE` | Default primary/secondary voices, `Kore` / `Puck`; users can choose voices in Settings |
| `NARRATION_TTS_PROVIDER`, `NARRATION_VERTEX_PROJECT`, `NARRATION_VERTEX_LOCATION` | `gemini` by default; `vertex` requires a project and ADC, location defaults to `global` |
| `NARRATION_RECORD_AUTO`, `NARRATION_DIGEST_AUTO` | Local record default `read` (`off`, `read`, `podcast`); digest default `off` (`off`, `parts`, `all`). Hosted record automation starts off |
| `NARRATION_CONCURRENCY` | Concurrent jobs per tenant, `1..4`, default `2` |
| `NARRATION_DAILY_LIMIT`, `NARRATION_GLOBAL_DAILY_LIMIT`, `OWNER_USER_LIMITS` | Local/account daily starts `20`/`10`, service-wide `60`, and account-ID-to-limit JSON overrides; failed starts count |
| `AUDIO_DIR`, `AUDIO_BUCKET` | Optional local audio directory; private GCS backend when bucket is set |
| `GEMINI_API_KEY` | Local environment-backed key; hosted users supply their own encrypted key in Settings |
| `AI_FILL_COMMAND`, `AI_FILL_SOURCES`, `AI_FILL_MODEL` | Local stdin/stdout command and comma-separated sources; hosted title fill uses the personal key and model, default `gemini-3.5-flash-lite` |
| `OWNER_ALERT_EMAIL`, `CONTACT_EMAIL`, `DATABASE_REGION` | Operator-only alert recipient, required hosted public contact, and operator-declared database location |
| `TASKS_QUEUE`, `TASKS_SERVICE_ACCOUNT` | Set together with `APP_ORIGIN` for Cloud Tasks; otherwise in-process work and local maintenance timers |
| `DEMO`, `DEMO_HOSTED_URL` | Read-only local demo off by default; optional hosted-account destination. Demo cannot run with Google auth or write integrations |

Local Vertex credentials use `GOOGLE_APPLICATION_CREDENTIALS` or the standard
ADC file created by `gcloud auth application-default login`. This credential-file
lookup is in `server/vertex.ts`, not the main config schema; keep it private.

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
