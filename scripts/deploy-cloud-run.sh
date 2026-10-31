#!/bin/sh
set -eu
exec bun "$(dirname "$0")/hosted/main.ts" deploy "$@"
