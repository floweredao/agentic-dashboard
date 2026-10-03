# Contributing

Thanks for helping. Bug reports, fixes, translations and new deploy recipes are all welcome.

## Set up

```sh
bun install
bun run setup        # builds the web app and creates data/credentials.json
bun run dev          # Vite dev server on 127.0.0.1:4311 (proxies the API)
bun start            # the API and built app on 127.0.0.1:4310
```

Use a throwaway data folder while you work, for example `DATA_DIR=dev-data bun start`, and `DATA_DIR=dev-data bun run seed` for demo content.

## Layout

| Path | What lives there |
|---|---|
| `server/` | Bun + Hono API, SQLite store, auth, push, digests, narration, MCP |
| `shared/` | zod contracts (`contracts.ts`) and time helpers used by both sides |
| `src/` | React 19 web app (views, components, styles) |
| `scripts/` | setup, agent CLI, agent key management, seed, binary build |
| `tests/`, `src/**/*.test.ts(x)` | `bun test` suites |

## Before you open a pull request

All four must pass:

```sh
bun test
bun run typecheck
bun run build
bun scripts/i18n-check.ts
```

- Read [CONTRACT.md](CONTRACT.md) before you change an API, a shape or a limit, and update it in the same change.
- Read [DESIGN.md](DESIGN.md) before you change the UI, and keep it in sync.
- Add or adjust tests next to the code you change. Tests use their own temporary databases; never point them at real data.
- Put every UI string in the component's `strings({ en, ko })` dictionary from `src/i18n.ts`. English is the default; the checker fails on a missing translation or Korean text outside a `ko` dictionary.
- Keep commits small, with messages like `fix: keep the reader scroll position on back`.

## Reporting security issues

Please don't file a public issue for a vulnerability. Open a private security advisory on the repository instead. See [docs/security.md](docs/security.md) for the threat model.
