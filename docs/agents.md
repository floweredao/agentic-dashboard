# Agent integration guide

Any program that can make an HTTP request can save results to the dashboard: Codex, Claude Code, another CLI agent, a cron job or a chat app over MCP. Each agent gets its own key, and every record it writes is tagged with its name.

## 1. Register the agent

On the machine that runs the dashboard:

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
bun run agent --file record.json --request-id research-2026-10-02-sqlite-wal
```

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
| `--update <record-id> --expected-version <n> --file changes.json` | Patch one of your records |
| `--search "words" [--kind ...] [--limit 1-50] [--cursor ...]` | Search records you may read |
| `--shared <code or share-url>` | Read a record the owner shared |
| `--new-task "Title" --tags a,b [--text ...] [--status ...]` | Create a task |
| `--report <task-id> --text "..." [--status review]` | Post progress on a task |
| `--comments [--state new\|open\|all] [--wait]` | Read (or wait for) owner comments |
| `--reply <comment-id> --text "..." [--resolve]` | Answer an owner comment |
| `--seen <comment-id>`, `--done <comment-id>` | Mark a comment seen or handled |
| `--timeline <task-id>` | Show a task's timeline |
| `--narrate <record-id> [--wait]`, `--narration <record-id>` | Request or check Listen audio |
| `--digest digest.json [--quiet]`, `--digests [--from] [--to]` | Upload or list digests |

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
- `summary`: at most 3 lines and 500 characters. `conclusion`: one line. `nextActions`: one action per line starting with `- `.
- Set `status` only on tasks and projects.
- When a record continues an earlier one, set `fields.previousId` to that record's id.
- Write facts plainly, in the user's language. Don't invent conclusions or links.

`GET /api/v1/schema` returns the machine-readable rules under `agentRecord` and the full JSON Schema under `input`.

## 4. What an agent can read and change

An agent reads its own records, unarchived research, work reports, notes and links from anyone, and the owner's unarchived tasks and projects. It can PATCH only records it created and can't delete anything. See [CONTRACT.md](../CONTRACT.md) for the details.

## 5. Tasks and comments

Tasks are shared work items. Post progress with `--report <task-id>`; set `--status review` when the owner should look. The owner's comments queue up for you: `bun run agent --comments` fetches new ones (and marks them seen), `--comments --wait` blocks until one arrives, and `--reply <comment-id> --text "..." --resolve` answers and marks it handled.

## 6. Digests

When `DIGEST` is on, an agent can upload a news and mail digest for a date and slot:

```sh
bun run agent --digest digest.json
```

The file is the `POST /api/v1/digests` body: `date`, `slot` (`morning`, `evening` or `HH:MM`), and 1 to 12 `sections`, each of kind `articles` or `messages`. Uploading again with the same date and slot replaces matching sections and keeps the others. Set `"notify": false` for quiet backfills.

## 7. MCP for chat apps

Set `ENABLE_MCP=on` and `MCP_AGENT=<registered agent>` to open an MCP endpoint at `http://127.0.0.1:4313/mcp` (`MCP_PORT`). It offers `save_record`, `update_record`, `get_record` and `search_records`, and every call is saved as `MCP_AGENT`. It listens on loopback only; put your own authenticated tunnel in front of it if a remote app needs it.

## 8. Agents on other machines

Agents reach the dashboard through the same HTTPS address you use (see [deploy.md](deploy.md)). If you want agents to reach only the record endpoints, turn on `ENABLE_AGENT_INGRESS`: a second loopback listener on `AGENT_PORT` (4312) that accepts only `POST /api/v1/records` and `GET /api/v1/records/:id`. Proxy that port instead of the main one, and set `PUBLIC_API_BASE_URL` to its public address.

## Skill file

Agents that load skills (Codex, Claude Code and others) can install [skills/agentic-dashboard/SKILL.md](../skills/agentic-dashboard/SKILL.md), which teaches them the format and both ways to save.
