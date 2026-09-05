#!/bin/bash
set -euo pipefail
APP="$(cd -- "$(dirname -- "$0")/.." && pwd)"
TEMP="$(mktemp -d)"
trap 'rm -rf -- "$TEMP"' EXIT
export KNOWLEDGE_REPO="$TEMP/repo"
export KNOWLEDGE_REPO_LOCK="$TEMP/repo.lock"
export KNOWLEDGE_SYNC_SCRIPT="$TEMP/bin/sync"
export TEST_COUNTER="$TEMP/counter"
mkdir -p "$KNOWLEDGE_REPO" "$TEMP/bin"
export PATH="$TEMP/bin:$PATH"
# Git Bash has no flock. Stub only for serial transaction tests; Linux exercises real flock.
if ! command -v flock >/dev/null; then
  printf '#!/bin/bash\nexit 0\n' >"$TEMP/bin/flock"
fi
cat >"$TEMP/bin/codex" <<'MOCK'
#!/bin/bash
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-C" ]]; then shift; cd "$1"; fi
  shift
done
printf 'run\n' >>"$TEST_COUNTER"
case "${TEST_MODE:-ok}" in
  fail) echo 'partial change' >fact.md; exit 1 ;;
  protected) echo 'changed rules' >AGENTS.md ;;
  move-policy) mv AGENTS.md moved.md ;;
  noop) ;;
  *) echo 'Durable knowledge' >fact.md ;;
esac
MOCK
cat >"$TEMP/bin/sync" <<'MOCK'
#!/bin/bash
if [[ "${TEST_PUSH_FAILURE:-0}" == 1 ]] && git log --format=%B -1 | grep -q Knowledge-Ingest-Job; then exit 1; fi
exit 0
MOCK
chmod +x "$TEMP/bin/"*
git -C "$KNOWLEDGE_REPO" init -q
git -C "$KNOWLEDGE_REPO" config user.email test@example.org
git -C "$KNOWLEDGE_REPO" config user.name Test
git -C "$KNOWLEDGE_REPO" config core.autocrlf false
echo 'Preserve KB policy' >"$KNOWLEDGE_REPO/AGENTS.md"
git -C "$KNOWLEDGE_REPO" add .
git -C "$KNOWLEDGE_REPO" commit -qm initial
echo 'Test source' >"$TEMP/prompt"
job1="$(printf '%064d' 1)"
job2="$(printf '%064d' 2)"
job3="$(printf '%064d' 3)"
job4="$(printf '%064d' 4)"
export TEST_MODE=fail
if bash "$APP/run-ingest-write.sh" "$TEMP/prompt" "$job1"; then echo 'Failed model unexpectedly succeeded'; exit 1; fi
[[ -z "$(git -C "$KNOWLEDGE_REPO" status --porcelain)" ]]
[[ ! -f "$KNOWLEDGE_REPO/fact.md" ]]
export TEST_MODE=protected
if bash "$APP/run-ingest-write.sh" "$TEMP/prompt" "$job2"; then echo 'Policy change unexpectedly succeeded'; exit 1; fi
[[ "$(cat "$KNOWLEDGE_REPO/AGENTS.md")" == 'Preserve KB policy' ]]
export TEST_MODE=move-policy
if bash "$APP/run-ingest-write.sh" "$TEMP/prompt" "$job2"; then echo 'Policy rename unexpectedly succeeded'; exit 1; fi
[[ "$(cat "$KNOWLEDGE_REPO/AGENTS.md")" == 'Preserve KB policy' ]]
export TEST_MODE=ok TEST_PUSH_FAILURE=1
set +e
bash "$APP/run-ingest-write.sh" "$TEMP/prompt" "$job3"
code=$?
set -e
[[ "$code" == 2 ]]
[[ -f "$KNOWLEDGE_REPO/fact.md" ]]
before="$(wc -l <"$TEST_COUNTER")"
export TEST_PUSH_FAILURE=0
bash "$APP/run-ingest-write.sh" "$TEMP/prompt" "$job3"
[[ "$(wc -l <"$TEST_COUNTER")" == "$before" ]]
export TEST_MODE=noop
bash "$APP/run-ingest-write.sh" "$TEMP/prompt" "$job4"
git -C "$KNOWLEDGE_REPO" log -1 --format=%B | grep -q "$job4"
[[ -z "$(git -C "$KNOWLEDGE_REPO" status --porcelain)" ]]
echo 'Transaction integration tests passed'