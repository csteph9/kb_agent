#!/bin/bash
set -euo pipefail
APP="$(cd -- "$(dirname -- "$0")/.." && pwd)"
TEMP="$(mktemp -d)"
cleanup() {
  touch "$TEMP/release" "$TEMP/stream-release"
  [[ -z "${holder:-}" ]] || wait "$holder" 2>/dev/null || true
  [[ -z "${bulk:-}" ]] || wait "$bulk" 2>/dev/null || true
  [[ -z "${stream:-}" ]] || wait "$stream" 2>/dev/null || true
  rm -rf -- "$TEMP"
}
trap cleanup EXIT
export KNOWLEDGE_REPO="$TEMP/repo" KNOWLEDGE_REPO_LOCK="$TEMP/repo.lock"
export CODEX_CONTROL_DIR="$TEMP/control" KNOWLEDGE_SYNC_SCRIPT="$TEMP/no-sync"
export TEST_FAST="$TEMP" CODEX_MIN_GAP_SECONDS=0 CODEX_QUEUE_TIMEOUT_SECONDS=1
export CODEX_READ_TIMEOUT_SECONDS=5 CODEX_READ_QUEUE_TIMEOUT_SECONDS=1
mkdir -p "$KNOWLEDGE_REPO" "$TEMP/bin"
export PATH="$TEMP/bin:$PATH"
cat >"$TEMP/bin/codex" <<'MOCK'
#!/bin/bash
set -euo pipefail
output='' sandbox='' roots='' resume=false
while [[ $# -gt 0 ]]; do
  case "$1" in -C) shift; cd "$1" ;; -o) shift; output="$1" ;; -c) shift; [[ "$1" != sandbox_mode=* ]] || sandbox="$1"; [[ "$1" != sandbox_workspace_write.writable_roots=* ]] || roots="$1" ;; resume) resume=true ;; esac
  shift
done
cat >"$TEST_FAST/prompt"
echo '{"type":"thread.started","thread_id":"read-thread"}'
if [[ "${BLOCK_BULK:-0}" == 1 ]]; then
  touch "$TEST_FAST/bulk-started"
  while [[ ! -f "$TEST_FAST/release" ]]; do sleep 0.05; done
else
  [[ "$resume" == false ]]
  if [[ "${MORNING_REPORT:-0}" == 1 ]]; then
    [[ "$sandbox" == 'sandbox_mode="workspace-write"' ]]
    [[ "$roots" == 'sandbox_workspace_write.writable_roots=["/tmp/knowledge-http"]' ]]
    [[ "$CODEX_CONTROL_DIR" != */interactive ]]
    [[ "$CODEX_CALL_TIMEOUT_SECONDS" == 30 ]]
  else
    [[ "$sandbox" == 'sandbox_mode="read-only"' ]]
  fi
  [[ "$PWD" != "$KNOWLEDGE_REPO" && ! -e .git && ! -e manual.md ]]
  [[ "$(cat fact.md)" == 'Coach: Alex.' ]]
  grep -q 'BEGIN RETRIEVED KB JSON' "$TEST_FAST/prompt"
  echo '{"type":"item.completed","item":{"type":"agent_message","text":"Coach: Alex."}}'
  if [[ "${STREAM_READ:-0}" == 1 ]]; then
    touch "$TEST_FAST/stream-started"
    while [[ ! -f "$TEST_FAST/stream-release" ]]; do sleep 0.05; done
  fi
  # Even a defective CLI cannot persist edits to this disposable snapshot.
  echo accidental >fact.md
  echo 'Coach: Alex.' >"$output"
fi
echo '{"type":"turn.completed"}'
MOCK
chmod +x "$TEMP/bin/codex"
git -C "$KNOWLEDGE_REPO" init -q
git -C "$KNOWLEDGE_REPO" config user.name Test
git -C "$KNOWLEDGE_REPO" config user.email test@example.org
echo 'Coach: Alex.' >"$KNOWLEDGE_REPO/fact.md"
echo 'Policy' >"$KNOWLEDGE_REPO/AGENTS.md"
git -C "$KNOWLEDGE_REPO" add .
git -C "$KNOWLEDGE_REPO" commit -qm initial
echo uncommitted >"$KNOWLEDGE_REPO/manual.md"
mkdir -p "$CODEX_CONTROL_DIR"
flock "$KNOWLEDGE_REPO_LOCK" bash -c 'touch "$TEST_FAST/repo-held"; while [[ ! -f "$TEST_FAST/release" ]]; do sleep 0.05; done' &
holder=$!
BLOCK_BULK=1 bash "$APP/run-codex-call.sh" exec --json - </dev/null >"$TEMP/bulk-events" &
bulk=$!
for ((i=0; i<100; i++)); do
  [[ ! -f "$TEMP/repo-held" || ! -f "$TEMP/bulk-started" ]] || break
  sleep 0.05
done
[[ -f "$TEMP/repo-held" && -f "$TEMP/bulk-started" ]]
# Both background locks remain held throughout this successful read.
timeout 8s bash "$APP/run-codex.sh" "$TEMP/answer" 'busy-write-thread' '' "$TEMP/events" READ <<<'USER REQUEST: Who is the coach?'
[[ "$(cat "$TEMP/answer")" == 'Coach: Alex.' ]]
grep -q 'knowledge.snapshot' "$TEMP/events"
[[ "$(cat "$KNOWLEDGE_REPO/fact.md")" == 'Coach: Alex.' ]]
[[ "$(cat "$KNOWLEDGE_REPO/manual.md")" == uncommitted ]]
[[ "$(git -C "$KNOWLEDGE_REPO" worktree list --porcelain | grep -c '^worktree ')" == 1 ]]
set +e
bash "$APP/run-codex.sh" "$TEMP/write-answer" '' '' "$TEMP/write-events" WRITE <<<'Test write'
code=$?
set -e
[[ "$code" == 75 ]]
touch "$TEMP/release"; wait "$holder"; wait "$bulk"; holder=''; bulk=''
# Completed agent messages reach Telegram's pipe before the CLI exits.
STREAM_READ=1 bash "$APP/run-codex.sh" "$TEMP/stream-answer" '' '' "$TEMP/stream-events" READ <<<'USER REQUEST: Who is the coach?' >"$TEMP/preview" &
stream=$!
for ((i=0; i<100; i++)); do
  if [[ -f "$TEMP/stream-started" ]] && grep -q agent_message "$TEMP/preview"; then break; fi
  sleep 0.05
done
grep -q agent_message "$TEMP/preview"
[[ ! -f "$TEMP/stream-answer" ]]
touch "$TEMP/stream-release"; wait "$stream"; stream=''
# Morning reports need bridge file access and the background time budget,
# while still discarding snapshot edits and never resuming a write thread.
MORNING_REPORT=1 CODEX_CALL_TIMEOUT_SECONDS=30 bash "$APP/run-codex.sh" "$TEMP/morning-answer" 'old-thread' '' "$TEMP/morning-events" READ false morning <<<'USER REQUEST: Morning weather and news'
[[ "$(cat "$TEMP/morning-answer")" == 'Coach: Alex.' ]]
[[ "$(cat "$KNOWLEDGE_REPO/fact.md")" == 'Coach: Alex.' ]]
[[ "$(cat "$KNOWLEDGE_REPO/manual.md")" == uncommitted ]]
grep -q 'knowledge.snapshot' "$TEMP/morning-events"
echo 'Fast reads bypass bulk/repository locks and stream previews'
