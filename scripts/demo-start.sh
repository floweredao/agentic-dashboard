#!/bin/sh
# Starts the public read-only demo: a brand-new database filled with demo data on every start, then the server with DEMO=on.
# Nothing a visitor does is saved, and each new instance starts from the same demo data with fresh dates.
set -eu
export DATA_DIR="${DATA_DIR:-/tmp/agentic-demo}"
rm -rf "$DATA_DIR"
mkdir -p "$DATA_DIR"
bun scripts/seed.ts
export DEMO=on PUSH=off NARRATION=off
exec bun server/index.ts
