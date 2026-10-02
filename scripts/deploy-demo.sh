#!/bin/sh
# Deploys the public read-only demo to Google Cloud Run, sized to stay inside the free tier. See docs/demo.md.
#   PROJECT_ID=<your demo project> scripts/deploy-demo.sh
# Optional: REGION (default us-central1), SERVICE (default agentic-dashboard-demo), TIME_ZONE (default UTC),
# APP_ORIGIN (default: the service URL Cloud Run reports).
set -eu
: "${PROJECT_ID:?Set PROJECT_ID to the Google Cloud project that hosts the demo}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-agentic-dashboard-demo}"
TIME_ZONE="${TIME_ZONE:-UTC}"
cd "$(dirname "$0")/.."

gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com --project "$PROJECT_ID"
# On a new project the Artifact Registry permission can take a few minutes to arrive; rerun the script if this step is denied.
gcloud artifacts repositories describe cloud-run-source-deploy --project "$PROJECT_ID" --location "$REGION" >/dev/null 2>&1 ||
  gcloud artifacts repositories create cloud-run-source-deploy --project "$PROJECT_ID" --location "$REGION" --repository-format docker --quiet

# One instance at most, none while idle, and CPU only while a request runs.
gcloud run deploy "$SERVICE" --project "$PROJECT_ID" --region "$REGION" --source . --quiet \
  --allow-unauthenticated --min-instances 0 --max-instances 1 --cpu 1 --memory 512Mi --no-cpu-boost --timeout 30 \
  --command sh --args scripts/demo-start.sh --update-env-vars "TIME_ZONE=$TIME_ZONE"

# The server answers only on the address people open, so it has to know the URL Cloud Run gave it.
URL="${APP_ORIGIN:-$(gcloud run services describe "$SERVICE" --project "$PROJECT_ID" --region "$REGION" --format 'value(status.url)')}"
CURRENT="$(gcloud run services describe "$SERVICE" --project "$PROJECT_ID" --region "$REGION" \
  --format 'value(spec.template.spec.containers[0].env)')"
case "$CURRENT" in
  *"'value': '$URL'"*) ;;
  *) gcloud run services update "$SERVICE" --project "$PROJECT_ID" --region "$REGION" --quiet --update-env-vars "APP_ORIGIN=$URL" ;;
esac

# Keep only the two newest images and a week of uploaded sources, so storage stays far below the free allowance.
POLICY="$(mktemp)"
trap 'rm -f "$POLICY"' EXIT
cat > "$POLICY" <<'JSON'
[
  { "name": "keep-newest", "action": { "type": "Keep" }, "mostRecentVersions": { "keepCount": 2 } },
  { "name": "delete-older", "action": { "type": "Delete" }, "condition": { "tagState": "any" } }
]
JSON
gcloud artifacts repositories set-cleanup-policies cloud-run-source-deploy --project "$PROJECT_ID" --location "$REGION" \
  --policy "$POLICY" --no-dry-run --quiet
cat > "$POLICY" <<'JSON'
{ "rule": [{ "action": { "type": "Delete" }, "condition": { "age": 7 } }] }
JSON
gcloud storage buckets update "gs://run-sources-$PROJECT_ID-$REGION" --lifecycle-file "$POLICY" --quiet

echo "Demo: $URL"
