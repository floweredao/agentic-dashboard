# Contract

This document describes what the server promises: the data model, the HTTP API, who may do what, and the limits. The code is the final word. Shapes and limits live in `shared/contracts.ts`, routes in `server/app.ts`, configuration in `server/index.ts`. Change this file in the same commit as the behavior.

## Storage and account boundaries

All data access uses the asynchronous `Sql` interface. A local path or `file:` URL uses bun:sqlite with WAL, foreign keys and a 5-second busy timeout; `libsql://` and HTTPS URLs use libSQL. `DATABASE_URL` overrides `DATABASE_PATH`; remote credentials come from `DATABASE_AUTH_TOKEN`. Each versioned migration commits its data and `schema_migrations` entry together. Existing single-owner databases upgrade in place under the implicit `local` account.

Every tenant table has a non-null `user_id`: principals, sessions, records, evidence, requests, trash, comments, documents, agent_invites, digests, digest_reactions, narrations, narration_runs, narration_auto, narration_settings, push_subscriptions and shares. Principal names, idempotency keys, digest slots, comments, documents and narration state are scoped to that account. Generated record columns index kind, creation time and archive state. `users` and `schema_migrations` are global control tables.

Request credentials select a fixed tenant service graph. Background audio queues, settings, AI fills and push recipients use the same account. Missing content from another account returns 404, including delete attempts; relationship validation retains its existing 400 response. A share or invitation code is an explicit capability and resolves its issuing account. Subscribing an existing push endpoint moves that device to the account that subscribed last. Trusted proxy identity grants owner authority only in the implicit `local` account; capture with a non-local account's cookie is rejected even with that header. Hosted capture and every MCP request require an agent bearer; `MCP_AGENT` never authenticates a request.

## Principals

In Google mode, unauthenticated requests use a non-persisted public service scope, not the `local` account. The local account is excluded from session, bearer, share, invitation and Google-subject capability resolution, and its service graph is not started. Existing local data and capabilities remain stored but are unavailable on the hosted origin; there is no automatic migration into a Google account. Local mode retains access to them. Hosted-account public shares continue to resolve through their explicit capability.

| Principal | Source value | How it authenticates |
|---|---|---|
| Owner | `manual` | Signs in with the owner key from `data/credentials.json` (session cookie plus CSRF token), or through a trusted proxy header |
| Agent | its registered name, for example `codex` | `Authorization: Bearer <agent key>` |

Agent names match `^[a-z][a-z0-9-]{0,31}$`; `manual` and `owner` are reserved. Agents are managed with `bun run agents add|list|rotate|remove`. The server stores only a SHA-256 hash of each key.

Browser sessions can also create an agent with `POST /api/v1/agents { name, capture? }`, rotate with `POST /api/v1/agents/:name/rotate`, or revoke with `DELETE /api/v1/agents/:name`. All require CSRF. New keys are `fd_` followed by 32 random bytes in base64url, returned once as `{ agent, key }` on create/rotate; list/get never expose keys or hashes. `capture` defaults false and is shown in agent metadata. Revocation and rotation invalidate the previous key immediately. Agent names are attribution within an account, not separate privacy boundaries.

Rotation only updates an active principal. A revoked agent returns `409 agent_revoked` and cannot be reactivated or registered again under the same name; create a token under a new name. The update itself requires `revoked_at IS NULL`, so concurrent revocation cannot be undone by rotation. The UI disables rotation for revoked agents and translates the refusal.

`POST /api/v1/agents/invites { name }` lets a CSRF-authenticated owner issue the existing 15-minute single-use installer invitation for a new name. The connection screen supplies the hosted URL and invitation to the connect-only installer, explains macOS/Linux prerequisites and untested Windows support, and offers a curl fallback. Its test-save action writes through the bearer and reads the returned id through the owner API before showing success.

A one-time connection code (`agentic-dashboard invite <name>` on the host, table `agent_invites`) registers a new agent from another computer: `XXXX-XXXX-XXXX-XXXX` in Crockford base32 (80 random bits, case and dashes ignored), valid for 15 minutes and for one `POST /api/v1/agents/connect`. Only its SHA-256 hash is stored; a new code for the same name replaces the old one, and a name that is already registered gets no code (`409 agent_exists`).

Owner sessions last 7 days. The cookie is `agentic_session`, `HttpOnly`, `SameSite=Strict`, and `Secure` when the origin is HTTPS. Every owner mutation needs the CSRF token from the session response and an allowed `Origin`.

### Optional hosted Google authentication

After a successful JWKS refresh, only keys in the returned set are accepted. A previously cached key may be reused only when the refresh fails.

With Google authentication configured, local owner-key and trusted-header bootstrap are disabled. `GET /auth/google/start` uses PKCE S256, random state/nonce and a signed ten-minute `oidc_tx` cookie. A global `oauth_transactions` row is atomically consumed before code exchange; the same callback cannot create another session. ID tokens require RS256 using the configured provider JWKS, allowed issuer, audience/authorized party, transaction-bound nonce and issue time, expiry and a boolean verified email. Token-selected key URLs are rejected. Production endpoints are Google's; local mock endpoints are an application-construction test seam, not a public request option.

Users are identified only by Google subject, never merged by email. A deleted identity receives a new tenant id. Signups are limited to `MAX_USERS` active hosted accounts (default 50; the local owner is excluded); existing users can still sign in. Capacity returns a 403 explanation with a self-hosting alternative.

Hosted sessions last 30 days and rotate the browser's previous session and CSRF token at sign-in. Cookies are HttpOnly, SameSite=Lax, Path=/, with no Domain: `__Host-session` for configured HTTPS origins, `session` for local HTTP testing. Forwarded headers never decide Secure. The hosted origin is the only allowed browser origin/host. `POST /auth/logout` requires session and CSRF and removes that session. `/auth/*` is limited to 20 requests per client network per minute (configured forwarded hop on trusted hosted ingress; socket address otherwise). New users return to `/welcome`, existing onboarded users to `/`.

`AUTH_TRUST_PROXY=on` enables forwarding trust only in Google mode. Cloud Run (`K_SERVICE` present) enables it by default; `AUTH_TRUST_PROXY=off` overrides that default. `TRUSTED_PROXY_HOPS` is a positive integer selecting the client entry from the right of `X-Forwarded-For` (default 1 for direct Cloud Run; use 2 behind an external HTTPS load balancer appending client and balancer addresses). A missing or invalid selected entry falls back to the socket; local mode always uses the socket address. Only enable trust when the listener is restricted to ingress with that fixed proxy topology. A full 10,000-key client rate map evicts its oldest entry instead of denying every new client. Each client key can hold at most 20 live OAuth transactions across rate windows; `PENDING_SIGN_IN_LIMIT` caps all pending rows (positive integer, default 10000). Expired rows are removed and oldest starts evicted before admitting each new start atomically. Tied expiry times use insertion order. An evicted flow must restart sign-in. Transaction keys use an HMAC client tag in the existing `tx_hash` field, not a stored IP address. The signed cookie retains that tag so a callback can survive a network change.

The browser config adds `authMode: "local" | "google"`. Google mode displays Google-only access and limited signup capacity before authorization; local owner login and demo behavior remain available when Google is not configured.

Rate-limit and pending-sign-in client keys use canonical expanded IPv6 /64 networks. IPv4-mapped IPv6 resolves to its IPv4 address; IPv4 budgets remain per address. Equivalent IPv6 spellings and interface-address rotation within a /64 cannot create fresh budgets.

`/auth/google/start` additionally admits at most 100 starts per IPv6 /48 per minute and `AUTH_START_LIMIT` starts across all clients (positive integer, default 900/minute). These budgets count only admitted starts, survive client-map eviction, and do not apply to callbacks or logout. Rate limiting returns 429 with `Retry-After: 60`. The in-memory budgets are per application instance and reset at minute boundaries or restart; the pending cap is database-wide. Startup refuses `AUTH_START_LIMIT * 10 >= PENDING_SIGN_IN_LIMIT`. The 10000-row default trades five times the previous maximum storage for protection of in-progress sign-ins: 900 starts/minute admits 9000 in the ten-minute pending lifetime, or at most 9900 across eleven overlapping fixed-minute windows, below capacity. Custom settings still need boundary-burst headroom; multiple instances or restarts can admit more starts. Saturating the default ceiling requires about 45 IPv4 addresses or 9 IPv6 /48s and rejects new starts until the next minute. Use Cloud Armor or equivalent edge rate limiting for stronger denial-of-service protection.

## Records

Three logical collections share one table: projects (`project`), tasks (`task`) and material (`research`, `work-report`, `note`, `social`).

### RecordInput

```ts
{
  kind: "project" | "task" | "research" | "work-report" | "note" | "social";
  title: string;                 // trimmed, 1..200
  body: string;                  // default "", at most 120000; record POST and PATCH bodies up to 512 KiB
  status: string;                // default "new"
  projectId: string | null;      // UUID of a project
  taskId: string | null;         // UUID of a task
  dueDate: string | null;        // YYYY-MM-DD
  tags: string[];                // at most 20, each 1..100
  links: { label: string; url: string }[]; // at most 10, http(s), url at most 2048
  fields: Record<string, JSON>;  // at most 8 KiB serialized, depth at most 8
}
```

Statuses: projects `new | idea | planning | active | paused | done`; tasks `new | todo | active | review | paused | done`; other kinds stay `new`.

### DashboardRecord

RecordInput plus `id` (UUID), `source`, `createdBy`, `reviewState` (`pending | approved | rejected`), `archivedAt`, `createdAt`, `updatedAt` and `version` (positive integer). Agent records start `pending`; owner records start `approved`.

### Fields

| Kind | Fields |
|---|---|
| project | `nextAction` |
| task | `today` (boolean), `evidenceIds` (record UUIDs, at most 100) |
| research, work-report, note, social | `summary`, `conclusion`, `nextActions`, `previousId`, plus owner-managed `starred` and `revisitDate` |

`previousId` points at the earlier research, work-report, note or social record this one continues; anything else is `400 invalid_relationship`. Older keys (`goal`, `stage`, `decisions`, `priority`, `taskType`, `acceptance`, `progress`, `result`, `origin`, `significance`, `questions`, `personalNotes`, `savedReason`) are accepted and preserved.

### Agent record format

Every record an agent creates follows one format, whatever the agent's style. Violations fail with `400 record_incomplete` and a message listing every item to fix. The rules are `AGENT_RECORD_RULES`, `AGENT_TAGS` and `AGENT_TEXT`, also published under `agentRecord` in `GET /api/v1/schema`.

- Title: display width at most 40 columns (wide CJK characters and emoji count 2), else `400 title_too_long`.
- Tags: 1 to 5, one word each, no `#`, spaces or commas, at most 20 columns, no duplicates.
- Links: every link has a non-empty label.
- Only the kind's field keys, and `status` only on tasks and projects.
- research and work-report: `body`, `fields.summary`, `fields.conclusion` and `fields.nextActions` are required.
- note: `body` required, `summary` optional.
- social: at least one link and `fields.summary`.
- task: only `today` and `evidenceIds`. project: only `nextAction`.
- `summary`: at most 3 lines and 500 characters. `conclusion` and `nextAction`: one line, at most 300 characters. `nextActions`: one action per line, each starting with `- `.

Owner input and PATCH bodies use the plain schema.

### RecordPatch

```ts
{ expectedVersion: number; changes: Partial<RecordInput without kind> & { reviewState?: "pending" | "approved" | "rejected"; archived?: boolean } }
```

A stale `expectedVersion` fails with `409 version_conflict`. Arrays and `fields` are replaced when supplied.

### Idempotency

`POST /api/v1/records` takes `{ requestId, record }`. The same principal sending the same `requestId` and payload gets `200` with the stored record and `replayed: true`. A different payload under the same `requestId` is `409 idempotency_conflict`.

## Agent permissions

An agent may read:

- every record it created, archived or not;
- unarchived research, work-report, note and social records from anyone;
- the owner's unarchived tasks and projects.

Everything else answers `404 not_found`. `fields.personalNotes` is removed from records the agent didn't create. An agent may PATCH only records it created; it can't delete anything. The agent-only ingress listener narrows reads further, to the agent's own records.

## HTTP API

All routes are under the private listener (`HOST:PORT`, default `127.0.0.1:4310`). Errors look like `{ "error": { "code": "...", "message": "..." } }`; validation errors add `details`. `record_incomplete` also supplies `details: { path: string[], message: string }[]`, with rule guidance but no record values. The browser renders only bounded field-path/message pairs as text, never arbitrary diagnostic objects.

### Public and session

| Route | Who | Result |
|---|---|---|
| `GET /api/health`, `GET /api/v1/health` | anyone | `{ status: "ok" }` |
| `GET /api/v1/config` | anyone | `{ appName, version, timeZone, locale, features: { narration, push, digest, trustedLogin, demo } }`; `version` is the `package.json` version the server was built from |
| `GET /api/v1/schema` | anyone | kinds, field lists, agent format, JSON Schema of RecordInput, `timeZone` |
| `POST /api/v1/auth/session` | owner | `{ token }` to `{ csrfToken, expiresAt }` plus cookie |
| `GET /api/v1/auth/session` | owner | `{ principal, csrfToken, expiresAt }` |
| `DELETE /api/v1/auth/session` | owner | 204 |
| `GET /api/v1/agents` | owner | `{ items }` registered agents |
| `POST /api/v1/agents/connect` | anyone with a connection code | `{ code }`; 201 `{ agent, key }` once (the agent is registered then); unknown, used or expired codes 404 `invite_invalid`; not on the agent ingress; 403 in demo mode |

### Account and onboarding

`GET /api/v1/account` returns `{ account: { id, email, locale, timeZone,
onboardedAt, features: { digest, push }, agentSaveVerified } }` to its owner session.
Google-mode `GET /api/v1/auth/session` also includes this account projection.
`PATCH /api/v1/account/preferences` (session + CSRF) persists `locale`
(`system`, `en`, `ko`), an IANA `timeZone`, and feature choices. The calendar
preference does not change the fixed server-zone narration reset.
`POST /api/v1/onboarding/done` requires a successful external agent record save
and sets `users.onboarded_at`; a manual sample or same-origin browser token test
does not count. REST bearer saves without a browser Origin and bearer MCP saves
prove the connection. Reading and saving require no Gemini key.

`GET /api/v1/account/export` is an authenticated, non-cacheable `.tar.gz` download.
It includes `README.txt`, `data.json` with the account and every tenant table,
HTML documents, trash, comments, digests/reactions, scripts, referenced `audio/`
files, agents, shares and settings. Token/session/invitation hashes, CSRF secrets,
Gemini ciphertext/KEK version and push encryption credentials are excluded.
There is no user-facing bulk import; this export is not the operator backup format.

`DELETE /api/v1/account` is hosted-only and requires CSRF, exact email confirmation
`{ confirm }`, and a session created less than ten minutes ago. Wrong confirmation
returns 400; stale authentication returns 403 `reauth_required`. One transaction
removes all tenant rows and leaves a scrubbed user tombstone with Google subject
and deletion timestamp. Sessions and agent tokens are revoked. Audio-prefix
deletion follows; failed object removal is retried by daily maintenance. Backups
expire after 14 days and offline restores honor target tombstones. A later Google
sign-in creates a new empty account instead of restoring deleted data.

### Records

| Route | Who | Result |
|---|---|---|
| `GET /api/v1/records` | owner, agent | `{ items, nextCursor }`; query `kind`, `status`, `reviewState`, `archived` (`false`, `true`, `all`), `projectId`, `q`, `dueFrom`, `dueTo`, `limit` (1..50), `cursor` |
| `POST /api/v1/records` | owner, agent | 201 `{ record, replayed: false }` |
| `GET /api/v1/records/:id` | owner, agent | `{ record }` |
| `PATCH /api/v1/records/:id` | owner, agent (own records) | `{ record }` |
| `DELETE /api/v1/records/:id` | owner, or the agent that created the record | body `{ expectedVersion }`; moves the record to the trash, 204 (another agent's or the owner's record 403) |
| `GET /api/v1/trash` | owner | `{ items }` with `deletedAt` and `purgeAt` |
| `POST /api/v1/trash/:id/restore` | owner | `{ record }` |
| `DELETE /api/v1/trash/:id`, `DELETE /api/v1/trash` | owner | permanent delete, 204 |

Trashed records are purged after 30 days.

### Comments (task and project timelines)

| Route | Who | Result |
|---|---|---|
| `GET /api/v1/comments` | owner, agent | timeline or queue; `state` is `new`, `open` or `all` |
| `POST /api/v1/comments` | owner, agent | `{ requestId, recordId?, replyTo?, body, status?, done? }`; body at most 4000 characters |
| `POST /api/v1/comments/:id/seen` | owner, agent | marks an owner comment seen |
| `POST /api/v1/comments/:id/done` | owner, agent | marks it handled |

### Shares

| Route | Who | Result |
|---|---|---|
| `GET`, `POST`, `DELETE /api/v1/records/:id/share` | owner | read, create or revoke a record's share |
| `GET /api/v1/shared/:code` | anyone with the code | `{ share, record }` |
| `GET /s/:code` | anyone with the code | the record as plain-text Markdown |

The Markdown wrapper uses the server's `LOCALE` (`en` by default, or `ko`); original record content, agent names, status values and JSON projection keys are unchanged. Anyone who has the link and can reach the server can read the shared projection without sign-in until revocation; a public host gives no private-network restriction. Revocation cannot remove recipients' saved copies.

### Record documents

A research, work-report, note or social record may carry one HTML document, the full page of the research (`DOCUMENT_LIMITS`: at most 1 MiB of HTML, request bodies up to 2 MiB). It is kept apart from the record JSON, stays while the record is in the trash and goes when the record is deleted for good. The body keeps the same content as Markdown for search and narration.

| Route | Who | Result |
|---|---|---|
| `GET /api/v1/records/:id/document` | owner, agent that may read the record | `{ document: { html, bytes, updatedBy, updatedAt } \| null }` |
| `PUT /api/v1/records/:id/document` | owner (CSRF), the agent that created the record | `{ html }`; `{ document }`; another agent 403, empty or over 1 MiB 400, tasks and projects 400 `document_unsupported` |
| `DELETE /api/v1/records/:id/document` | same | 204 |

The reader opens a record with a document on it, with a [Full document | Summary] switch and the conclusion and summary shown briefly above. The document renders in an iframe (`srcdoc`, `sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"`, never `allow-scripts`), so no script in it runs; the dashboard CSP applies inside: inline styles work, `data:` and `blob:` images and audio load and play, external scripts, styles, fonts and images do not. Links open in a new tab, `#section` links move within the document, and the frame grows to the document's height without scrolling on its own. A full-screen button shows the reading content alone; Close or Escape returns. CLI: `--html page.html` with a save or `--update` attaches it; `--get` adds `document: { bytes, updatedAt } | null`.

### Digests (when `DIGEST` is on)

| Route | Who | Result |
|---|---|---|
| `POST /api/v1/digests` | agent | upsert by `date` and `slot`; 201 created or 200 updated |
| `GET /api/v1/digests` | owner, agent | list; `from`, `to` (at most 92 days) |
| `GET /api/v1/digests/search` | owner, agent | item search |
| `GET /api/v1/digests/:id` | owner, agent | `{ digest, reactions }` |
| `POST /api/v1/digests/:id/read` | owner | `{ read, part? }` |
| `PUT /api/v1/digests/:id/reactions` | owner | `{ section, key, reaction }` -> `{ reactions }` |
| `GET /api/v1/digests/reactions` | owner, agent | `days` (1 to 92, default 30) -> `{ items, from }`, newest first |

A digest has 1 to 12 sections of kind `articles` or `messages`, each with at most 60 items, and the body is at most 256 KiB. Slots are `morning`, `evening` or `HH:MM`. Sections with an existing key replace it in place; new keys are appended. `notify: false` skips push. A section shows under its own `title`, except the key `social` (posts picked from social networks, kind `articles`), which the app names Social / 소셜 in its own language; a digest has no social section unless an agent sends one.

The agent CLI accepts `--briefing <dir>` to convert `news.json`, `mail.json` and AI-edition `x.json` into this public digest shape, or `--briefing-file <file>` for an already converted body (`--digest` also accepts that body). `--sections <names>` filters the upload and `--quiet` sets `notify: false`. AI input `aiDevelopment` becomes the `ai-development` articles section; social posts use `social`, mail uses kind `messages`, and AI editions use their scheduled `HH:MM` slot. Input titles or English/Korean defaults name the sections. `--briefings` aliases `--digests`, and `--briefing-reactions` aliases `--digest-reactions`. Authentication stays the connected key or `DASHBOARD_TOKEN`; see [the agent guide](docs/agents.md) for input fields.

Reactions: the owner can mark each article Like, Not for me or Seen it (`like`, `dislike`, `seen`; `null` takes it back). They live in the add-only table `digest_reactions` (created on start with `CREATE TABLE IF NOT EXISTS`), one per article, keyed by digest, section key and article key, and keep the article's title, source and link (`originalUrl` when present) as they were, so a later upload that rewrites the section leaves them readable. `reactions` on a digest is `{ "<section>:<key>": reaction }`. A messages section answers 400 and an article the digest does not have 404. Agents read recent reactions (`{ digestId, date, slot, section, key, reaction, title, source, url, updatedAt }`) to raise liked topics, lower disliked ones and skip stories already seen in the next digest; CLI `bun run agent --digest-reactions [--days N]`.

### Narration (when a provider key is set)

Audio storage uses an account-scoped `AudioStore`. Without `AUDIO_BUCKET`, the existing
local files and authenticated byte-range route remain unchanged. With `AUDIO_BUCKET`,
objects use `u/<userId>/<name>` in a private GCS bucket; completed encodes are temporary
files, uploaded with `private, max-age=600` object metadata. The authenticated audio
route returns 302 with `Cache-Control: private, no-store` to a ten-minute V4 signed
GET URL. The runtime service account signs through IAM `signBlob`; metadata-server
credentials never enter responses or logs. Cloud pruning follows narration rows,
not filesystem enumeration. Replacing or deleting audio removes its object.

| Route | Who | Result |
|---|---|---|
| `GET`, `POST`, `DELETE /api/v1/records/:id/narration` | owner, agent in read scope (DELETE owner only) | state, start (`{ force?, style? }`, 202 when started), remove |
| `POST /api/v1/records/:id/narration/cancel` | owner | stop a running job |
| `GET /api/v1/records/:id/narration/audio` | owner, agent in read scope | audio with byte ranges |
| `/api/v1/digests/:id/narration` and `/cancel`, `/audio` | owner | the same for one digest part (`articles`, `messages`) or the whole digest (`all`) |
| `GET /api/v1/narration/allowance` | owner | `{ limit, used, remaining, resetsAt, timeZone, failedStartsCount: true }` |

Hosted overrides to the local defaults below: Google accounts get 10 daily starts
unless `NARRATION_DAILY_LIMIT` is set. `OWNER_USER_LIMITS` is a JSON object mapping
account IDs to explicit limits, for example `{"operator-user-id":20}`. Automatic
audio never raises a hosted allowance and begins off. A start is counted when
queued, including a job that later fails; starts are not a count of provider calls
or a spending cap. Resets follow the server's `TIME_ZONE`, not a device setting.
Daily-limit 429 responses include `error.retryAt` and `Retry-After` seconds.
Provider retry deadlines are persisted as `narration.retryAt`. A new start before
that deadline returns `429 narration_retry_later` with the same retry metadata.
An upload that loses its account or job lease is removed rather than published.

Only research, work-report, note and social records can be narrated. Limits: 6000-character scripts (10,000 for a digest, whose script tells every sentence of each article summary and is written once more when a Korean one leaves out a number the summary states), 20 queued jobs per account, `NARRATION_DAILY_LIMIT` runs per account per day (default 20), a service-wide `NARRATION_GLOBAL_DAILY_LIMIT` (default 60; 429 `narration_global_daily_limit`) and 3 failed attempts per content version. `style` is `read` (one voice) or `podcast` (two hosts, records only); the state reports the style last chosen, which is the default for the next request. A busy or rate-limited provider is retried with backoff. Vertex scripts use `NARRATION_SCRIPT_MODEL` (default `gemini-4-argon`); AI Studio scripts use `NARRATION_KEY_SCRIPT_MODEL` (default `gemini-3.8-flash`). A script gets 1 + 4 tries: with Vertex configured it is streamed first from the Vertex model through `streamGenerateContent?alt=sse`, then from the key model through AI Studio, taking the two routes in turn; a try that sends nothing for 30 s or goes quiet for 90 s fails as `stalled` and, like `timeout`, is followed at once; another transient failure waits as above; a route that fails for good is not asked again. When every try fails the job fails with the last failure and nothing is spoken. Each script try logs one line naming the host and the model that wrote it, never a token. Each job reports its stage, `progress` (while scripting the script characters streamed in so far over the expected length; while speaking the chunks done and total) and `stepAt` (when the current step began), `scriptTry` (only while a script is on its second or later try: which try is running; absent otherwise, so clients built before it still parse the state); a failure names its cause. A record is scripted from its whole body: code, tables, link-only lines and source or reference sections are left out, the rest is split at its headings into parts of at most 5,000 characters, each part is scripted in order (up to 18,000 characters each, else the job fails as `script_too_long`), and a part script under 60% of its source is written once more. Scripts saved under earlier rules are rewritten. A Korean script with plain (반말) endings or written almost all in 해요체 or in 습니다체 is written once more. Korean audio reads each number before a known unit as it is spoken (5곳 다섯 곳, 6월 유월, 4.2% 사 점 이 퍼센트); the saved script keeps the digits.

The owner chooses the voices and speaking styles in Settings › Narration voices. `GET /api/v1/narration/voices` (owner) answers `{ settings, defaults, voices }`: `settings` and `defaults` are `{ readVoice, hostA, hostB, readStyle, podcastStyle }` (`readVoice` reads aloud and reads digests, `hostA`/`hostB` are the podcast hosts and must differ, styles 1-300 characters), and `voices` is the 117 Korean voices of the Gemini TTS voice library (`shared/voices.ts`) plus the configured `NARRATION_VOICE`/`NARRATION_PODCAST_VOICE` it does not name (gender `neutral`). `PUT /api/v1/narration/voices` (owner, CSRF) saves a choice (400 `invalid_input` or `invalid_voice`) in the `narration_settings` table; jobs read it when they start, so existing audio keeps the voice in its `voice` field. `GET /api/v1/narration/voices/:voice/preview` (owner) speaks one sample sentence (Korean for a `ko-kr-` voice, English otherwise) once, a paid call of a few seconds, keeps it in `<audio dir>/previews/` and serves it from there (404 for a voice not offered, 502 `narration_preview_failed`).

Settings › Automatic audio: `GET /api/v1/narration/auto` (owner) answers `{ digests, records, scope }` and `PUT /api/v1/narration/auto` (owner, CSRF; 400 `invalid_input`) saves it in the `narration_auto` table; agents 403. `digests` (`off` | `parts` | `all`, default `NARRATION_DIGEST_AUTO`, `off`): after an upload changes sections, each changed part (`parts`: articles and/or messages) or the whole digest (`all`) is requested as `read`, in the background, by the uploading agent; the upload answers first. `records` (`off` | `read` | `podcast`, default `NARRATION_RECORD_AUTO`, `read`): a new research, work-report, note or social record (REST, MCP or capture) is requested in that style; while it is on, the daily limit is at least 30. `scope` (`full` | `summary`, default full): what a record's audio reads; `summary` sends only the title, conclusion, summary and next actions (no body), its script is kept apart, and audio made under the other scope is made again on the next request. Digests are always read whole. Automatic requests use the same queue (one job at a time), limits and failure state as Listen, skip unchanged audio, log a refusal by its code only, and a part that changes while its job runs is requested again when that job ends.

`NARRATION_TTS_PROVIDER=vertex` with `NARRATION_VERTEX_PROJECT` (and `NARRATION_VERTEX_LOCATION`, default `global`) sends speech, and the script's first route, to Vertex AI `generateContent` (`aiplatform.googleapis.com`, style and speaker in `parts[].speechMetadata`) with an access token from Application Default Credentials (`authorized_user`, `GOOGLE_APPLICATION_CREDENTIALS` or `~/.config/gcloud/application_default_credentials.json`). Narration is available only when both the key and that file exist; speech never falls back to the key. Its failures add `vertex_auth` (401, or a 403 other than the next; also a missing, unreadable or refused login), `vertex_disabled` (403 ErrorInfo `SERVICE_DISABLED` or `BILLING_DISABLED`) and `vertex_quota` (429, retried). Tokens and the credentials file never reach errors or logs.

### Push (when `PUSH` is on)

| Route | Who | Result |
|---|---|---|
| `GET /api/v1/push` | owner | `{ publicKey, device, devices }` |
| `PUT /api/v1/push/subscription` | owner | `{ subscription, kinds? }`; kinds are `digest`, `review`, `reply`; `subscription.locale` (`en` or `ko`) sets this device's notification language, `LOCALE` otherwise |
| `DELETE /api/v1/push/subscription` | owner | `{ endpoint }` |
| `POST /api/v1/push/test` | owner | send a test notification |

### Incremental record synchronization

`GET /api/v1/records/changes` returns the account's current cursor without rows.
With `after=<cursor>`, it returns at most 50 journal entries as
`{ cursor, items, deletedIds, hasMore, reset }`. Mutations and their journal entries
commit together. A pruned or future cursor requires a fresh snapshot (`reset:
true`); maintenance retains the latest 5000 changes per account. It never reads
another account's changes.

Push subscriptions accept an optional `hideContent` flag, defaulting to false.
When enabled for a device, notifications contain a generic title and body without
record text or identifiers; other devices retain their own setting.

### Capture

`POST /api/v1/capture` saves a link as a `social` record. It only works for the owner signed in through the trusted proxy, with the header `X-Capture: v1`.

In Google mode capture instead requires an agent bearer with `capture` enabled and `X-Capture: shortcut-v1` (legacy `X-Floweredao-Capture: shortcut-v1` is accepted). The token selects the tenant and saved attribution. A session cookie or trusted header cannot substitute. Local trusted-owner capture continues to accept `X-Capture: v1`.

## Other listeners

OIDC uses the canonical sign-in limiter, including its per-/64, per-/48 and global
start budgets. A separate non-OIDC limiter allows 60 public share requests and
20 owner-key session POSTs per minute; it never handles `/auth/*` or authenticated
session GETs. Both reuse `authClientKey`, selecting the configured trusted hop from
the right and otherwise using the socket address, with IPv6 normalized to /64.
Full maps evict the oldest bucket instead of rejecting new clients.
Authenticated API session buckets are
keyed by account; one account cannot exhaust another account's allowance. Every
rate rejection includes `Retry-After`. The request body caps are unchanged.

### Background operations

Without `TASKS_QUEUE`, narration and title enrichment use the local in-process
queues. With `TASKS_QUEUE` and `TASKS_SERVICE_ACCOUNT`, they enqueue account-bound
HTTP tasks at `${APP_ORIGIN}/internal/tasks/narration` or `/ai-fill`. The queue
request includes an OIDC token with audience `APP_ORIGIN`. Internal routes require
a verified Google RSA signature, issuer, audience, expiry and verified service-account
email; browser sessions and unsigned calls are not sufficient. Fifteen-minute
database leases prevent duplicate work across instances. Narration checks account
liveness and its lease before provider calls and writes. Failed enqueue attempts
leave queued state recoverable on restart; Tasks retries failures. Push delivery is
awaited before the task response.

`POST /internal/tasks/maintenance` uses the same service-account authentication.
Its durable lease is global operator state, not a local-account row; hosted
maintenance skips the legacy local account using the same boundary as requests.
It purges expired trash for all accounts, prunes narration runs older than 31 days,
retries deleted accounts' audio-prefix removal, and writes a gzip NDJSON snapshot of
every table as `backups/YYYY-MM-DD.ndjson.gz` in `AUDIO_BUCKET` (or the local
database's `backups/` directory). Backups expire after 14 days; bucket lifecycle
configuration should enforce this independently of the daily maintenance request.
With Turso platform credentials, usage is compared to the current subscription's
published quotas, not hardcoded free-tier numbers; greater than 70% alerts the operator.

`OWNER_ALERT_EMAIL` and `APP_SECRETS.resend.apiKey` enable sign-up, capacity,
maintenance-failure and usage alerts through Resend, from `onboarding@resend.dev`.
Only the configured operator can receive them, with a durable one-per-kind/day
claim and provider idempotency key; an uncertain send is not retried that day.
Alerts contain no account identity, saved content or credentials. No mail goes to users.

`bun scripts/restore.ts --from backup.ndjson.gz --database-url <empty database>`
is an offline operator command, not a public API. It refuses a populated target,
restores only installed schema tables/columns, and preserves target tombstones,
skipping their historical tenant data. Backups contain secrets and must remain
private; they differ from the credential-free user export.

- **Agent ingress** (`ENABLE_AGENT_INGRESS`, `127.0.0.1:AGENT_PORT`): only `POST /api/v1/records` and `GET /api/v1/records/:id` with an agent key.
- **MCP** (`ENABLE_MCP`, `http://127.0.0.1:MCP_PORT/mcp`): tools `save_record`, `update_record`, `get_record` and `search_records`. Every call, including discovery and notifications, now requires an agent bearer; there is no `MCP_AGENT` authority fallback. Calls use the token's account/principal and a per-token rate bucket. Browser Origins are rejected.

Google mode exposes bearer MCP at `/mcp` on the main listener and never starts the separate agent/MCP listeners. `scripts/mcp-forward.ts --listen 127.0.0.1:4313 --to https://example.test/mcp --token-file <private-path>` supports a loopback tunnel. It adds its configured bearer, strips browser credentials, rejects browser Origins and foreign Hosts, and never logs tokens. This transport proof does not claim a hosted ChatGPT OAuth connector.

## Personal Gemini credentials

Model-list validation sends the credential in `x-goog-api-key`, never in the request URL.

Google mode exposes owner-session `GET /api/v1/settings/gemini` returning `{ configured, last4 }`, CSRF-protected `PUT { key }`, and `DELETE` (204). PUT accepts a key only after Google's model-list endpoint returns 200; rejected keys produce `422 gemini_key_invalid` without replacing storage. Acceptance is not a speech-model or quota guarantee. The API never returns the full key.

PUT also returns `modelAvailability.script` and `.speech`, each `{ name, listed }` for the configured models. The browser config exposes their names as `narrationModels`. This reports model-list visibility, not a paid generation test. On a later visit the UI explicitly marks visibility as not checked rather than persisting a stale access guarantee. Actual job failures distinguish rejected credentials, model permission, missing models, quota and operator-managed Vertex setup.

Keys are stored only as AES-256-GCM envelopes `v<version>.<iv>.<ciphertext-with-tag>` in the existing `users.gemini_key_ct` and `gemini_key_kek` columns. A 12-byte random IV and `${userId}:gemini` additional authenticated data prevent moving ciphertext between accounts. `APP_SECRETS.kek` holds versioned 32-byte base64 encryption keys. `bun scripts/rotate-kek.ts` re-encrypts all stored keys transactionally using the highest configured version; keep old versions configured until rotation completes.

Each tenant's narration and Gemini title-fill runner resolves its personal key at call time. A new narration without one returns `409 gemini_key_required`; existing reading and saving remain available. Hosted automatic audio defaults off. Title fill uses `AI_FILL_MODEL` (default `gemini-3.5-flash-lite`) and skips users without keys. Local installs retain `GEMINI_API_KEY` and optional `AI_FILL_COMMAND`.

## Configuration

`server/config.ts` parses environment variables once. `AUTH_MODE=local` is the default; `google` requires `APP_ORIGIN` and `APP_SECRETS` with `google.clientId/clientSecret`, `sessionSigningKey` and `kek`. Hosted push also requires `vapid.publicKey/privateKey` in that JSON and never writes a VAPID file. Local file-backed VAPID behavior is unchanged.

`APP_SECRETS` also accepts optional `turso.authToken/platformToken/org` and `resend.apiKey`; `DATABASE_AUTH_TOKEN` overrides `turso.authToken`. Configuration accepts `OWNER_ALERT_EMAIL`, `CONTACT_EMAIL`, `MAX_USERS`, `AUDIO_BUCKET`, `TASKS_QUEUE` and `TASKS_SERVICE_ACCOUNT` for the hosted operations layer. Notification click paths and manifest start/scope remain same-origin relative paths. OAuth redirects, share links, VAPID subject and allowed browser origins derive from `APP_ORIGIN`; loopback development origins are local-mode only. An `AUDIO_BUCKET` enables `https://storage.googleapis.com` in media CSP.

The container listens on `0.0.0.0:8080` and includes the digest-pinned static ffmpeg 7.1 image's encoder. Encoding chooses ffmpeg first, macOS afconvert second, and preserves WAV if neither encoder is available.

## Hosted deployment tools

`scripts/bootstrap-gcp.sh`, `scripts/set-secret.ts` and `scripts/deploy-cloud-run.sh`
require a private dotenv configuration via `--env-file` and refuse execution
without `--yes`. `--dry-run` renders commands without invoking GCP/Turso or
materializing secrets. Secret JSON travels through captured stdout and upload
stdin, never command arguments or logs. Runtime IAM is scoped to the named
secret, audio bucket, task queue and service account. See
[deployment tooling](docs/deploy.md#hosted-google-sign-in-deployment-tooling)
for prerequisites, sequencing, retention and the limits of dry-run validation.

## Demo mode

With `DEMO=on` the server is a public read-only showcase (see [docs/demo.md](docs/demo.md)):

- A browser request without `Authorization` reads as the owner, with no cookie or session. `GET /api/v1/auth/session` answers the owner principal and the CSRF token `demo`.
- Every request other than `GET` or `HEAD` answers `403 demo_read_only`, on every listener and whatever credentials it carries.
- Push and narration are off. Demo mode refuses to start together with `TRUSTED_USER_HEADER`, `ENABLE_MCP`, `ENABLE_AGENT_INGRESS` or `AI_FILL_COMMAND`.

## Limits and checks

- 300 requests per minute per credential; unknown credentials share one bucket. Over the limit: `429 rate_limited` with `Retry-After: 60`.
- Requests must carry an allowed `Host` (else `421 invalid_host`) and, when present, an allowed `Origin` (else `403 origin`).
- JSON bodies only (`415 unsupported_media_type`), size-capped (`413 too_large`).
- Every response sets a strict Content-Security-Policy (scripts from the app only; images and media also from `data:` and `blob:`), `X-Frame-Options: DENY` and `nosniff`. Existing content-hashed static files under `/assets/` use `Cache-Control: public, max-age=31536000, immutable`; HTML, API data, stable filenames and missing-file fallbacks stay `no-store`.

## Time

Calendar days (Today, digests, the daily narration limit) use `TIME_ZONE`, which defaults to the host's zone. Weeks start on Monday.

### Operational narration behavior

The server runs `NARRATION_CONCURRENCY` jobs concurrently (1–4, default 2); the library default remains 1. A record never has two running jobs. Progress, waits and cancellation belong to each job independently. Content edits through REST or MCP regenerate automatic audio in its last requested style; tags, stars, links and status alone do not. New records with configured AI title fill wait for it to settle before narration. Refused automatic record requests (daily limit, queue full or missing key) and failed jobs with attempts remaining are retried every 30 minutes, unless record automation is off. This deferred list is in memory and does not survive restart.

Digest scripts finish each section in source order before starting the next, with no cross-section top-stories segment. Message action fields remain accepted and searchable but are neither displayed nor included in narration input. Record scripts omit closing link-label lists, work-log sections, lane tags and citation/grade markers. Listening prompts preserve facts, conditions, comparisons, uncertainty and source questions without adding advice. Script rules 7 affect new scripts, not the stale status of existing audio. Encoding uses ffmpeg from PATH, otherwise macOS afconvert; without a working encoder it keeps WAV.

The generated [storage schema](docs/schema/agentic-dashboard.schema.json) exports API and briefing-folder boundaries; [storage.md](docs/storage.md) describes the runtime files and tables.
