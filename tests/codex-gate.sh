#!/bin/bash
set -euo pipefail
APP="$(cd -- "$(dirname -- "$0")/.." && pwd)"
TEMP="$(mktemp -d)"
trap 'rm -rf -- "$TEMP"' EXIT
export CODEX_CONTROL_DIR="$TEMP/control" CODEX_MIN_GAP_SECONDS=1
export CODEX_CALL_TIMEOUT_SECONDS=10 CODEX_QUEUE_TIMEOUT_SECONDS=10 TEST_GATE="$TEMP"
mkdir "$TEMP/bin"
export PATH="$TEMP/bin:$PATH"
cat >"$TEMP/bin/codex" <<'MOCK'
#!/bin/bash
set -euo pipefail
mkdir "$TEST_GATE/active" || { echo overlap >"$TEST_GATE/overlap"; exit 1; }
cat >/dev/null
date +%s%3N >>"$TEST_GATE/starts"
sleep 0.2
rmdir "$TEST_GATE/active"
echo '{"type":"turn.completed"}'
MOCK
chmod +x "$TEMP/bin/codex"
bash "$APP/run-codex-call.sh" exec --json - </dev/null >"$TEMP/one" &
first=$!
bash "$APP/run-codex-call.sh" exec --json - </dev/null >"$TEMP/two" &
second=$!
wait "$first"
wait "$second"
[[ ! -f "$TEMP/overlap" ]]
mapfile -t starts <"$TEMP/starts"
[[ "${#starts[@]}" == 2 ]]
((starts[1] - starts[0] >= 1000))
# Queue acquisition itself is bounded and starts no extra model.
flock "$CODEX_CONTROL_DIR/call.lock" sleep 3 &
holder=$!
sleep 0.2
set +e
CODEX_QUEUE_TIMEOUT_SECONDS=1 bash "$APP/run-codex-call.sh" exec --json - </dev/null
code=$?
set -e
wait "$holder"
[[ "$code" == 75 && "$(wc -l <"$TEMP/starts")" == 2 ]]
echo 'Real flock concurrency and pacing tests passed'
