# Codex pacing and Telegram recovery

Telegram requests, daily reminders, intent classification, and ingestion all
use `run-codex-call.sh`. Bulk writes and background work use
`var/codex/call.lock`; READ answers and classification use the separate
`var/codex/interactive/call.lock`. Each lane runs at most one model process and
has its own pacing/cooldown state. A background sync cannot hold the interactive
slot. Provider quotas remain shared, and server retry hints still apply.

Defaults:

| Setting | Default | Purpose |
| --- | --- | --- |
| `CODEX_MIN_GAP_SECONDS` | 1 | Wait after the previous CLI call finishes before starting another |
| `CODEX_MAX_ATTEMPTS` | 3 | At most three CLI launches for one request |
| `CODEX_RETRY_BASE_SECONDS` | 30 | First transient retry delay |
| `CODEX_RETRY_MAX_SECONDS` | 120 | Cap on exponential delay, excluding server hints |
| `CODEX_RETRY_JITTER_SECONDS` | 5 | Add up to five seconds to spread retries |
| `CODEX_FAILURE_COOLDOWN_SECONDS` | 120 | Shared cooldown after exhausted or unsafe-to-replay transient failure |
| `CODEX_QUEUE_TIMEOUT_SECONDS` | 300 | Maximum wait to acquire each execution/repository lock |
| `CODEX_CALL_TIMEOUT_SECONDS` | 900 | Total call budget after acquiring the execution lock, including pacing and retries |
| `CODEX_CLASSIFIER_TIMEOUT_SECONDS` | 120 | Shorter call budget for intent classification |
| `CODEX_READ_QUEUE_TIMEOUT_SECONDS` | 10 | Interactive lane lock wait |
| `CODEX_READ_TIMEOUT_SECONDS` | 60 | Answer/classifier budget; one CLI attempt per interactive request |
| `INGEST_MODEL_TIMEOUT_SECONDS` | inherits call budget | Optional ingestion-specific override |
| `CODEX_CONTROL_DIR` | `/opt/knowledge-agent/var/codex` | Base state directory; all services must use the same base directory |

Put overrides in the existing `.env`, then restart `knowledge-agent.service`.
New ingestion service runs reload the environment. These are conservative
application defaults, not published OpenAI account limits.

Capacity/overload and temporary rate-limit errors can retry with 30-second,
then 60-second delays plus jitter. An exposed `Retry-After` hint is a minimum;
if it exceeds the remaining budget, the request defers without an early retry.
Quota, billing, authentication, context-size and unknown errors do not retry.
Interactive requests make one attempt. Their inherited cooldown can defer later
reads if the provider is unavailable; separate scheduling does not bypass rate
limits. `CODEX_READ_TIMEOUT_SECONDS` overrides the generic/classifier timeout in
the interactive lane.
The CLI's own internal retries may also run, but the outer timeout bounds the
whole CLI operation. A single CLI process may still make multiple API calls.
Calls outside these application wrappers are not covered by this gate.

Application calls set `features.multi_agent=false` so research runs cannot use
Codex's subagent tools to fan out requests. This does not rate-limit individual
HTTP requests or hosted tools inside a Codex turn and cannot prevent a general
provider capacity outage. READ answers and ambiguous intent classification are
pinned to `gpt-5.6-luna` with low reasoning. WRITE operations and ingestion are
pinned to `gpt-5.6-sol` with medium reasoning. High-confidence requests are
classified locally; Luna is used only when the wording is ambiguous. Conflicting
model arguments are rejected rather than overriding the application-selected pin.

Retries examine JSON error events rather than matching agent prose. Once any
tool may have run, the controller will not automatically replay the whole
turn, since tools can have external side effects. The ingestion queue may
later retry a failed KB-only extraction through its existing job mechanism.
Ambiguous requests stop on classifier CLI failure instead of falling back to
another immediate Codex call. That classifier runs in an empty read-only
directory, without KB access. Text requests receive an immediate `Searching...`
or `Updating...` placeholder for locally classified requests. Ambiguous requests
show `Working...` until Luna resolves the intent. The placeholder is then replaced
with the completed answer or error message.

## Fast KB reads

Authorized Telegram updates are dispatched concurrently rather than holding the
long-poll loop until model completion. Up to 32 handlers can be active, while
application queues and model locks bound expensive work. Updates are saved in
the session directory's `pending-updates/` before dispatch, removed after handler
completion, and replayed on startup if the process stopped in flight. This is
at-least-once recovery, not a guarantee against duplicate external deliveries.
Writes retain the application write queue; READ requests are ordered per user
and bypass that queue. Ambiguous classification uses the interactive lane.

READ requests use `git archive` of the current committed HEAD, without acquiring
the repository transaction lock or modifying Git worktree metadata. They can
answer while a write is running, including when the live checkout is dirty.
They see the last committed revision, not unfinished edits. The CLI uses a
read-only sandbox, a fresh ephemeral session and no Calendar mutation tools.

Scheduled morning briefings pass the `morning` purpose to `run-codex.sh` and
use the bulk lane and its longer call budget. Their sandbox allows writes to
the disposable snapshot and `/tmp/knowledge-http`, so the HTTP bridge can
retrieve weather and RSS feeds. Direct network access remains disabled and
snapshot edits are discarded. The live KB is never a writable sandbox root.

`read-context.js` builds a local passage index keyed by commit revision and
prepends ranked passages with KB paths/line numbers. The complete snapshot and
policy files remain available for broader searches when retrieval is insufficient.
Two revisions of the index are retained under `var/codex/read-index/`, with private
directory/file permissions. This cache contains KB text; it is operational state
outside Git and can be deleted to force a rebuild.

The bot retains four completed exchanges per user in memory so read follow-ups
can resolve references without resuming a write's active thread. Completed read
context is also supplied to subsequent writes. Context is bounded and resets on
bot restart or `/new`; write-thread sessions remain persisted as before.
An in-memory answer cache lasts at most 30 seconds and is keyed by user identity,
KB revision, request, conversation context, reset generation and minute. KB
commits, context changes and `/new` invalidate reuse. Image requests and prompts
explicitly asking for live/time-sensitive information bypass answer caching.

Completed model messages are forwarded as Telegram previews before process exit;
the CLI exposes message events rather than token-by-token deltas. The final
response/error replaces the preview. Cached repeats skip model execution. New
answers still take model/search time, so subsecond responses are not guaranteed.

## Telegram writes

New and resumed WRITE sessions execute in a temporary detached Git worktree.
The current worktree and sandbox are explicitly selected on each invocation.
Successful WRITE requests validate Markdown changes, reject policy/hidden-file
edits, symlinks, non-Markdown files and model-created commits, then fast-forward
the live KB. Failed/timeout WRITE runs are discarded with the worktree.
Existing dirty live repositories are preserved and refused, never reset.
GitHub push failure reports that the update was saved locally; it does not
automatically rerun the task. Successful conversation IDs are preserved.

This changes the application transaction boundary; it is not an OS security
boundary against arbitrary trusted tools configured outside the sandbox.
The repository lock serializes writes. Reads use immutable snapshots and do not
hold or wait for this lock.

## Upgrade the existing server

From the separate application checkout, after transferring these updated files:

```bash
sudo bash deploy-codex.sh
sudo systemctl status knowledge-agent.service knowledge-ingest.timer --no-pager
sudo journalctl -u knowledge-agent.service -u knowledge-ingest.service -n 80 --no-pager
```

The deployment validates scripts, pauses the ingestion timer, waits for the
current repository transaction, stops the workers, backs up the changed
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
On Linux it also exercises real flock contention and pacing, reads completing
while bulk and repository locks are held, streaming previews, temporary-worktree
failure/timeout cleanup, resumed requests, protected paths, and failed pushes.
All Codex calls in these tests are stubs; tests do not call OpenAI.

References: [OpenAI retry guidance](https://developers.openai.com/api/docs/guides/rate-limits),
[Codex JSON events](https://learn.chatgpt.com/docs/non-interactive-mode),
[multi-agent configuration](https://learn.chatgpt.com/docs/config-file/config-reference).
