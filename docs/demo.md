# Public demo

The live demo linked from the README is this repository running in **demo mode** on Google Cloud Run. This page explains what demo mode does and how to run your own copy.

## What demo mode does

`DEMO=on` turns the server into a read-only showcase:

- Anyone who opens the page browses as the owner, without a key or a sign-in. No session or cookie is created.
- Every request other than `GET` or `HEAD` answers `403 demo_read_only`, whoever sends it and whatever key it carries. Records, comments, shares, digests, the trash and sign-out are all frozen.
- Push and narration are forced off. The server refuses to start in demo mode together with `TRUSTED_USER_HEADER`, `ENABLE_MCP`, `ENABLE_AGENT_INGRESS` or `AI_FILL_COMMAND`.
- The web app shows a "Demo" badge, says once that changes aren't saved, and stops marking items read when you open them.

Never turn on demo mode for a database that holds real records: everything in it becomes readable by anyone who can reach the server.

`scripts/demo-start.sh` is the demo's entry point. On every start it deletes the data folder (`/tmp/agentic-demo` by default), fills a new database with `bun run seed`, and starts the server with `DEMO=on`. Each new instance therefore begins from the same demo data with fresh dates, and nothing from a visit carries over.

Try it locally:

```sh
bun install && bun run build
DATA_DIR=$(mktemp -d) PORT=4310 sh scripts/demo-start.sh
```

Then open `http://127.0.0.1:4310`.

## Run your own on Cloud Run

You need the `gcloud` CLI, a Google Cloud project with billing enabled, and nothing else. The build runs on Cloud Build, so Docker isn't required locally.

```sh
PROJECT_ID=your-demo-project scripts/deploy-demo.sh
```

The script:

1. enables Cloud Run, Cloud Build and Artifact Registry in the project;
2. builds the `Dockerfile` from source and deploys it with `--min-instances 0 --max-instances 1 --cpu 1 --memory 512Mi --no-cpu-boost`, request-based billing and unauthenticated access, running `scripts/demo-start.sh`;
3. sets `APP_ORIGIN` to the URL Cloud Run assigned, because the server answers only on that address;
4. keeps the two newest images in Artifact Registry and deletes uploaded sources after 7 days.

Optional variables: `REGION` (default `us-central1`), `SERVICE` (default `agentic-dashboard-demo`), `TIME_ZONE` (default `UTC`) and `APP_ORIGIN`.

Use a project of its own for the demo, so its budget and permissions stay apart from anything else.

## Cost

The demo is sized to stay inside Google Cloud's Always Free allowances. These are counted per billing account, so they are shared with anything else on the same account.

| Service | Free each month | Demo use |
|---|---|---|
| Cloud Run (request-based) | 2 million requests, 180,000 vCPU-seconds, 360,000 GiB-seconds | CPU only while a request runs, one instance at most, none while idle |
| Artifact Registry | 0.5 GB | two images of about 0.1 GB each |
| Cloud Build | 2,500 build-minutes | a few minutes per deploy |
| Cloud Storage (`us-central1`) | 5 GB | uploaded sources, deleted after 7 days |
| Cloud Logging | 50 GiB | one line per request |

Requests without a key share one limit of 300 per minute (see [CONTRACT.md](../CONTRACT.md)). One page load is about 15 requests, so a flood is cut off long before it costs anything, and a single instance caps the CPU used even under load.

Set a budget alert on the project anyway. Amounts are in your billing account's currency; this one alerts at 5%, 25% and 100% of 20 US dollars' worth, counted before credits:

```sh
gcloud billing budgets create --billing-account=YOUR_BILLING_ACCOUNT --billing-project=$PROJECT_ID \
  --display-name=agentic-dashboard-demo --budget-amount=20USD --filter-projects=projects/$PROJECT_ID \
  --credit-types-treatment=exclude-all-credits --calendar-period=month \
  --threshold-rule=percent=0.05 --threshold-rule=percent=0.25 --threshold-rule=percent=1.0
```

## Remove it

```sh
gcloud run services delete agentic-dashboard-demo --project $PROJECT_ID --region us-central1
gcloud projects delete $PROJECT_ID
```
