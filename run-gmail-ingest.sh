#!/bin/bash
set -euo pipefail
APP="$(cd -- "$(dirname -- "$0")" && pwd)"
if [[ $# -gt 0 ]]; then
  echo 'This command does not accept prompt files. Use node ingest/cli.js run personal-gmail.' >&2
  exit 1
fi
exec node "$APP/ingest/cli.js" run "${GMAIL_SOURCE_ID:-personal-gmail}"