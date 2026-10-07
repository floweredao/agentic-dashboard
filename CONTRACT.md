# Contract

This document describes what the server promises: the data model, the HTTP API, who may do what, and the limits. The code is the final word. Shapes and limits live in `shared/contracts.ts`, routes in `server/app.ts`, configuration in `server/index.ts`. Change this file in the same commit as the behavior.

## Principals

| Principal | Source value | How it authenticates |
|---|---|---|
| Owner | `manual` | Signs in with the owner key from `data/credentials.json` (session cookie plus CSRF token), or through a trusted proxy header |
| Agent | its registered name, for example `codex` | `Authorization: Bearer <agent key>` |

Agent names match `^[a-z][a-z0-9-]{0,31}$`; `manual` and `owner` are reserved. Agents are managed with `bun run agents add|list|rotate|remove`. The server stores only a SHA-256 hash of each key.

A one-time connection code (`agentic-dashboard invite <name>` on the host, table `agent_invites`) registers a new agent from another computer: `XXXX-XXXX-XXXX-XXXX` in Crockford base32 (80 random bits, case and dashes ignored), valid for 15 minutes and for one `POST /api/v1/agents/connect`. Only its SHA-256 hash is stored; a new code for the same name replaces the old one, and a name that is already registered gets no code (`409 agent_exists`).

Owner sessions last 7 days. The cookie is `agentic_session`, `HttpOnly`, `SameSite=Strict`, and `Secure` when the origin is HTTPS. Every owner mutation needs the CSRF token from the session response and an allowed `Origin`.

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

All routes are under the private listener (`HOST:PORT`, default `127.0.0.1:4310`). Errors look like `{ "error": { "code": "...", "message": "..." } }`; validation errors add `details`.

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

### Records

| Route | Who | Result |
|---|---|---|
| `GET /api/v1/records` | owner, agent | `{ items, nextCursor }`; query `kind`, `status`, `reviewState`, `archived` (`false`, `true`, `all`), `projectId`, `q`, `dueFrom`, `dueTo`, `limit` (1..50), `cursor` |
| `POST /api/v1/records` | owner, agent | 201 `{ record, replayed: false }` |
| `GET /api/v1/records/:id` | owner, agent | `{ record }` |
| `PATCH /api/v1/records/:id` | owner, agent (own records) | `{ record }` |
| `DELETE /api/v1/records/:id` | owner | body `{ expectedVersion }`; moves the record to the trash, 204 |
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
| `GET /api/v1/digests/:id` | owner, agent | `{ digest }` |
| `POST /api/v1/digests/:id/read` | owner | `{ read, part? }` |

A digest has 1 to 12 sections of kind `articles` or `messages`, each with at most 60 items, and the body is at most 256 KiB. Slots are `morning`, `evening` or `HH:MM`. Sections with an existing key replace it in place; new keys are appended. `notify: false` skips push.

### Narration (when a provider key is set)

| Route | Who | Result |
|---|---|---|
| `GET`, `POST`, `DELETE /api/v1/records/:id/narration` | owner, agent in read scope (DELETE owner only) | state, start (`{ force?, style? }`, 202 when started), remove |
| `POST /api/v1/records/:id/narration/cancel` | owner | stop a running job |
| `GET /api/v1/records/:id/narration/audio` | owner, agent in read scope | audio with byte ranges |
| `/api/v1/digests/:id/narration` and `/cancel`, `/audio` | owner | the same for one digest part (`articles`, `messages`) or the whole digest (`all`) |

Only research, work-report, note and social records can be narrated. Limits: 6000-character scripts (10,000 for a digest, whose script tells every sentence of each article summary and is written once more when a Korean one leaves out a number the summary states), 20 queued jobs, `NARRATION_DAILY_LIMIT` runs per day (default 20) and 3 failed attempts per content version. `style` is `read` (one voice) or `podcast` (two hosts, records only); the state reports the style last chosen, which is the default for the next request. A busy or rate-limited provider is retried with backoff, and the script falls back to `NARRATION_SCRIPT_FALLBACK_MODEL`. Each job reports its stage, `progress` (while scripting the script characters streamed in so far over the expected length; while speaking the chunks done and total) and `stepAt` (when the current step began); a failure names its cause. A record is scripted from its whole body: code, tables, link-only lines and source or reference sections are left out, the rest is split at its headings into parts of at most 5,000 characters, each part is scripted in order (up to 18,000 characters each, else the job fails as `script_too_long`), and a part script under 60% of its source is written once more. Scripts saved under earlier rules are rewritten. A Korean script with plain (반말) endings or written almost all in 해요체 or in 습니다체 is written once more. Korean audio reads each number before a known unit as it is spoken (5곳 다섯 곳, 6월 유월, 4.2% 사 점 이 퍼센트); the saved script keeps the digits.

The owner chooses the voices and speaking styles in Settings › Narration voices. `GET /api/v1/narration/voices` (owner) answers `{ settings, defaults, voices }`: `settings` and `defaults` are `{ readVoice, hostA, hostB, readStyle, podcastStyle }` (`readVoice` reads aloud and reads digests, `hostA`/`hostB` are the podcast hosts and must differ, styles 1-300 characters), and `voices` is the 117 Korean voices of the Gemini TTS voice library (`shared/voices.ts`) plus the configured `NARRATION_VOICE`/`NARRATION_PODCAST_VOICE` it does not name (gender `neutral`). `PUT /api/v1/narration/voices` (owner, CSRF) saves a choice (400 `invalid_input` or `invalid_voice`) in the `narration_settings` table; jobs read it when they start, so existing audio keeps the voice in its `voice` field. `GET /api/v1/narration/voices/:voice/preview` (owner) speaks one sample sentence (Korean for a `ko-kr-` voice, English otherwise) once, a paid call of a few seconds, keeps it in `<audio dir>/previews/` and serves it from there (404 for a voice not offered, 502 `narration_preview_failed`).

Settings › Automatic audio: `GET /api/v1/narration/auto` (owner) answers `{ digests, records, scope }` and `PUT /api/v1/narration/auto` (owner, CSRF; 400 `invalid_input`) saves it in the `narration_auto` table; agents 403. `digests` (`off` | `parts` | `all`, default `NARRATION_DIGEST_AUTO`, `off`): after an upload changes sections, each changed part (`parts`: articles and/or messages) or the whole digest (`all`) is requested as `read`, in the background, by the uploading agent; the upload answers first. `records` (`off` | `read` | `podcast`, default off): a new research or work-report record (REST or MCP create) is requested in that style; while it is on, the daily limit is at least 30. `scope` (`full` | `summary`, default full): what a record's audio reads; `summary` sends only the title, conclusion, summary and next actions (no body), its script is kept apart, and audio made under the other scope is made again on the next request. Digests are always read whole. Automatic requests use the same queue (one job at a time), limits and failure state as Listen, skip unchanged audio, log a refusal by its code only, and a part that changes while its job runs is requested again when that job ends.

`NARRATION_TTS_PROVIDER=vertex` with `NARRATION_VERTEX_PROJECT` (and `NARRATION_VERTEX_LOCATION`, default `global`) sends speech, not the script, to Vertex AI `generateContent` (`aiplatform.googleapis.com`, style and speaker in `parts[].speechMetadata`) with an access token from Application Default Credentials (`authorized_user`, `GOOGLE_APPLICATION_CREDENTIALS` or `~/.config/gcloud/application_default_credentials.json`). Narration is available only when both the key and that file exist; speech never falls back to the key. Its failures add `vertex_auth` (401, or a 403 other than the next; also a missing, unreadable or refused login), `vertex_disabled` (403 ErrorInfo `SERVICE_DISABLED` or `BILLING_DISABLED`) and `vertex_quota` (429, retried). Tokens and the credentials file never reach errors or logs.

### Push (when `PUSH` is on)

| Route | Who | Result |
|---|---|---|
| `GET /api/v1/push` | owner | `{ publicKey, device, devices }` |
| `PUT /api/v1/push/subscription` | owner | `{ subscription, kinds? }`; kinds are `digest`, `review`, `reply`; `subscription.locale` (`en` or `ko`) sets this device's notification language, `LOCALE` otherwise |
| `DELETE /api/v1/push/subscription` | owner | `{ endpoint }` |
| `POST /api/v1/push/test` | owner | send a test notification |

### Capture

`POST /api/v1/capture` saves a link as a `social` record. It only works for the owner signed in through the trusted proxy, with the header `X-Capture: v1`.

## Other listeners

- **Agent ingress** (`ENABLE_AGENT_INGRESS`, `127.0.0.1:AGENT_PORT`): only `POST /api/v1/records` and `GET /api/v1/records/:id` with an agent key.
- **MCP** (`ENABLE_MCP`, `http://127.0.0.1:MCP_PORT/mcp`): tools `save_record`, `update_record`, `get_record` and `search_records`, all attributed to `MCP_AGENT`, which must be an active registered agent.

## Demo mode

With `DEMO=on` the server is a public read-only showcase (see [docs/demo.md](docs/demo.md)):

- A browser request without `Authorization` reads as the owner, with no cookie or session. `GET /api/v1/auth/session` answers the owner principal and the CSRF token `demo`.
- Every request other than `GET` or `HEAD` answers `403 demo_read_only`, on every listener and whatever credentials it carries.
- Push and narration are off. Demo mode refuses to start together with `TRUSTED_USER_HEADER`, `ENABLE_MCP`, `ENABLE_AGENT_INGRESS` or `AI_FILL_COMMAND`.

## Limits and checks

- 300 requests per minute per credential; unknown credentials share one bucket. Over the limit: `429 rate_limited` with `Retry-After: 60`.
- Requests must carry an allowed `Host` (else `421 invalid_host`) and, when present, an allowed `Origin` (else `403 origin`).
- JSON bodies only (`415 unsupported_media_type`), size-capped (`413 too_large`).
- Every response sets a strict Content-Security-Policy (scripts from the app only; images and media also from `data:` and `blob:`), `X-Frame-Options: DENY`, `nosniff` and `Cache-Control: no-store`.

## Time

Calendar days (Today, digests, the daily narration limit) use `TIME_ZONE`, which defaults to the host's zone. Weeks start on Monday.
