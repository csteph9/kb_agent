#!/bin/bash
# Shared entry point for all application-owned Codex calls.
set -euo pipefail
umask 077
APP="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
export CODEX_CONTROL_DIR="${CODEX_CONTROL_DIR:-$APP/var/codex}"
QUEUE_WAIT="${CODEX_QUEUE_TIMEOUT_SECONDS:-300}"
BUDGET="${CODEX_CALL_TIMEOUT_SECONDS:-900}"
for value in "$QUEUE_WAIT" "$BUDGET"; do
  [[ "$value" =~ ^[1-9][0-9]{0,4}$ ]] && ((value <= 86400)) || { echo 'Invalid Codex timeout configuration' >&2; exit 64; }
done
mkdir -p "$CODEX_CONTROL_DIR"
exec 7>"$CODEX_CONTROL_DIR/call.lock"
echo 'Codex: waiting for shared execution slot' >&2
flock -w "$QUEUE_WAIT" 7 || { echo 'Codex: execution queue busy; try again later' >&2; exit 75; }
# Bounds all pacing/backoff and CLI-internal retries, including tool children.
export CODEX_CALL_TEMP_DIR="$(mktemp -d)"
trap 'rm -rf -- "$CODEX_CALL_TEMP_DIR"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
timeout --kill-after=5s "${BUDGET}s" node "$APP/codex-control.js" "$@"
