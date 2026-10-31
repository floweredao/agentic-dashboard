# Agent integration guide

Any program that can make an HTTP request can save results to the dashboard: Codex, Claude Code, another CLI agent, a cron job or a chat app over MCP. Each agent gets its own key, and every record it writes is tagged with its name.

## 1. Register the agent

### Hosted accounts

Sign in with Google, then open **Agent connections** in setup or Settings. Create a token for each agent, or choose **Connect a computer** to issue a single-use connection code. You do not need shell access to the host. The token selects your account and the agent's attribution; the same agent name in another account grants no access to yours.

Copy a new token immediately: it is shown once and the server stores only its hash. Prefer the supplied installer command for a different computer; it exchanges the code within 15 minutes and stores the credential in the OS keychain or a private file. Never give an agent your browser session, CSRF token or Google credentials. Details and revocation rules are in [Agents on other machines](#8-agents-on-other-machines).

### Local self-hosting

On the machine that runs a local owner-key dashboard:

```sh
bun run agents add codex
```

The key is printed once. Store it where the agent reads it, usually as `DASHBOARD_TOKEN`. Lost it? `bun run agents rotate codex` issues a new one and the old one stops working. `bun run agents remove codex` revokes it; the agent's records stay.

Names use lowercase letters, digits and dashes and start with a letter, for example `codex`, `claude-code` or `research-bot`.

## 2. Save a record

### With the CLI

The CLI in this repository reads the key from `DASHBOARD_TOKEN` (or `--token`) and the server from `DASHBOARD_URL` (or `--url`, default `http://127.0.0.1:4310`).

```sh
export DASHBOARD_TOKEN='<key>'
export DASHBOARD_URL='https://dashboard.example.com' # your hosted origin; omit for local default
bun run agent --file record.json --request-id research-2026-10-02-sqlite-wal
```

Do not put the token in `record.json`, source control or screenshots. A connected installation can use `agentic-dashboard agent --file record.json` without exporting the token. The public CLI takes the source from its bearer; there is no separate `--source` option.

`record.json` holds the record itself:

```json
{
  "kind": "research",
  "title": "SQLite WAL mode for small servers",
  "body": "## Findings\n\nWAL lets readers and one writer work at once...",
  "tags": ["sqlite", "databases"],
  "links": [{ "label": "SQLite documentation", "url": "https://sqlite.org/wal.html" }],
  "fields": {
    "summary": "WAL mode removes most reader and writer blocking for a single-host app.",
    "conclusion": "Turn WAL on and keep the database on local disk.",
    "nextActions": "- Enable WAL in the store\n- Add a backup note to the deploy guide"
  }
}
```

Other CLI commands, from `bun run agent --help`:

| Command | What it does |
|---|---|
| `--get <record-id>` | Read a record |
| `--update <record-id> [--expected-version <n> --file changes.json] [--html page.html]` | Patch one of your records, or attach or replace its full HTML document |
| `--trash <record-id> [--expected-version <n>]` | Move one of your records to the owner's trash, where the owner can restore it for 30 days (someone else's record: 403) |
| `--search "words" [--kind ...] [--limit 1-50] [--cursor ...]` | Search records you may read |
| `--shared <code or share-url>` | Read a record the owner shared |
| `--new-task "Title" --tags a,b [--text ...] [--status ...]` | Create a task |
| `--report <task-id> --text "..." [--status review]` | Post progress on a task |
| `--comments [--state new\|open\|all] [--wait]` | Read (or wait for) owner comments |
| `--reply <comment-id> --text "..." [--resolve]` | Answer an owner comment |
| `--seen <comment-id>`, `--done <comment-id>` | Mark a comment seen or handled |
| `--timeline <task-id>` | Show a task's timeline |
| `--narrate <record-id> [--style read\|podcast] [--force] [--wait]`, `--narration <record-id>` | Request or check Listen audio. `--style read` is one voice, `podcast` two hosts; without it the record's last style is used (read at first). Digests are always read aloud. |
| `--digest digest.json [--quiet]`, `--digests [--from] [--to]` | Upload or list digests |
| `--briefing <dir> [--sections mail,domestic,international] [--quiet]` | Convert a briefing folder and upload it as a digest |
| `--briefing-file digest.json [--sections <names>] [--quiet]` | Upload a public digest body, like `--digest` |
| `--briefings [--from YYYY-MM-DD] [--to YYYY-MM-DD]` | Alias for `--digests` |
| `--digest-reactions [--days 30]`, `--briefing-reactions [--days 30]` | Read recent article reactions (the two flags are aliases) |

### Upload a briefing folder

Use the same connected key or `DASHBOARD_TOKEN` as the other agent commands:

```sh
bun run agent --briefing ./briefing --quiet
bun run agent --briefing ./ai-briefing --sections ai-development,social
bun run agent --briefings --from 2026-10-01 --to 2026-10-02
```

The folder needs `news.json` or `mail.json`. Each has `targetScheduledAt` (an ISO timestamp with an offset). The converter uses its Korean time (UTC+09:00) for the date and slot: `morning` at 08:00, `evening` at 21:00, otherwise `HH:MM`; a news edition of `morning` or `evening` takes precedence.

- `news.json`: `articles.domestic` and `articles.international` are arrays of `{ eventKey, title, url, source?, summary?, originalUrl?, publishedAt?, publishedDate?, imageUrl? }`. Optional `shortfalls` maps section names to a string or `null`. A timestamp takes precedence over a date-only publication value.
- AI editions (`edition: "ai-morning"` or `"ai-evening"`) upload only `articles.aiDevelopment` and, when present, `x.json`. They use the scheduled `HH:MM` slot, since the public API has no AI-named slots. The public section key is `ai-development`; `--sections` also accepts the input name `aiDevelopment`.
- `x.json`: `{ targetScheduledAt, items: [{ key, title, author, summary, url, postedAt? }], shortfall? }`. These become an `articles` section with key `social`; ordinary news editions ignore it.
- `mail.json`: `{ targetScheduledAt, messages: string[] }`. The grouped Markdown uses `**즉시 조치 | 1건**`, `**할 일 | 1건**`, `**확인 | 1건**` or `**참고 | 1건**` headings, `• sender | address | subject` bullets, summary lines, a category-prefixed action line and an optional `[메일에서 열기](https://example.com/mail/1)` link. It becomes a `messages` section with key `mail`. AI editions ignore mail.

Each input may set `locale: "en" | "ko"` (default `en`) and `sectionTitles: { "<section-key>": "<title>" }`; mail and social input may also set `title`. Explicit titles win over localized defaults. News controls the locale when both news and mail are present. The app always displays `social` as Social / 소셜 in its own language.

`--sections` sends only the named sections, preserving other sections already on the server; selecting none of the available sections fails. `--quiet` sets `notify: false`. `--briefing-file` takes an already converted public `POST /api/v1/digests` body, not an individual news or mail file, and supports the same filtering and quiet flag. A successful upload prints the digest id, date, slot, version and section counts.

### With HTTP

```sh
curl -X POST "$DASHBOARD_URL/api/v1/records" \
  -H "Authorization: Bearer $DASHBOARD_TOKEN" \
  -H "Content-Type: application/json" \
  -d @- <<'JSON'
{ "requestId": "note-2026-10-02-release", "record": {
  "kind": "note", "title": "Release checklist",
  "body": "Tag, build, publish, announce.", "tags": ["release"] } }
JSON
```

A new record answers `201 { record, replayed: false }`. Sending the same `requestId` and payload again answers `200` with the same record, so retries are safe. Reusing a `requestId` with a different payload is `409 idempotency_conflict`. Make request ids unique and meaningful, for example `<kind>-<date>-<slug>`.

## 3. Follow the record format

The server rejects agent records that don't match the shared format with `400 record_incomplete` and lists every problem. The short version:

| Kind | Required | Allowed fields |
|---|---|---|
| `research`, `work-report` | `body`, `summary`, `conclusion`, `nextActions` | those plus `previousId` |
| `note` | `body` | `summary`, `previousId` |
| `social` | one link, `summary` | `summary`, `previousId` |
| `task` | | `today`, `evidenceIds` |
| `project` | | `nextAction` |

- Title at most 40 columns wide (CJK characters and emoji count double). Put detail in `summary`.
- 1 to 5 tags, single words, no `#`, spaces or commas.
- Every link gets a label naming the site or document.
- `body` (research, work-report): the full content in Markdown, every section and figure, not a summary (at most 120,000 characters). Listen covers the whole body.
- Full document: if you made an HTML page of the research, attach it with `--html page.html` when saving or updating. The reader shows it in a script-free frame; inline CSS and `data:` images and audio work, external images, fonts and scripts do not load (at most 1 MiB).
- `summary`: at most 3 lines and 500 characters. `conclusion`: one line. `nextActions`: one action per line starting with `- `.
- Set `status` only on tasks and projects.
- When a record continues an earlier one, set `fields.previousId` to that record's id.
- Write facts plainly, in the user's language. Don't invent conclusions or links.

`GET /api/v1/schema` returns the machine-readable rules under `agentRecord` and the full JSON Schema under `input`.

## 4. What an agent can read and change

Within its account, an agent reads its own records, unarchived research, work reports, notes and links from other agents, and the owner's unarchived tasks and projects. It can PATCH or move to trash only records it created; only the owner restores or permanently deletes them. Other accounts' IDs return 404. Agent names are attribution, not private compartments within an account. See [CONTRACT.md](../CONTRACT.md) for the details.

## 5. Tasks and comments

Tasks are shared work items. Post progress with `--report <task-id>`; set `--status review` when the owner should look. The owner's comments queue up for you: `bun run agent --comments` fetches new ones (and marks them seen), `--comments --wait` blocks until one arrives, and `--reply <comment-id> --text "..." --resolve` answers and marks it handled.

## 6. Digests

When `DIGEST` is on, an agent can upload a news and mail digest for a date and slot:

```sh
bun run agent --digest digest.json
```

The file is the `POST /api/v1/digests` body: `date`, `slot` (`morning`, `evening` or `HH:MM`), and 1 to 12 `sections`, each of kind `articles` or `messages`. Uploading again with the same date and slot replaces matching sections and keeps the others. Set `"notify": false` for quiet backfills.

To add posts you picked from a social network, send them as an `articles` section with the key `social`: `source` is the author, `url` the post and `publishedAt` when it was posted. The app shows that section as Social (소셜 in Korean), whatever its `title`; leave it out and the digest has none.

## 7. MCP for chat apps

In Google mode, send an agent bearer to `POST https://<dashboard>/mcp` on the main listener. It offers `save_record`, `update_record`, `get_record` and `search_records`; the bearer selects both the account and saved attribution. Every request requires a bearer, including initialization and notifications. Browser Origins are rejected.

For local mode, `ENABLE_MCP=on` and an active `MCP_AGENT` enable the optional loopback listener at `http://127.0.0.1:4313/mcp`. `MCP_AGENT` no longer grants authority to callers: supply a bearer here too.

A tunnel that needs a loopback target can use:

```sh
bun scripts/mcp-forward.ts --listen 127.0.0.1:4313 \
  --to https://dashboard.example.com/mcp --token-file ~/.agentic-dashboard/agent-key
```

Keep the token file readable only by its owner (`chmod 600`). The forwarder injects the bearer and strips browser credentials. A working bearer transport is not a hosted ChatGPT OAuth connector; ChatGPT remains advanced/unverified.

## 8. Agents on other machines

Agents reach the dashboard through the same HTTPS address you use (see [deploy.md](deploy.md)).

Hosted users open **Agent connections** rather than running commands on the server. Create a token (copy it once), rotate/revoke an existing token, or choose **Connect a computer** for a 15-minute single-use setup code. The supplied installer command includes the dashboard address and supplies Bun and the CLI on macOS/Linux; Windows is untested. The CLI prefers the OS keychain and otherwise uses its private `~/.agentic-dashboard/agent-key` file. The screen also provides a curl credential-file fallback.

Rotate an active token when replacing its credential. Revocation is permanent for that agent name: rotation returns `agent_revoked` instead of reactivating it, and the old name remains reserved for attribution. To reconnect after revocation, create a token under a new name. This rule applies to both the UI/API and the local agents CLI; saved records remain.

Use **Save a test record** to check token write/read permissions. To complete first-login setup, also save from the connected computer's CLI or bearer MCP client: the server requires an external bearer save without a browser Origin. A manual sample or same-origin browser token test does not satisfy that gate.

The quickest way to connect one is a one-time connection code. On the dashboard host run `agentic-dashboard invite <name>` (from the [one-line install](../README.md#quick-start), or `bun cli/main.ts invite <name>` in a clone). It prints a code and the line to run on the agent's computer, `curl -fsSL .../install.sh | sh -s -- connect --url <address> --code <code>`. That installs the command there, trades the code for the agent's key through `POST /api/v1/agents/connect` (once, within 15 minutes), checks the key, stores it in the system keychain or a `0600` file, and installs the skill below for the agent tools it finds. From then on, `agentic-dashboard agent ...` on that computer takes the same options as `bun run agent` without `DASHBOARD_TOKEN`. `agentic-dashboard connect` without a code asks for an agent name and key instead; `agentic-dashboard status` checks the connection without printing the key.

The host-side `invite` command above is for local owner-key installations; hosted users issue their code in Agent connections. In local mode, if you want agents to reach only the record endpoints, turn on `ENABLE_AGENT_INGRESS`: a second loopback listener on `AGENT_PORT` (4312) that accepts only `POST /api/v1/records` and `GET /api/v1/records/:id`. Proxy that port instead of the main one, and set `PUBLIC_API_BASE_URL` to its public address. Google mode uses only the main listener.

## Skill file

Agents that load skills (Codex, Claude Code and others) can install [skills/agentic-dashboard/SKILL.md](../skills/agentic-dashboard/SKILL.md), which teaches them the format and both ways to save. `agentic-dashboard connect` installs it for you with that computer's own command path; `agentic-dashboard skills install [--target claude-code|codex|omo|agents]` writes it again, and never replaces a skill file it didn't write unless you pass `--force`.

## Portable storage and listening

Every install uses the same [storage structure](storage.md) and [generated contracts](schema/agentic-dashboard.schema.json). Keep the full Markdown document in `body`, even when attaching HTML. Automatic audio covers all narratable record kinds and waits for configured title fill. Write conclusions and summaries as findings, not work logs: verification methods, tool details, kept/deleted files and closing reference lists are omitted from listening scripts. Keep relevant study limitations and counterarguments in the content sections. See [install.md](install.md) for machine-independent setup.
