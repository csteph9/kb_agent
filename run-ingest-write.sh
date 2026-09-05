#!/bin/bash
set -euo pipefail
umask 077
APP="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO="${KNOWLEDGE_REPO:-/home/knowledge/repo}"
LOCK="${KNOWLEDGE_REPO_LOCK:-/tmp/knowledge-repo.lock}"
SYNC="${KNOWLEDGE_SYNC_SCRIPT:-$APP/sync-repo.sh}"
PROMPT="${1:?Prompt path required}"
JOB="${2:?Job ID required}"
[[ "$JOB" =~ ^[a-f0-9]{64}$ ]] || exit 1
[[ -f "$PROMPT" ]] || exit 1
cd "$REPO"
exec 9>"$LOCK"
flock -w 300 9 || { echo 'Repository lock unavailable' >&2; exit 1; }
RECEIPT="Knowledge-Ingest-Job: $JOB"
# Check the receipt before synchronization; retrying a failed push must not re-run extraction.
if git log --format=%B --fixed-strings --grep="$RECEIPT" -1 | grep -Fxq "$RECEIPT"; then
  "$SYNC" >/dev/null 2>&1 || exit 2
  exit 0
fi
[[ -z "$(git status --porcelain)" ]] || { echo 'Repository is dirty' >&2; exit 1; }
"$SYNC" >/dev/null 2>&1 || { echo 'Pre-ingestion sync failed' >&2; exit 1; }
# The pre-sync may have fetched a receipt from another server.
if git log --format=%B --fixed-strings --grep="$RECEIPT" -1 | grep -Fxq "$RECEIPT"; then exit 0; fi
TEMP="$(mktemp -d)"
WORK="$TEMP/work"
cleanup() {
  git -C "$REPO" worktree remove --force "$WORK" >/dev/null 2>&1 || true
  rm -rf -- "$TEMP"
}
trap cleanup EXIT
git worktree add --detach "$WORK" HEAD >/dev/null 2>&1
BASE="$(git rev-parse HEAD)"
echo 'Running knowledge extraction in temporary worktree' >&2
# Capture all model output privately; only stage names reach the journal.
if ! timeout --kill-after=30s "${INGEST_MODEL_TIMEOUT_SECONDS:-900}s" codex exec --sandbox workspace-write -C "$WORK" - <"$PROMPT" >"$TEMP/model.log" 2>&1; then
  echo 'Knowledge extraction failed; live checkout unchanged' >&2
  exit 1
fi
# Reject Git commits made by the model and changes to policy, hidden files, symlinks or non-Markdown files.
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
git -C "$WORK" diff --cached --check >/dev/null || { echo 'Markdown diff validation failed' >&2; exit 1; }
# An empty commit is a durable receipt when the source contains no useful knowledge.
git -C "$WORK" -c core.hooksPath=/dev/null commit --allow-empty -m "Knowledge ingestion" -m "$RECEIPT" >/dev/null
# Merge the actual detached commit, not a filesystem path.
git -c core.hooksPath=/dev/null merge --ff-only "$(git -C "$WORK" rev-parse HEAD)" >/dev/null
echo 'Knowledge committed locally' >&2
"$SYNC" >/dev/null 2>&1 || { echo 'Knowledge applied; remote synchronization pending' >&2; exit 2; }