#!/bin/bash
set -euo pipefail
APP="$(cd -- "$(dirname -- "$0")/.." && pwd)"
TEMP="$(mktemp -d)"
trap 'rm -rf -- "$TEMP"' EXIT
export KNOWLEDGE_REPO="$TEMP/repo" KNOWLEDGE_REPO_LOCK="$TEMP/repo.lock"
export KNOWLEDGE_SYNC_SCRIPT="$TEMP/bin/sync" CODEX_CONTROL_DIR="$TEMP/control"
export CODEX_MIN_GAP_SECONDS=0 CODEX_RETRY_BASE_SECONDS=1 CODEX_RETRY_JITTER_SECONDS=0
export TEST_COUNTER="$TEMP/calls" TEST_WORK="$TEMP/workpath"
mkdir -p "$KNOWLEDGE_REPO" "$TEMP/bin"
export PATH="$TEMP/bin:$PATH"
cat >"$TEMP/bin/codex" <<'MOCK'
#!/bin/bash
set -euo pipefail
output=''
while [[ $# -gt 0 ]]; do
  case "$1" in -C) shift; cd "$1" ;; -o) shift; output="$1" ;; esac
  shift
done
[[ "$PWD" != "$KNOWLEDGE_REPO" ]]
printf '%s\n' "$PWD" >"$TEST_WORK"
cat >/dev/null
echo run >>"$TEST_COUNTER"
count="$(wc -l <"$TEST_COUNTER")"
echo "{\"type\":\"thread.started\",\"thread_id\":\"thread-$count\"}"
if [[ "${TEST_MODE:-ok}" == transient && "$count" == 1 ]]; then
  echo '{"type":"turn.failed","error":{"message":"at capacity"}}'
  exit 1
fi
echo '{"type":"item.started","item":{"type":"command_execution"}}'
case "${TEST_MODE:-ok}" in
  fail) echo partial >fact.md; echo '{"type":"turn.failed","error":{"message":"at capacity"}}'; exit 1 ;;
  timeout) echo partial >fact.md; sleep 10 ;;
  protected) echo changed >AGENTS.md ;;
  move-policy) mv AGENTS.md moved.md ;;
  binary) echo data >file.bin ;;
  symlink) ln -s AGENTS.md link.md ;;
  commit) echo data >fact.md; git add .; git -c core.hooksPath=/dev/null commit -qm 'model commit' ;;
  noop) ;;
  *) echo "fact $count" >fact.md ;;
esac
echo 'Test response' >"$output"
echo '{"type":"turn.completed"}'
MOCK
cat >"$TEMP/bin/sync" <<'MOCK'
#!/bin/bash
if [[ "${TEST_PUSH_FAILURE:-0}" == 1 && "$(git rev-parse HEAD)" != "$TEST_PUSH_BASE" ]]; then exit 1; fi
exit 0
MOCK
chmod +x "$TEMP/bin/"*
git -C "$KNOWLEDGE_REPO" init -q
git -C "$KNOWLEDGE_REPO" config user.name Test
git -C "$KNOWLEDGE_REPO" config user.email test@example.org
git -C "$KNOWLEDGE_REPO" config core.autocrlf false
echo 'Keep policy' >"$KNOWLEDGE_REPO/AGENTS.md"
git -C "$KNOWLEDGE_REPO" add .
git -C "$KNOWLEDGE_REPO" commit -qm initial
run() { bash "$APP/run-codex.sh" "$TEMP/answer" "${TEST_SESSION:-}" '' "$TEMP/events" "${1:-WRITE}" <<<'Test request'; }
assert_clean() {
  [[ -z "$(git -C "$KNOWLEDGE_REPO" status --porcelain)" ]]
  [[ "$(git -C "$KNOWLEDGE_REPO" worktree list --porcelain | grep -c '^worktree ')" == 1 ]]
  [[ ! -e "$(cat "$TEST_WORK")" ]]
}
for mode in fail protected move-policy binary symlink commit; do
  export TEST_MODE="$mode"
  if run; then echo "Unexpected success: $mode"; exit 1; fi
  assert_clean
  [[ ! -e "$KNOWLEDGE_REPO/fact.md" ]]
  [[ "$(cat "$KNOWLEDGE_REPO/AGENTS.md")" == 'Keep policy' ]]
  # Remove only this test's pacing state, under no active calls.
  rm -f "$CODEX_CONTROL_DIR/pacing.json"
done
[[ "$(wc -l <"$TEST_COUNTER")" == 6 ]] # Partial tool failure was NOT retried.
export TEST_MODE=ok
run READ
assert_clean
[[ ! -e "$KNOWLEDGE_REPO/fact.md" ]]
export TEST_SESSION=existing-thread
run WRITE
assert_clean
[[ -f "$KNOWLEDGE_REPO/fact.md" ]]
[[ "$(cat "$TEMP/answer")" == 'Test response' ]]
grep -q thread-8 "$TEMP/events"
# Failed push commits once and reports code 2, without rerunning Codex.
export TEST_PUSH_FAILURE=1 TEST_PUSH_BASE="$(git -C "$KNOWLEDGE_REPO" rev-parse HEAD)"
set +e
run WRITE
code=$?
set -e
[[ "$code" == 2 ]]
assert_clean
export TEST_PUSH_FAILURE=0
# Preserve unrelated edits; refuse without calling the model.
echo 'Manual edit' >"$KNOWLEDGE_REPO/manual.md"
before="$(wc -l <"$TEST_COUNTER")"
set +e
run READ
code=$?
set -e
[[ "$code" == 73 && "$(cat "$KNOWLEDGE_REPO/manual.md")" == 'Manual edit' ]]
[[ "$(wc -l <"$TEST_COUNTER")" == "$before" ]]
rm "$KNOWLEDGE_REPO/manual.md"
# Retry before tools retains only the successful attempt's session event.
: >"$TEST_COUNTER"
export TEST_MODE=transient TEST_SESSION=''
run WRITE
grep -q thread-2 "$TEMP/events"
! grep -q thread-1 "$TEMP/events"
assert_clean
export TEST_MODE=timeout CODEX_CALL_TIMEOUT_SECONDS=1
set +e
run WRITE
code=$?
set -e
[[ "$code" == 124 || "$code" == 137 ]]
assert_clean
echo 'Telegram worktree integration tests passed'
