# Contract

This document describes what the server promises: the data model, the HTTP API, who may do what, and the limits. The code is the final word. Shapes and limits live in `shared/contracts.ts`, routes in `server/app.ts`, configuration in `server/index.ts`. Change this file in the same commit as the behavior.

## Principals

| Principal | Source value | How it authenticates |
|---|---|---|
| Owner | `manual` | Signs in with the owner key from `data/credentials.json` (session cookie plus CSRF token), or through a trusted proxy header |
| Agent | its registered name, for example `codex` | `Authorization: Bearer <agent key>` |

Agent names match `^[a-z][a-z0-9-]{0,31}$`; `manual` and `owner` are reserved. Agents are managed with `bun run agents add|list|rotate|remove`. The server stores only a SHA-256 hash of each key.

Owner sessions last 7 days. The cookie is `agentic_session`, `HttpOnly`, `SameSite=Strict`, and `Secure` when the origin is HTTPS. Every owner mutation needs the CSRF token from the session response and an allowed `Origin`.

## Records

Three logical collections share one table: projects (`project`), tasks (`task`) and material (`research`, `work-report`, `note`, `social`).

### RecordInput

```ts
{
  kind: "project" | "task" | "research" | "work-report" | "note" | "social";
  title: string;                 // trimmed, 1..200
  body: string;                  // default "", at most 16000
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
| `GET /api/v1/config` | anyone | `{ appName, timeZone, locale, features: { narration, push, digest, trustedLogin, demo } }` |
| `GET /api/v1/schema` | anyone | kinds, field lists, agent format, JSON Schema of RecordInput, `timeZone` |
| `POST /api/v1/auth/session` | owner | `{ token }` to `{ csrfToken, expiresAt }` plus cookie |
| `GET /api/v1/auth/session` | owner | `{ principal, csrfToken, expiresAt }` |
| `DELETE /api/v1/auth/session` | owner | 204 |
| `GET /api/v1/agents` | owner | `{ items }` registered agents |

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

Only research, work-report, note and social records can be narrated. Limits: 6000-character scripts, 20 queued jobs, `NARRATION_DAILY_LIMIT` runs per day (default 20) and 3 failed attempts per content version. `style` is `read` (one voice) or `podcast` (two hosts, records only); the state reports the style last chosen, which is the default for the next request. A busy or rate-limited provider is retried with backoff, and the script falls back to `NARRATION_SCRIPT_FALLBACK_MODEL`. Each job reports its stage and `progress`; a failure names its cause.

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
- Every response sets a strict Content-Security-Policy, `X-Frame-Options: DENY`, `nosniff` and `Cache-Control: no-store`.

## Time

Calendar days (Today, digests, the daily narration limit) use `TIME_ZONE`, which defaults to the host's zone. Weeks start on Monday.
