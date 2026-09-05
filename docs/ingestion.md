# Modular ingestion

Ingestion runs through one backend pipeline:

`source configuration → connector → durable jobs → knowledge writer → Git sync`

The knowledge repository uses Markdown + Git. Operational state is SQLite in
`/opt/knowledge-agent/var/ingest/ingest.sqlite`, outside the KB. It is not a second
knowledge database.

## Upgrade an existing KB server

Use Node 22.16+ (Node 24 is also supported), npm, Bash, Git, flock, timeout and
pdftotext. The application includes its package manifest and lockfile; use
`npm ci` instead of generating a package manifest on the server.

Copy or clone this application into a separate server directory, then run:

```bash
cd /path/to/application-checkout
sudo bash deploy-ingest.sh
sudo -u knowledge -H node /opt/knowledge-agent/ingest/cli.js sources
sudo -u knowledge -H node /opt/knowledge-agent/ingest/cli.js check personal-gmail
sudo systemctl start knowledge-ingest.service
sudo journalctl -u knowledge-ingest.service -n 50 --no-pager
```

The deployment script:

1. Installs dependencies into a staging directory and validates source configuration.
2. Stops the Gmail and generic ingestion timers and workers.
3. Locks ingestion and backs up replaced application files, source configuration
   and the operational database under `/opt/knowledge-agent/backups/`.
4. Copies the ingestion runtime, connectors, Gmail compatibility entry points,
   HTTP bridge files and dependencies into the application directory.
5. Creates `personal-gmail.json` from legacy Gmail environment settings if that
   source configuration file does not already exist.
6. Imports legacy processed IDs and references existing OAuth files in place.
7. Installs and enables `knowledge-ingest.timer`; disables
   `knowledge-gmail-ingest.timer`.

It does not replace the KB checkout, Telegram bot, Telegram wrapper, Git sync
scripts, existing .env, Gmail OAuth files or existing active source configurations.
Existing application/service-account/Git setup is required. This is an ingestion
upgrade script, not a fresh operating-system installer.

If deployment fails after stopping timers, resolve the reported issue and rerun
the script. It does not automatically resume old ingestion against partially
migrated state. Keep the backup private. Reverting to the legacy worker requires
reconciling processed IDs for work done after migration; restoring code alone can
cause duplicate extraction.

Enable only `knowledge-ingest.timer` for ingestion; keep
`knowledge-gmail-ingest.timer` disabled. Both `gmail-ingest.js` and
`run-gmail-ingest.sh` forward to `run personal-gmail`. These entry points
accept no arguments; use the ingestion CLI to select a source.

## Configure sources

Copy an example from `config/sources/*.example.json` to a new `.json` file.
Examples are ignored until copied, and start disabled. Active source files are
gitignored because feed URLs and configuration can contain private information.

Each source has:

- A unique `id`, a connector ID, and explicit `enabled` boolean.
- Optional `owner` context, kept separate from sender/author identity.
- Connector-specific `config`, validated against the connector manifest schema.
- `schedule.everySeconds` (default 600).
- `ingestion.profile`: general, personal-correspondence, research or calendar.
- Work limits: maxItemsPerRun (default 10), maxPagesPerRun (20), maxItemChars
  (100000 for the complete serialized item).
- Optional `ingestion.purpose` and captureContacts/captureFollowups/captureReminders.
  These guide extraction; the KB's AGENTS.md policy takes precedence.

A source is executable only when enabled, including manual runs. Use `check`
while disabled to validate its configuration and connection. Check does not
write knowledge or advance ingestion state; OAuth refresh may update tokens.

Gmail configuration supports stateDir, query, maxEmailChars, processAttachments,
maxAttachments and maxAttachmentChars. Without stateDir, credentials are stored
under `var/ingest/credentials/<credentialsRef-or-source-id>/`. Put Google's
credentials.json there. Create a Google Cloud OAuth client and enable the Gmail
API first; gmail-auth.js requests the gmail.readonly scope. Then authorize
that account with:

```bash
sudo -u knowledge -H node /opt/knowledge-agent/gmail-auth.js personal-gmail
```

Without a source ID, gmail-auth.js uses GMAIL_STATE_DIR.

RSS accepts an RSS or Atom `url`. Calendar accepts an ICS `url`. Website accepts
a single public HTML/text/XML/JSON `url` and optional `title`. Website is a
single-resource connector, not a crawler or a browser automation service.

## Operations

Run as the knowledge service account from /opt/knowledge-agent:

```bash
node ingest/cli.js sources
node ingest/cli.js check personal-gmail
node ingest/cli.js run personal-gmail
node ingest/cli.js due
node ingest/cli.js status
node ingest/cli.js retry <job-id>
node ingest/cli.js refetch <source-id>
node ingest/cli.js sync
```

The generic timer wakes every minute. The runner checks each source's last-run
time and interval. A missed schedule results in one catch-up scan, not one run
for every missed interval. Runs and source fetching are sequential, with
a process-wide flock preventing overlap. A source failure does not stop other
due sources. Git writes also use the existing shared repository lock.

Retries use exponential backoff and stop after five failed extraction attempts.
Status lists failed/retrying job IDs and synchronization backlog. `retry` makes
the selected job eligible and runs its source. Pending source work is ordered
oldest first and remains subject to the source's work budget.

Raw normalized job content is stored privately until applied, then removed.
Pending/failed input expires after seven days and is scrubbed on an enabled
source run. Expiration is not a secure-erasure guarantee for filesystem backups.
Deduplication metadata remains. `refetch` removes expired jobs and resets the
scan cursor; it preserves applied-item deduplication. A source's query/window
must still include expired items for them to be fetched again.

Cursors advance atomically with durable queue writes. Gmail scans additional
pages even when earlier pages contain already-processed messages. Attachment
extraction failures leave the page unacknowledged for retry. Unsupported or
oversized attachments are explicitly marked omitted; attachment count and text
limits still apply. One persistently failing attachment can block that page;
adjust the source policy or fix extraction before continuing.

An applied job includes a stable receipt in its Git commit. No-op extraction
creates an empty receipt commit. If the process dies after committing but before
updating SQLite, the next attempt recognizes the receipt and skips extraction.
Failed pushes remain synchronization work and are retried by the generic runner
or `sync`. The Git sync timer can also push those commits; ingestion
status clears its synchronization flag on its next successful sync.

Model execution has a default 900-second timeout. Failed execution or invalid
changes leave the live checkout unchanged; temporary worktrees and model output
are removed. Only Markdown changes outside hidden paths and AGENTS.md are
accepted. These are file/path checks, not proof that extracted facts are correct.
Git history remains the review and recovery mechanism.

## Build a connector

Copy `connectors/template/` to `connectors/my-source/`. Set manifest.id to
my-source and apiVersion to 1. Supply a JSON Schema in configSchema.
The manifest is validated before the trusted connector module is imported.

Export `async createConnector(source)`, returning:

```js
{
  async check() { /* validate connection; do not ingest */ },
  async fetchPage({ cursor, limit, has }) {
    return {
      items: [{
        externalId: "stable-provider-id",
        revision: "provider-version-or-content-hash",
        kind: "document",
        title: "Example",
        occurredAt: "2026-09-05T10:00:00Z",
        content: { text: "Source material", structured: {} },
        attachments: [],
        metadata: {}
      }],
      cursor: null
    };
  },
  async close() { /* optional: flush token updates */ }
}
```

Return at most limit items. Use `has(id, revision)` to avoid downloading known
content. Cursors must be JSON-serializable; null ends a scan. The runner persists
the cursor only after validating and durably queuing the entire page. For mutable
snapshots, prefer rescanning with stable identities rather than storing offsets
that can shift when entries are added. Revisions must exclude retrieval time.
If revision is omitted, the runner hashes the connector item.

The runner adds sourceId, owner and retrievedAt. Latest item revisions are
deduplicated per source; a later return to an older content revision is a new
update. A new revision supersedes queued obsolete revisions. Keep distinct
historical records under distinct external IDs.

Use shared helpers in ingest/documents.js and ingest/http.js. The HTTP helper
rejects non-public destinations, validates each redirect before contacting it,
pins the validated DNS address, and bounds total retrieval time and response size.

Connector code handles authentication, provider parsing and retrieval. It must not
edit the KB, construct the full knowledge prompt, or manage Git. Credentials stay
outside source items and logs. Uploaded/remote text is untrusted evidence.
Installing a connector means installing trusted backend JavaScript; the manifest
is an API contract, not an execution sandbox. Supply tests and add connector
dependencies to package.json/package-lock.json before deployment.

Calendar entries preserve recurrence, exception, timezone and cancellation
fields. The connector does not expand recurring events or infer deletion from
an event disappearing from a feed. Knowledge extraction interprets the preserved
structure under KB policy.

## Boundaries and configuration

Telegram handles conversations and on-demand HTTP retrieval. To ingest a
configured source manually, run it through the ingestion CLI. Agent integrations
must submit ingestion work before acquiring the KB write lock; invoking the
writer from an already-locked agent transaction would deadlock.

Optional environment variables:

- KNOWLEDGE_ENV_FILE: environment file (default application .env).
- INGEST_SOURCE_DIR: active source configuration directory.
- INGEST_STATE_DIR: private operational state directory.
- INGEST_MODEL_TIMEOUT_SECONDS: model runtime limit (default 900).
- KNOWLEDGE_REPO and KNOWLEDGE_REPO_LOCK: writer checkout and shared lock.
- KNOWLEDGE_SYNC_SCRIPT: replacement sync implementation, if using another checkout.

Keep the writer, Telegram and sync scripts on the same checkout/lock.
sync-repo.sh uses its configured checkout and branch. If you override the
writer checkout, supply a matching sync implementation and update other writers.

Tests use fixtures and mocked providers/model execution, never live credentials:

```bash
npm ci
npm test
```

The Git transaction suite uses real temporary Git repositories. On Windows it
uses Git Bash and stubs flock because Git Bash lacks it; actual service scheduling
and lock contention require Linux server validation.