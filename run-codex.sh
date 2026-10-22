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
CALENDAR_TOOLS="${6:-false}"
PURPOSE="${7:-interactive}"
[[ "$PURPOSE" == interactive || "$PURPOSE" == morning ]] || { echo 'Invalid request purpose' >&2; exit 64; }
[[ "$PURPOSE" != morning || "$MODE" == READ ]] || { echo 'Morning reports require READ mode' >&2; exit 64; }
[[ "$MODE" == READ || "$MODE" == WRITE ]] || { echo 'Invalid request mode' >&2; exit 64; }
[[ "$CALENDAR_TOOLS" == true || "$CALENDAR_TOOLS" == false ]] || { echo 'Invalid calendar tool mode' >&2; exit 64; }
[[ "$MODE" != READ || "$CALENDAR_TOOLS" == false ]] || { echo 'Calendar mutation tools are not available in READ mode' >&2; exit 64; }
[[ "$OUTPUT" == /* && "$JSON_OUTPUT" == /* ]] || { echo 'Output paths must be absolute' >&2; exit 64; }
cd "$REPO"
if [[ "$MODE" == WRITE ]]; then
  exec 9>"$LOCK"
  flock -w "${CODEX_QUEUE_TIMEOUT_SECONDS:-300}" 9 || { echo 'KB transaction queue busy' >&2; exit 75; }
  [[ -z "$(git status --porcelain)" ]] || { echo 'Repository was dirty before Telegram request; existing files preserved' >&2; exit 73; }
  "$SYNC" >/dev/null 2>&1 || { echo 'Pre-Codex synchronization failed' >&2; exit 1; }
  [[ -z "$(git status --porcelain)" ]] || { echo 'Repository is dirty after synchronization' >&2; exit 73; }
fi
BASE="$(git rev-parse HEAD)"
TEMP="$(mktemp -d)"
WORK="$TEMP/work"
cleanup() {
  if [[ "$MODE" == WRITE ]]; then git -C "$REPO" worktree remove --force "$WORK" >/dev/null 2>&1 || true; fi
  rm -rf -- "$TEMP"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [[ "$MODE" == READ ]]; then
  mkdir "$WORK"
  # Git objects give us one immutable revision without touching the live checkout
  # or worktree metadata. Dirty/uncommitted changes are never included.
  git archive --format=tar "$BASE" | tar -xf - -C "$WORK"
else
  git worktree add --detach "$WORK" "$BASE" >/dev/null 2>&1
fi
{
  printf 'For this turn the KB is the current temporary worktree. Use relative paths here, not absolute paths from earlier conversation turns. Do not run Git commands, launch other Codex processes, or modify AGENTS.md. Only Markdown knowledge changes can be saved.\n\n'
  cat
} >"$TEMP/prompt.txt"
# Override cwd and sandbox for new AND resumed conversations. Old session
# metadata must not point execution back at the live checkout.
PROFILE=bulk
[[ "$MODE" != READ ]] || PROFILE=answer
SANDBOX=workspace-write
[[ "$MODE" != READ ]] || SANDBOX=read-only
ARGS=("--knowledge-call-profile=$PROFILE" -C "$WORK" -c "sandbox_mode=\"$SANDBOX\"" -c 'sandbox_workspace_write.writable_roots=[]' exec)
if [[ "$PURPOSE" == morning ]]; then
  # The HTTP bridge exchanges request/response files here. The KB remains a
  # disposable archive: no report edits are ever merged into the live checkout.
  mkdir -p /tmp/knowledge-http/requests /tmp/knowledge-http/responses
  ARGS=(--knowledge-call-profile=bulk -C "$WORK"
    -c 'sandbox_mode="workspace-write"'
    -c 'sandbox_workspace_write.writable_roots=["/tmp/knowledge-http"]'
    -c 'sandbox_workspace_write.network_access=false'
    -c 'sandbox_workspace_write.exclude_tmpdir_env_var=true'
    -c 'sandbox_workspace_write.exclude_slash_tmp=true' exec)
fi
if [[ "$CALENDAR_TOOLS" == true ]]; then
  ARGS=(
    -c 'mcp_servers.knowledge-gcal.command="/opt/knowledge-agent/gcal-mcp.sh"'
    -c 'mcp_servers.knowledge-gcal.required=true'
    -c 'mcp_servers.knowledge-gcal.default_tools_approval_mode="approve"'
    "${ARGS[@]}"
  )
fi
if [[ "$MODE" == WRITE && -n "$SESSION_ID" ]]; then ARGS+=(resume "$SESSION_ID"); fi
if [[ "$MODE" == READ ]]; then
  ARGS+=(--ephemeral --skip-git-repo-check)
  # Ranked passages avoid repeated exploratory tool calls. The complete snapshot
  # remains available when a question needs broader evidence.
  node "$APP/read-context.js" "$WORK" "$BASE" "$TEMP/prompt.txt"
fi
ARGS+=(--json -o "$TEMP/response.txt")
if [[ -n "$IMAGE" ]]; then ARGS+=(--image "$IMAGE"); fi
ARGS+=(-)
echo "Telegram: running $MODE request in temporary worktree" >&2
if bash "$APP/run-codex-call.sh" "${ARGS[@]}" <"$TEMP/prompt.txt" | tee "$TEMP/events.jsonl"; then
  :
else
  code=$?
  echo 'Telegram: request failed; unfinished worktree edits discarded' >&2
  exit "$code"
fi
[[ -s "$TEMP/response.txt" ]] || { echo 'Codex returned no response' >&2; exit 1; }
if [[ "$MODE" == WRITE ]]; then
  [[ "$(git -C "$WORK" rev-parse HEAD)" == "$BASE" ]] || { echo 'Unexpected model Git commit' >&2; exit 1; }
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
if [[ "$MODE" == READ ]]; then printf '{"type":"knowledge.snapshot","revision":"%s"}\n' "$BASE" >>"$JSON_OUTPUT"; fi
echo "Telegram: $MODE transaction complete" >&2
