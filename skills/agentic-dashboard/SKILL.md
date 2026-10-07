---
name: agentic-dashboard
description: Save research, work reports, notes, links and task progress to a self-hosted Agentic Dashboard through its CLI or HTTP API. Use when the user asks to save, file, record or report results to the dashboard, or to read and answer comments on a dashboard task.
---

# Agentic Dashboard

The user runs an Agentic Dashboard. You save results there with your own agent key, and the user reviews them.

## Setup

<!-- connection: filled in when this skill is installed on a connected computer -->

On a computer connected with `agentic-dashboard connect`, `agentic-dashboard agent` reads the dashboard address and your key from that computer's own store (the system keychain or a file only the user can read). You need nothing else.

Otherwise you need two values, usually from the environment:

- `DASHBOARD_URL`: the dashboard address, default `http://127.0.0.1:4310`.
- `DASHBOARD_TOKEN`: your agent key. The user creates it on the dashboard host with `agentic-dashboard agents add <your-name>` (or `bun run agents add <your-name>` in the repository).

If a command answers `401` or says no key is set, ask the user to run `agentic-dashboard connect`. Never print the key, log it or write it into files.

## Pick the record kind

| Kind | Use it for | Required |
|---|---|---|
| `research` | investigations, comparisons, findings | `body`, `fields.summary`, `fields.conclusion`, `fields.nextActions` |
| `work-report` | what you did in a work session | same as research |
| `note` | short facts or reminders | `body` |
| `social` | a link worth keeping | one link, `fields.summary` |
| `task` | a work item | title, optional `fields.today`, `fields.evidenceIds` |

## Format rules

The server refuses other shapes with `400 record_incomplete` and lists each problem. Fix every listed item and resend.

- `title`: subject and key point, at most 40 columns (CJK characters and emoji count 2). No dates.
- `tags`: 1 to 5 single words from the content, no `#`, spaces or commas.
- `links`: every source URL, each with a `label` naming the site or document.
- `fields.summary`: 1 to 3 lines, at most 500 characters.
- `fields.conclusion`: one line.
- `fields.nextActions`: one action per line, each starting with `- `. Write `- None` when there's nothing.
- Only the fields listed for the kind. No `status` except on tasks and projects.
- Continuing an earlier record? Set `fields.previousId` to its id.
- Write facts plainly in the user's language. No greetings, persona or emoji. Never invent conclusions or links.

## Save with the CLI

Write the record (the `record` object of the example below) to a JSON file, then:

```sh
agentic-dashboard agent --file record.json --request-id <kind>-<yyyy-mm-dd>-<slug> [--html page.html]
```

Inside a clone of the dashboard repository, `bun run agent` takes the same options.

Write the full findings in `body`, not a summary. If you made an HTML page of the research, attach it with `--html`; the reader shows it as the record's full document (no scripts run; inline CSS and `data:` images and audio work; at most 1 MiB). `agentic-dashboard agent --update <record-id> --html page.html` replaces it.

Find earlier records with `agentic-dashboard agent --search "words"` and read one with `agentic-dashboard agent --get <record-id>`.

## Save with HTTP (with DASHBOARD_TOKEN)

```sh
curl -sS -X POST "${DASHBOARD_URL:-http://127.0.0.1:4310}/api/v1/records" \
  -H "Authorization: Bearer $DASHBOARD_TOKEN" \
  -H "Content-Type: application/json" \
  -d @payload.json
```

`payload.json`:

```json
{
  "requestId": "research-2026-10-02-sqlite-wal",
  "record": {
    "kind": "research",
    "title": "SQLite WAL mode for small servers",
    "body": "Full findings in Markdown.",
    "tags": ["sqlite", "databases"],
    "links": [{ "label": "SQLite documentation", "url": "https://sqlite.org/wal.html" }],
    "fields": {
      "summary": "WAL removes most reader and writer blocking for a single-host app.",
      "conclusion": "Turn WAL on and keep the database on local disk.",
      "nextActions": "- Enable WAL in the store"
    }
  }
}
```

`201` means saved, `200` with `"replayed": true` means this `requestId` was already saved (safe to retry). `409 idempotency_conflict` means you reused a `requestId` for different content; pick a new one. `401` means the key is wrong or revoked.

## Tasks and comments

- Report progress: `agentic-dashboard agent --report <task-id> --text "What happened" --status review`
- Read the user's new comments: `agentic-dashboard agent --comments`
- Answer one: `agentic-dashboard agent --reply <comment-id> --text "Answer" --resolve`

Over HTTP these are `POST /api/v1/comments` and `GET /api/v1/comments?state=new`.

## After saving

Tell the user the record's title and id from the response. Don't paste the whole record back.
