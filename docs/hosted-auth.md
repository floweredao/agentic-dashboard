# Hosted account foundation

`AUTH_MODE=local` keeps SQLite, owner-key login, optional trusted proxy login and environment-backed Gemini credentials. `AUTH_MODE=google` enables account sign-in, account-scoped agent tokens, bearer capture/MCP and encrypted personal Gemini keys. It uses only the main listener.

Switching an existing database to Google mode does not publish its local account. Local records, share codes, invitations and credentials stay stored but cannot be used on the hosted origin. A Google subject bound to the local row is refused rather than silently linked. No new anonymous user row is created, and local-account background services are not resumed. Hosted users' explicit share links continue to work. Use local mode to access the old account; any data migration is a separate decision.

This is an application foundation, not a public-service launch. Operator alert delivery, public legal policies, onboarding completion, account export/deletion, hosted storage and operational jobs belong to the remaining hosted-service plan. `OWNER_ALERT_EMAIL`, `CONTACT_EMAIL` and the task/bucket fields are parsed for that layer; capacity has an injectable `onCapacity` hook, not an email sender.

## Operator configuration

Set `APP_ORIGIN` to the exact public HTTPS origin and register `${APP_ORIGIN}/auth/google/callback` with the Google OIDC client. Loopback HTTP is accepted for isolated tests. Never derive origin or cookie security from a client header.

Provide `APP_SECRETS` as private JSON, with:

- `google.clientId` and `google.clientSecret`;
- `sessionSigningKey`, an independent random secret of at least 32 characters;
- `kek`, a version-number-to-base64 map of 32-byte AES keys, for example version `1`;
- `vapid.publicKey` and `vapid.privateKey` when push is enabled;
- optional `turso.authToken/platformToken/org` and `resend.apiKey` for the hosted operations layer.

Keep the JSON out of source, logs, screenshots and shell history. `DATABASE_AUTH_TOKEN` takes precedence over the Turso token in that JSON. `MAX_USERS` defaults to 50 active hosted accounts; existing accounts can still sign in at capacity.

To rotate encryption keys, add a higher-numbered KEK while keeping the old versions, then run `bun scripts/rotate-kek.ts` with the same database configuration. It re-encrypts all key rows in one transaction. Remove old versions only after success and according to your backup-restoration policy.

Personal keys are managed in Settings. Model-list validation says **Key accepted**, not **Audio ready**. Reading and saving need no provider key. Hosted automatic audio starts off; title enrichment uses the account's key and `AI_FILL_MODEL` (default `gemini-3.5-flash-lite`).

Validation reports whether the selected script and speech models appear in the key's model list. It does not generate audio or spend model credits. A later visit labels this availability check as not checked; the first actual job separately reports credential, permission, missing-model and quota failures.

## Local mock OIDC and manual QA

No Google client, external account or real provider key is needed:

```sh
bun install --frozen-lockfile
bun run build
PORT=4390 bun scripts/mock-hosted.ts
```

Open `http://127.0.0.1:4390`. The sign-in button redirects through a local generated-RSA OIDC issuer and back to the real callback. Its helper is `tests/helpers/mock-oidc.ts`; it serves discovery, authorization, single-use PKCE code exchange and JWKS. The harness prints the discovery URL, not credentials. Each harness run uses a new temporary database and generated signing/encryption secrets.

Only this harness accepts keys beginning with `test-`. Audio deliberately fails as `vertex_auth` without calling any provider or playing sound, so operator-facing recovery can be checked. It is not a provider integration test and must never be used as a production entrypoint. Stop it with Ctrl-C to remove its temporary database.

Automated checks:

```sh
bun test tests/oidc.test.ts tests/hosted-agents.test.ts tests/gemini-settings.test.ts tests/mcp-forward.test.ts tests/config.test.ts
bun tests/hosted-surface.ts
```

The surface script drives real HTTP OIDC, creates a bearer, saves with `scripts/agent.ts`, reads through the loopback MCP forwarder, and verifies capture and origin rejection. All credentials and records are synthetic and isolated. The CLI takes attribution from its bearer; it does not accept a separate `--source` flag.

## Container

The Dockerfile includes ffmpeg 7.1 from a pinned multi-platform image digest. It listens on `0.0.0.0:8080`, and encoding prefers ffmpeg, then macOS afconvert, then WAV. Set the same origin/secrets/database configuration at runtime. Building or running a local QA container does not publish or deploy it.
