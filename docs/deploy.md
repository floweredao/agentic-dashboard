# Deploying

Two ways are supported. Both were verified on a real machine, and neither needs anything besides Bun (or nothing at all, for the binary).

1. **`bun start` on your own machine or a VM**, behind an HTTPS reverse proxy.
2. **A single binary** built with `bun run build:binary`, which needs no runtime on the target.

A `Dockerfile` is included too. It serves on port 8080 with `HOST=0.0.0.0` and keeps data in `/app/data`, so mount a volume there and set `APP_ORIGIN`. A prebuilt image for linux/amd64 and linux/arm64 is `ghcr.io/floweredao/agentic-dashboard:0.4.0` (also `:latest`); or build one with `docker build -t agentic-dashboard .`. The public demo is that image on Cloud Run in read-only demo mode; see [demo.md](demo.md).

Whichever you pick, read [security.md](security.md) first. The dashboard listens on `127.0.0.1` by default, and you should keep it that way and put HTTPS in front.

## Option 1: Bun behind a reverse proxy

```sh
git clone https://github.com/floweredao/agentic-dashboard.git
cd agentic-dashboard
bun install
bun run setup
cp .env.example .env    # then edit
bun start
```

In `.env`, set at least:

```sh
APP_ORIGIN=https://dashboard.example.com
TIME_ZONE=Europe/Berlin
```

`APP_ORIGIN` must match the address people open exactly. The server rejects requests whose `Host` or `Origin` doesn't match it.

Keep the process running with your init system (systemd, a launch agent, a process manager), and send `SIGTERM` to stop it cleanly.

### Caddy

Caddy gets and renews the certificate itself:

```caddyfile
dashboard.example.com {
	reverse_proxy 127.0.0.1:4310
}
```

### Tailscale Serve

To reach the dashboard only from your own tailnet devices:

```sh
tailscale serve --bg 4310
```

Set `APP_ORIGIN` to the `https://` address `tailscale serve status` prints.

### Sign-in through an identity-aware proxy

If your proxy authenticates users and forwards their identity in a header, the owner can skip the key:

```sh
TRUSTED_USER_HEADER=Tailscale-User-Login
OWNER_LOGIN=you@example.com
```

Set both or neither. Only use this when the proxy strips that header from client requests and is the only way to reach the listener; otherwise anyone can claim to be you. The server also requires `APP_ORIGIN` to be HTTPS before it trusts the header. Tailscale Serve is one such proxy. A plain Caddy setup is not, so leave these unset there.

## Option 2: Single binary

```sh
bun install
bun run build:binary
```

This produces `release/agentic-dashboard` and `release/dist/` (the web app), plus a copy of `.env.example`. Copy the `release/` folder to the target and run it from there, since `STATIC_DIR` defaults to `dist`:

```sh
cd release
./agentic-dashboard owner-key        # creates data/credentials.json and prints the owner key
./agentic-dashboard                  # starts the server
./agentic-dashboard agents add codex # registers an agent
```

The binary reads the same environment variables as `bun start`. Set `BUN_TARGET` while building to cross-compile, for example `BUN_TARGET=bun-linux-x64 bun run build:binary`. Put the same HTTPS proxy in front.

## Updating

Stop the server, pull or copy the new version, run `bun install` and `bun run build` (or rebuild the binary), and start it again. Back up `data/` first.

## Hosted Google sign-in: deployment tooling

This workflow targets a **previously created, billing-enabled Google Cloud project**
and an existing Turso account/group. It does not create accounts or configure
Google OAuth consent. The operations endpoints, Cloud Storage audio, backup and
alert handlers must be present in the application revision before using this
workflow in production (the parallel onboarding/operations work supplies them).
The tooling itself has been checked with local command-builder tests and dry runs,
not a live cloud deployment.

Install Bun, the Google Cloud CLI and the Turso CLI, authenticate each CLI yourself,
and select the intended Turso organization. The operator needs permission to
enable APIs, manage the named resources and their IAM policies, act as the build
and runtime service accounts, and manage budgets on the configured billing
account. Runtime identities never get those administrator permissions.

### One private configuration file

```sh
mkdir -p ~/.config/dash-web
cp scripts/hosted/deploy.env.example ~/.config/dash-web/deploy.env
chmod 600 ~/.config/dash-web/deploy.env
# Edit the copied file, then inspect every command without executing any:
sh scripts/bootstrap-gcp.sh --env-file ~/.config/dash-web/deploy.env --dry-run
bun scripts/set-secret.ts --env-file ~/.config/dash-web/deploy.env --dry-run
sh scripts/deploy-cloud-run.sh --env-file ~/.config/dash-web/deploy.env --dry-run
```

The file is dotenv data, **never sourced as shell code**. Unknown fields and
group/world-readable files are rejected. Keep it outside the checkout and never
put credentials in it. Use these fields:

| Field | Purpose / default |
|---|---|
| `PROJECT_ID`, `BILLING_ACCOUNT` | Existing project and its billing account ID |
| `REGION` | Must be `us-central1` |
| `SERVICE`, `SA` | Cloud Run service and runtime service-account **short ID**; both `dashboard` |
| `REPOSITORY`, `SECRET` | Artifact Registry repo `dashboard`; Secret Manager secret `dash-web-config` |
| `BUCKET` | Globally unique private audio/backup bucket; a separate `<BUCKET>-build` bucket holds build uploads/logs |
| `QUEUE` | Cloud Tasks queue `dashboard` |
| `TURSO_DB`, `TURSO_GROUP` | Database to create if absent, and an **existing** group in the active Turso organization |
| `DATABASE_URL` | Optional libSQL/HTTPS URL without credentials; otherwise resolved with `turso db show --url` |
| `APP_ORIGIN` | Optional HTTPS origin; omit to discover Cloud Run's URL |
| `OWNER_ALERT_EMAIL`, `CONTACT_EMAIL` | Operator-only Resend alert recipient and public contact address |
| `MAX_USERS` | Hosted sign-up ceiling, `50` |
| `NARRATION_DAILY_LIMIT`, `NARRATION_GLOBAL_DAILY_LIMIT` | Account/service daily limits, `10` and `60` |
| `OWNER_USER_LIMITS` | JSON account-ID-to-daily-limit map, `{}` |

An absent origin uses `https://bootstrap.invalid` for the initial revision, reads
the service's reported URL, and updates `APP_ORIGIN` once before creating/updating
the Scheduler job. The temporary origin does not permit real sign-in. Configure
the Google OAuth web client's authorized redirect URI as
`<final APP_ORIGIN>/auth/google/callback`. With a custom domain, supply the final
origin before deploying and configure its DNS/Cloud Run mapping separately.

### Provision, configure secrets, deploy

Without `--dry-run` or `--yes`, **every entrypoint refuses execution** with exit
code 2. Dry runs need neither cloud CLI and do not read cloud state or generate
credentials. They show each command, conditional create/update branch and
captured-output placeholder such as `@PROJECT_NUMBER@`. Secret payloads are
represented only as `[REDACTED stdin]`. Do not pass both flags.

When you are ready to execute against your own accounts, run, in order:

```sh
sh scripts/bootstrap-gcp.sh --env-file ~/.config/dash-web/deploy.env --yes
bun scripts/set-secret.ts --env-file ~/.config/dash-web/deploy.env --yes
sh scripts/deploy-cloud-run.sh --env-file ~/.config/dash-web/deploy.env --yes
```

1. **Bootstrap** enables the required APIs and reconciles service accounts,
   registry, private buckets, secret metadata, queue and project-filtered monthly
   budgets of **1 USD and 5 USD**, each alerting at 100% actual spend. Budget
   notices go to the billing account's default IAM recipients, not the Resend
   address. Budgets are alerts, **not spending caps**. A failed discovery command
   aborts; it is never treated as proof a resource is absent.
2. **Set secrets** reads the newest enabled `APP_SECRETS` JSON version without
   printing it. Google client ID/secret, optional Turso platform token and
   organization, and optional Resend API key use hidden terminal input; Enter
   preserves an existing value. On first setup it locally generates the
   encryption key, session signing key and VAPID pair and obtains the database
   token through `turso db tokens create` with stdout captured. It uploads JSON
   through stdin (no secret file or command argument), then destroys versions
   older than the newest two. An upload failure leaves old versions untouched.
   Existing encryption/session/push keys and database tokens are preserved.
   Keep all `kek` entries until `scripts/rotate-kek.ts` has re-encrypted their data;
   changing a secret version is not encryption-key rotation.
3. **Deploy** submits the local Dockerfile to Cloud Build, builds/pushes an image
   to the configured registry, then runs `gcloud run deploy --image ...`.
   Cloud Build's source is the checkout (`gcloud builds submit .`); the source
   allowlist excludes local databases, config and QA artifacts. A dedicated
   `<SA>-build` account can write the image repo, build bucket and project build logs. Cloud Run
   uses `<SA>` with the settings below and mounts
   `APP_SECRETS=<SECRET>:latest`. Non-secret runtime env vars derive from the same
   config file; no credentials are placed in `--set-env-vars`.

Bootstrap is rerunnable: existing resources are discovered before creation and
mutable queue, lifecycle, IAM and budget settings are reconciled. Deploy updates
the service and the single `dash-web-maintenance` Scheduler job. It runs daily
at **04:00 Asia/Seoul**, POSTing `/internal/tasks/maintenance` with the runtime
identity's OIDC token and the final origin as audience. This is created during
deploy, after the service URL exists, rather than targeting a nonexistent service.

### Sizing and permissions

| Resource | Tooling setting |
|---|---|
| Cloud Run | min 0, max 2 instances; 1 CPU, 512 MiB; concurrency 40; timeout 900s; CPU throttled outside requests; startup CPU boost off |
| Cloud Tasks | Queue max attempts 3; runtime can enqueue only on that queue |
| Cloud Storage | Uniform access and public-access prevention; runtime object admin only on audio/backup bucket; delete `backups/` objects after 14 days |
| Build uploads/logs | Separate private bucket; object lifecycle delete after 1 day |
| Artifact Registry | Keep two newest image versions; delete older versions |
| Secret Manager | Runtime can read only the named secret |
| IAM signing | Runtime can sign blobs/mint tokens and act as itself, not other accounts |
| Cloud Run invocation | Runtime invoker on this service; public ingress is necessary for Google sign-in, while internal routes verify OIDC in the application |

The configuration aims for low idle usage but does not guarantee a zero bill.
Review the current [Cloud Run pricing](https://cloud.google.com/run/pricing),
[Cloud Build pricing](https://cloud.google.com/build/pricing),
[Cloud Storage pricing](https://cloud.google.com/storage/pricing),
[Cloud Tasks pricing](https://cloud.google.com/tasks/pricing),
[Scheduler pricing](https://cloud.google.com/scheduler/pricing),
[Artifact Registry pricing](https://cloud.google.com/artifact-registry/pricing),
[Secret Manager pricing](https://cloud.google.com/secret-manager/pricing) and
[Turso plans](https://turso.tech/pricing) before execution. In particular builds,
network egress and retained artifacts are separate from request-time CPU.
API references: [Cloud Run deploy](https://cloud.google.com/sdk/gcloud/reference/run/deploy),
[Cloud Build submit](https://cloud.google.com/sdk/gcloud/reference/builds/submit),
[budgets](https://cloud.google.com/sdk/gcloud/reference/billing/budgets/create)
and [Turso database creation](https://docs.turso.tech/cli/db/create).

Resend alerts need `APP_SECRETS.resend.apiKey`; Turso usage monitoring needs
`APP_SECRETS.turso.platformToken` and `.org`. Without them the corresponding
operator notifications are not enabled. These are distinct from GCP billing
budget notifications. Review the saved dry-run transcript before every live run;
live provisioning, OAuth verification, backup delivery and alert receipt remain
operator acceptance steps, not claims made by a local dry run.

## Backups

Everything lives in `DATA_DIR` (default `data/`): `dashboard.sqlite`, `credentials.json`, `vapid.json` and `audio/`. Back up the whole folder while the server is stopped, or use `sqlite3 data/dashboard.sqlite ".backup backup.sqlite"` while it runs.
