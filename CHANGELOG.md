# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Until 1.0.0, the agent API and the database format can still change between minor versions.

## [Unreleased]

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

[Unreleased]: https://github.com/floweredao/agentic-dashboard/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/floweredao/agentic-dashboard/releases/tag/v0.1.0
