# Storage structure

Every installation uses the same record and digest boundaries. The
[machine-readable schema](schema/agentic-dashboard.schema.json) comes from
`shared/contracts.ts` and the briefing-folder converter. Run
`bun scripts/schema.ts` to regenerate it or `bun scripts/schema.ts --check` to
check it. The API and permissions are specified in [CONTRACT.md](../CONTRACT.md).

## Files

| Default path | Configuration | Contents |
|---|---|---|
| `data/dashboard.sqlite` | `DATA_DIR`, `DATABASE_PATH` | Records, trash, comments, documents, digests, narration state, agents and sessions |
| `data/credentials.json` | `CREDENTIALS_PATH` | Owner key and initial credentials, readable only by the owner |
| `data/audio/` | `AUDIO_DIR` | Record and digest audio; AAC/M4A when an encoder is available, otherwise WAV |
| `data/audio/previews/` | Under `AUDIO_DIR` | Cached voice previews |
| `data/vapid.json` | `VAPID_PATH` | Private Web Push keys |

The guided CLI keeps server configuration, connected-agent metadata and logs
under `AGENTIC_DASHBOARD_HOME` (default `~/.agentic-dashboard`), with its data under
`data/` there. Agent credentials use the system keychain or a private key file.
These locations are runtime data, not files to commit.

Back up SQLite through its backup API, or stop the server and copy the whole data
folder. Include credentials, VAPID keys and audio. Copying only a live SQLite file
without its WAL can miss writes. Restoring without audio keeps scripts and job
metadata but does not restore playable audio.

## Records

`records` stores the JSON record plus relationship and attribution columns. Kinds
are project, task, research, work-report, note and social. Research and work-report
agent saves require a full Markdown body, a conclusion, a short summary and
`- ` next-action lines. Titles use display width; tags and links follow the same
contract on every installation. `fields.previousId` links a continuation.

HTML documents live in `documents`, separate from the searchable Markdown body.
Other tables hold trash, task evidence, comments, shares, idempotency requests,
principals, sessions, invitations and push subscriptions.

## Digests

Digests are not records. `digests` keeps one row per date and slot, with ordered,
named article or message sections. Uploads replace only supplied section keys.
`digest_reactions` keeps Like, Not for me and Seen it per article, including its
title and URL at reaction time.

`--briefing` converts `news.json`, `mail.json` and `x.json` folders into this public
format. AI editions carry AI/development and social articles in their scheduled
`HH:MM` slot. Null shortfalls mean no shortfall. Section order and uploaded item
order are preserved; message items are displayed by importance.

## Narration

`narrations` keeps status, source hash, style, scope, script, progress, attempts and
audio metadata per record or digest part. `narration_runs` records daily usage;
`narration_settings` keeps voices and `narration_auto` keeps automatic-generation
choices. Audio bytes are files rather than database blobs.

New narratable records get automatic audio, and edits to title, body, summary,
conclusion or next actions regenerate it. Tags, stars and status do not.
Temporary refusals and retryable automatic failures are retried every 30 minutes;
that deferred list is in memory and is lost on restart. Turning record audio off
prevents those retries. Digest automation remains independently configurable.

Record scripts omit tables, code, references, work-log sections and citation
markers before generation. They explain the complete document for listening,
preserving facts, uncertainty and conditions. Existing audio is not made stale
solely because script-writing rules change.

## Tenant storage and upgrades

`server/schema.ts` inventories all 17 tenant tables. Each row has `user_id`; composite keys prevent principal names, request IDs, digest slots or narration settings from colliding across accounts. Only named capability lookups and the global narration count use `ControlDb`. Per-account queries use `TenantDb`, which binds the account identity.

`server/migrations.ts` applies ordered, transactional versions recorded in `schema_migrations`. Pre-tenant files are rebuilt with every existing row assigned to `local`; documents, reactions, automation settings and saved audio metadata are preserved. `users` holds account metadata. The API continues to omit internal tenant columns.

Local audio paths remain unchanged for the implicit owner. Other accounts use separate hashed directories below `audio/users/`; one account cannot prune another account's files. SQL statements are asynchronous on both backends. Transaction serialization includes unrelated reads and writes, so an await cannot accidentally admit another request into a transaction.

Tests exercise libSQL against an isolated local `file:` database without a hosted account. Set `LIBSQL_TEST_URL` only to a disposable local libSQL server to additionally exercise that transport.
