# Instructions for coding agents

This file is for AI coding agents changing this repository. If you want to save results *into* a running dashboard, read [docs/agents.md](docs/agents.md) instead.

## Read first

- [CONTRACT.md](CONTRACT.md) is the source of truth for the data model, routes, permissions and limits. The code behind it is `shared/contracts.ts` (shapes and limits), `server/app.ts` (routes) and `server/index.ts` (every environment variable).
- [DESIGN.md](DESIGN.md) is the visual contract for anything in `src/`.
- Change the contract document in the same commit as the behavior.

## Verify every change

```sh
bun test
bun run typecheck
bun run build
```

All three must exit 0. Don't skip, delete or loosen a failing test to get there.

On a machine that provides a shared `heavy` gate (the maintainer's Mac does), run the three commands through it, for example `heavy bun test`. It limits how many heavy jobs run at once across agent sessions; waiting for a slot is expected.

## Data and secrets

- Use an isolated database for any manual run: `DATA_DIR=$(mktemp -d) bun start`, or `DATABASE_PATH` and `CREDENTIALS_PATH` pointing at a scratch folder. Never touch an existing `data/` folder; it holds someone's real records and keys.
- Tests create their own temporary databases. Keep it that way.
- Never commit `.env`, `data/`, keys, tokens, `credentials.json`, `vapid.json` or audio files. Never print a real key in logs or output.
- Use `example.com` or `example.test` for sample emails and hosts.

## Conventions

- TypeScript strict mode. Parse every external input with zod at the boundary; trust nothing typed by hand.
- Server errors are `ApiError(status, code, message)`; never log request bodies, cookies or credentials.
- UI strings exist in English and Korean.
- Keep diffs small and focused. Don't add dependencies without a clear reason.
- Don't add CI workflows.
