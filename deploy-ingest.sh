#!/bin/bash
# Run from a checkout of this application on the existing Linux KB server.
set -euo pipefail
umask 077
[[ "$EUID" -eq 0 ]] || { echo 'Run with sudo bash deploy-ingest.sh'; exit 1; }
SOURCE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP=/opt/knowledge-agent
[[ "$SOURCE" != "$APP" ]] || { echo 'Deploy from a separate application checkout'; exit 1; }
[[ -f "$APP/.env" ]] || { echo 'Existing /opt/knowledge-agent/.env is required; follow README for base server setup first'; exit 1; }
id knowledge >/dev/null
node --input-type=module -e "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(':memory:'); db.close();"
command -v flock >/dev/null
command -v pdftotext >/dev/null
STAGE="$(mktemp -d /opt/knowledge-ingest-stage.XXXXXX)"
trap 'rm -rf -- "$STAGE"' EXIT
FILES=(package.json package-lock.json gmail-auth.js gmail-ingest.js run-gmail-ingest.sh run-ingest-write.sh http-puller-service.js http-puller.js)
for file in "${FILES[@]}"; do install -m 644 "$SOURCE/$file" "$STAGE/$file"; done
cp -R "$SOURCE/ingest" "$SOURCE/connectors" "$STAGE/"
chown -R knowledge:knowledge "$STAGE"
runuser -u knowledge -- bash -c 'cd "$1" && npm ci --omit=dev --ignore-scripts' bash "$STAGE"
STATE_DIR="$(runuser -u knowledge -- env KNOWLEDGE_ENV_FILE="$APP/.env" node --input-type=module -e "await import('file://$STAGE/ingest/config.js'); console.log(process.env.INGEST_STATE_DIR || '$APP/var/ingest');")"
CONFIG_DIR="$(runuser -u knowledge -- env KNOWLEDGE_ENV_FILE="$APP/.env" node --input-type=module -e "await import('file://$STAGE/ingest/config.js'); console.log(process.env.INGEST_SOURCE_DIR || '$APP/config/sources');")"
[[ "$STATE_DIR" == /* && "$CONFIG_DIR" == /* ]] || { echo 'Configured state/source directories must be absolute'; exit 1; }
while IFS= read -r -d '' file; do node --check "$file"; done < <(find "$STAGE/ingest" "$STAGE/connectors" -name '*.js' -print0)
bash -n "$STAGE/run-ingest-write.sh"
# Validate configured sources before stopping services. This imports trusted connectors but makes no API calls.
if [[ -d "$CONFIG_DIR" ]]; then
  runuser -u knowledge -- env KNOWLEDGE_ENV_FILE="$APP/.env" INGEST_SOURCE_DIR="$CONFIG_DIR" node --input-type=module -e \
    "const c=await import('file://$STAGE/ingest/config.js'); const r=await import('file://$STAGE/ingest/registry.js'); for(const s of await c.sources()) await r.loadConnector(s);"
fi
systemctl stop knowledge-gmail-ingest.timer knowledge-ingest.timer 2>/dev/null || true
systemctl stop knowledge-gmail-ingest.service knowledge-ingest.service 2>/dev/null || true
# Wait for any manual ingestion runner as well before backing up operational state.
install -d -o knowledge -g knowledge -m 700 "$APP/var" "$APP/config"
mkdir -p "$STATE_DIR"
exec 8>"$STATE_DIR/runner.lock"
flock -w 300 8
BACKUP="$APP/backups/ingest-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP"
cp -a "$CONFIG_DIR" "$BACKUP/sources" 2>/dev/null || true
for file in "${FILES[@]}" ingest connectors; do
  if [[ -e "$APP/$file" ]]; then cp -a "$APP/$file" "$BACKUP/"; fi
done
if [[ -f "$STATE_DIR/ingest.sqlite" ]]; then cp -a "$STATE_DIR/ingest.sqlite" "$BACKUP/"; fi
for file in "${FILES[@]}"; do install -o knowledge -g knowledge -m 644 "$STAGE/$file" "$APP/$file"; done
cp -a "$STAGE/ingest" "$STAGE/connectors" "$STAGE/node_modules" "$APP/"
chmod 755 "$APP/run-ingest-write.sh" "$APP/run-gmail-ingest.sh"
mkdir -p "$CONFIG_DIR"
cp "$SOURCE"/config/sources/*.example.json "$CONFIG_DIR/"
chown -R knowledge:knowledge "$APP/ingest" "$APP/connectors" "$APP/node_modules" "$CONFIG_DIR" "$STATE_DIR"
chmod 700 "$STATE_DIR" "$CONFIG_DIR"
# Preserve existing source configuration. Legacy OAuth/state files are referenced in place.
if ! runuser -u knowledge -- node --input-type=module -e \
  "const c=await import('file://$APP/ingest/config.js'); process.exit((await c.sources()).some(s => s.id === 'personal-gmail') ? 0 : 1);"; then
  runuser -u knowledge -- env KNOWLEDGE_INGEST_LOCKED=1 node "$APP/ingest/cli.js" migrate-gmail
fi
install -m 644 "$SOURCE/services/knowledge-ingest.service" /etc/systemd/system/
install -m 644 "$SOURCE/services/knowledge-ingest.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl disable knowledge-gmail-ingest.timer 2>/dev/null || true
flock -u 8
systemctl enable --now knowledge-ingest.timer
echo "Ingestion deployed. Application backup: $BACKUP"
echo 'Inspect: sudo -u knowledge node /opt/knowledge-agent/ingest/cli.js status'
echo 'Logs: journalctl -u knowledge-ingest.service -n 50 --no-pager'