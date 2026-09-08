# Codex pacing and Telegram recovery

Telegram requests, daily reminders, intent classification, and ingestion all
use `run-codex-call.sh`. It holds one process-wide `flock` shared across services
in `var/codex/call.lock`. `codex-control.js` stores only the next permitted start
time in `var/codex/pacing.json`; no prompts or credentials are stored there.

Defaults:

| Setting | Default | Purpose |
| --- | --- | --- |
| `CODEX_MIN_GAP_SECONDS` | 10 | Wait after the previous CLI call finishes before starting another |
| `CODEX_MAX_ATTEMPTS` | 3 | At most three CLI launches for one request |
| `CODEX_RETRY_BASE_SECONDS` | 30 | First transient retry delay |
| `CODEX_RETRY_MAX_SECONDS` | 120 | Cap on exponential delay, excluding server hints |
| `CODEX_RETRY_JITTER_SECONDS` | 5 | Add up to five seconds to spread retries |
| `CODEX_FAILURE_COOLDOWN_SECONDS` | 120 | Shared cooldown after exhausted or unsafe-to-replay transient failure |
| `CODEX_QUEUE_TIMEOUT_SECONDS` | 300 | Maximum wait to acquire each execution/repository lock |
| `CODEX_CALL_TIMEOUT_SECONDS` | 900 | Total call budget after acquiring the execution lock, including pacing and retries |
| `CODEX_CLASSIFIER_TIMEOUT_SECONDS` | 120 | Shorter call budget for intent classification |
| `INGEST_MODEL_TIMEOUT_SECONDS` | inherits call budget | Optional ingestion-specific override |
| `CODEX_CONTROL_DIR` | `/opt/knowledge-agent/var/codex` | Shared state directory; all services must use the same directory |

Put overrides in the existing `.env`, then restart `knowledge-agent.service`.
New ingestion service runs reload the environment. These are conservative
application defaults, not published OpenAI account limits.

Capacity/overload and temporary rate-limit errors can retry with 30-second,
then 60-second delays plus jitter. An exposed `Retry-After` hint is a minimum;
if it exceeds the remaining budget, the request defers without an early retry.
Quota, billing, authentication, context-size and unknown errors do not retry.
The CLI's own internal retries may also run, but the outer timeout bounds the
whole CLI operation. A single CLI process may still make multiple API calls.
Calls outside these application wrappers are not covered by this gate.

Application calls set `features.multi_agent=false` so research runs cannot use
Codex's subagent tools to fan out requests. This does not rate-limit individual
HTTP requests or hosted tools inside a Codex turn and cannot prevent a general
provider capacity outage. No model or account selection is changed.

Retries examine JSON error events rather than matching agent prose. Once any
tool may have run, the controller will not automatically replay the whole
turn, since tools can have external side effects. The ingestion queue may
later retry a failed KB-only extraction through its existing job mechanism.
The classifier now stops on CLI failure instead of falling back to another
immediate Codex call. It runs in an empty read-only directory, without KB access.

## Telegram transactions

Both new and resumed sessions execute in a temporary detached Git worktree.
The current worktree and sandbox are explicitly selected on each invocation.
Successful WRITE requests validate Markdown changes, reject policy/hidden-file
edits, symlinks, non-Markdown files and model-created commits, then fast-forward
the live KB. READ edits and failed/timeout runs are discarded with the worktree.
Existing dirty live repositories are preserved and refused, never reset.
GitHub push failure reports that the update was saved locally; it does not
automatically rerun the task. Successful conversation IDs are preserved.

This changes the application transaction boundary; it is not an OS security
boundary against arbitrary trusted tools configured outside the sandbox.
The existing repository lock still serializes KB transactions. A long call
can keep another caller waiting; each lock has a bounded wait.

## Upgrade the existing server

From the separate application checkout, after transferring these updated files:

```bash
sudo bash deploy-codex.sh
sudo systemctl status knowledge-agent.service knowledge-ingest.timer --no-pager
sudo journalctl -u knowledge-agent.service -u knowledge-ingest.service -n 80 --no-pager
```

The deployment validates scripts, pauses the ingestion timer, waits for the
current repository transaction, stops the workers, backs up the five changed
runtime files, and installs them together. It restores the previously active
agent and timer. It preserves `.env`, OAuth files, sessions, and KB data. If a
copy fails partway through, inspect the backup and rerun; there is no automatic
file rollback. Custom users of a different repository lock must coordinate
their maintenance separately.

`deploy-ingest.sh` also installs the shared controller for future ingestion
updates, but deliberately does not update `bot.js` or `run-codex.sh`. Use
`deploy-codex.sh` for this combined Telegram/ingestion upgrade.

## Verification

`npm test` includes simulated capacity recovery, permanent-error rejection,
server delay handling, cooldown persistence and no-replay-after-tools tests.
On Linux it also exercises real flock contention and pacing, temporary-worktree
failure/timeout cleanup, resumed requests, protected paths, and failed pushes.
All Codex calls in these tests are stubs; tests do not call OpenAI.

References: [OpenAI retry guidance](https://developers.openai.com/api/docs/guides/rate-limits),
[Codex JSON events](https://learn.chatgpt.com/docs/non-interactive-mode),
[multi-agent configuration](https://learn.chatgpt.com/docs/config-file/config-reference).
