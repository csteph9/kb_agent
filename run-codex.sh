#!/bin/bash
set -euo pipefail
umask 077
APP="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO="${KNOWLEDGE_REPO:-/home/knowledge/repo}"
LOCK="${KNOWLEDGE_REPO_LOCK:-/tmp/knowledge-repo.lock}"
SYNC="${KNOWLEDGE_SYNC_SCRIPT:-$APP/sync-repo.sh}"
OUTPUT="${1:?Output file required}"
SESSION_ID="${2:-}"
IMAGE="${3:-}"
JSON_OUTPUT="${4:?JSON output file required}"
MODE="${5:-READ}"
[[ "$MODE" == READ || "$MODE" == WRITE ]] || { echo 'Invalid request mode' >&2; exit 64; }
[[ "$OUTPUT" == /* && "$JSON_OUTPUT" == /* ]] || { echo 'Output paths must be absolute' >&2; exit 64; }
cd "$REPO"
exec 9>"$LOCK"
flock -w "${CODEX_QUEUE_TIMEOUT_SECONDS:-300}" 9 || { echo 'KB transaction queue busy' >&2; exit 75; }
[[ -z "$(git status --porcelain)" ]] || { echo 'Repository was dirty before Telegram request; existing files preserved' >&2; exit 73; }
if [[ "$MODE" == WRITE ]]; then
  "$SYNC" >/dev/null 2>&1 || { echo 'Pre-Codex synchronization failed' >&2; exit 1; }
fi
[[ -z "$(git status --porcelain)" ]] || { echo 'Repository is dirty after synchronization' >&2; exit 73; }
BASE="$(git rev-parse HEAD)"
TEMP="$(mktemp -d)"
WORK="$TEMP/work"
cleanup() {
  git -C "$REPO" worktree remove --force "$WORK" >/dev/null 2>&1 || true
  rm -rf -- "$TEMP"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
git worktree add --detach "$WORK" "$BASE" >/dev/null 2>&1
{
  printf 'For this turn the KB is the current temporary worktree. Use relative paths here, not absolute paths from earlier conversation turns. Do not run Git commands, launch other Codex processes, or modify AGENTS.md. Only Markdown knowledge changes can be saved.\n\n'
  cat
} >"$TEMP/prompt.txt"
# Override cwd and sandbox for new AND resumed conversations. Old session
# metadata must not point execution back at the live checkout.
PROFILE=bulk
[[ "$MODE" != READ ]] || PROFILE=answer
ARGS=("--knowledge-call-profile=$PROFILE" -C "$WORK" -c 'sandbox_mode="workspace-write"' -c 'sandbox_workspace_write.writable_roots=[]' exec)
if [[ -n "$SESSION_ID" ]]; then ARGS+=(resume "$SESSION_ID"); fi
ARGS+=(--json -o "$TEMP/response.txt")
if [[ -n "$IMAGE" ]]; then ARGS+=(--image "$IMAGE"); fi
ARGS+=(-)
echo "Telegram: running $MODE request in temporary worktree" >&2
if bash "$APP/run-codex-call.sh" "${ARGS[@]}" <"$TEMP/prompt.txt" >"$TEMP/events.jsonl"; then
  :
else
  code=$?
  echo 'Telegram: request failed; unfinished worktree edits discarded' >&2
  exit "$code"
fi
[[ -s "$TEMP/response.txt" ]] || { echo 'Codex returned no response' >&2; exit 1; }
[[ "$(git -C "$WORK" rev-parse HEAD)" == "$BASE" ]] || { echo 'Unexpected model Git commit' >&2; exit 1; }
if [[ "$MODE" == WRITE ]]; then
  git -C "$WORK" add -A
  while IFS= read -r -d '' file; do
    case "$file" in
      AGENTS.md|*/AGENTS.md|.*|*/.*) echo 'Protected path changed' >&2; exit 1 ;;
      *.md) ;;
      *) echo 'Non-Markdown path changed' >&2; exit 1 ;;
    esac
    [[ ! -L "$WORK/$file" ]] || { echo 'Symlink changes rejected' >&2; exit 1; }
  done < <(git -C "$WORK" diff --cached --no-renames --name-only -z)
  git -C "$WORK" diff --cached --check || { echo 'Markdown diff validation failed' >&2; exit 1; }
  if ! git -C "$WORK" diff --cached --quiet; then
    git -C "$WORK" -c core.hooksPath=/dev/null commit -m 'Knowledge update via Telegram' >/dev/null
    [[ "$(git rev-parse HEAD)" == "$BASE" && -z "$(git status --porcelain)" ]] || { echo 'Live KB changed during request; refusing to merge' >&2; exit 73; }
    git -c core.hooksPath=/dev/null merge --ff-only "$(git -C "$WORK" rev-parse HEAD)" >/dev/null
    "$SYNC" >/dev/null 2>&1 || { echo 'Knowledge committed locally; GitHub synchronization pending' >&2; exit 2; }
  fi
fi
# READ-side edits disappear with the worktree. Never reset/clean the live KB.
cp "$TEMP/response.txt" "$OUTPUT"
cp "$TEMP/events.jsonl" "$JSON_OUTPUT"
echo "Telegram: $MODE transaction complete" >&2
