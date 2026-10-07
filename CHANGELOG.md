# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Until 1.0.0, the agent API and the database format can still change between minor versions.

## [Unreleased]

### Added

- Narration voices in Settings: pick the read-aloud voice and the two podcast hosts (Male | Female, then a voice from the 117 Korean voices of the Gemini TTS library, with a Listen sample made once per voice), and edit both speaking styles. The choice is saved on the server and used from the next audio; audio already made keeps its voice. New routes `GET`/`PUT /api/v1/narration/voices` and `GET /api/v1/narration/voices/:voice/preview`; on first start the server adds a `narration_settings` table.
- Speech through Vertex AI: with `NARRATION_TTS_PROVIDER=vertex` and `NARRATION_VERTEX_PROJECT`, Listen audio is made by Gemini TTS on Vertex AI (`global`), signed in with Application Default Credentials and billed to the Google Cloud project; the script still uses the Gemini API key. Expired logins, switched-off billing or API, and the Vertex quota fail as `vertex_auth`, `vertex_disabled` and `vertex_quota` with a message saying what to do. The default stays the Gemini API key.
- Favorites in the inbox: a Favorites chip (`#/inbox?state=starred`) lists the starred records, with its count and an empty-state hint.

### Changed

- The star is named Favorite everywhere: the reader toggle (Add to favorites / Remove from favorites), its toasts, the row mark and the Library chip.

### Fixed

- A disabled primary button keeps its dimmed look on touch screens, where a tapped button kept its hover style and looked enabled.
- A narration failure closed with x stays closed when a retry fails again for the same reason on the same audio.
- When audio already exists, a failed remake keeps the player and shows a small status line with Retry and x instead of the alert that hid the audio.

## [0.2.0] - 2026-10-07

Full HTML documents on records, full-screen reading and whole-body narration. On first start the server adds a `documents` table to the database; back up the data folder before you upgrade.

### Added

- Full document: an agent can attach an HTML page to a research, work-report, note or social record (`PUT /api/v1/records/:id/document`, `bun run agent --html page.html`). The reader opens the record on it in a sandboxed, script-free frame, with a [Full document | Summary] switch; `data:` images and audio load and play, `#section` links stay in the document, and on iOS a swipe on it scrolls the page.
- Full screen reading: an icon button shows a record's reading content alone; Close or Escape returns.
- Korean audio reads numbers by their unit (5곳 다섯 곳, 6월 유월); the saved script keeps the digits.

### Changed

- Record bodies may hold up to 120,000 characters, so a full research text fits.
- Listen covers a record's whole body: code, tables, link-only lines and source sections are left out, the rest is scripted part by part, and a part script that summarizes instead of telling is written again. Scripts saved under earlier rules are rewritten.
- A digest script tells every sentence of each article summary (up to 10,000 characters), and a Korean one that drops a number is written again.
- The narration bar moves only on reported progress (streamed script characters, finished chunks, saving), says why a job waits, and shows a step's elapsed time.
- A Korean script written almost all in 해요체 or in 습니다체 is written again with both tones.
- The digest section bar stays one row: section tabs with count badges scroll sideways, and Titles only is an icon toggle.

### Fixed

- A 429 that asks to wait an hour or more counts as the day's quota instead of a per-minute limit.

## [0.1.0] - 2026-10-03

The first public release.

### Added

- Inbox and reader for agent records (research, work reports, notes, links and social posts), newest first, unread until opened. Confirm, star, set a revisit date, archive, or delete to a 30-day trash. Search covers titles, bodies, summaries and tags.
- One record format for every agent, checked on each save, with a list of what to fix when a record is incomplete.
- Agent registry (`bun run agents`) with one hashed key per agent, and an agent client (`bun run agent`) that can wait for the owner's reply.
- Tasks with a timeline: agents post progress and ask for review, the owner comments, agents answer.
- Digests: news, mail or alert round-ups by date and time slot, read as one list with a sticky section bar and a titles-only view.
- Channels: one channel per agent with counts, latest activity and when its key was last used or removed.
- Share links: a read-only link and code per record, readable as Markdown or JSON.
- Optional narration: Read aloud or a two-host Podcast through a text-to-speech provider (Gemini example), with a progress bar, retries with backoff and per-audio delete.
- Optional Web Push for new digests, review requests and replies, sent in each device's language.
- Optional loopback MCP endpoint for chat apps to save and search records.
- Optional sign-in through a trusted reverse proxy header.
- English and Korean UI that follows the system language, a per-device language choice in Settings, and a translation checker (`bun scripts/i18n-check.ts`).
- Mobile-first layout with light and dark themes, installable as a home-screen web app, and a sidebar that can be hidden at any width.
- Single-binary build (`bun run build:binary`), a `Dockerfile`, demo seed data (`bun run seed`) and a read-only demo mode (`DEMO=on`) with a free-tier Cloud Run deploy script.
- The version in `package.json` is reported by `GET /api/v1/config`, shown at the bottom of Settings and in the demo badge.

### Changed

- Digests replace the earlier fixed briefings, so any agent can post any kind of round-up.
- English is the default language; Korean text lives in per-component dictionaries.
- The narration player starts at 1x and keeps the rate the listener picks.

### Fixed

- A busy or rate-limited speech provider is retried with backoff and a lighter script model, and each failure is named.
- Korean narration scripts stay in polite speech.
- A closed narration error stays closed on that device until the next failure.
- Escape closes a dialog without the macOS alert sound.
- The app name keeps its full width beside the sidebar's hide button.

[Unreleased]: https://github.com/floweredao/agentic-dashboard/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/floweredao/agentic-dashboard/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/floweredao/agentic-dashboard/releases/tag/v0.1.0
