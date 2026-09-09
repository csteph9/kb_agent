#!/bin/bash
# Install the shared Codex controller and Telegram worktree isolation together.
set -euo pipefail
umask 077
[[ "$EUID" -eq 0 ]] || { echo 'Run with sudo bash deploy-codex.sh'; exit 1; }
SOURCE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP=/opt/knowledge-agent
[[ "$SOURCE" != "$APP" && -f "$APP/.env" ]] || { echo 'Use a separate checkout and an existing KB installation'; exit 1; }
FILES=(bot.js intent-classifier.js run-codex.sh run-ingest-write.sh run-codex-call.sh codex-control.js)
for file in "${FILES[@]}"; do
  [[ -f "$SOURCE/$file" ]] || { echo "Missing $file"; exit 1; }
  case "$file" in *.js) node --check "$SOURCE/$file" ;; *.sh) bash -n "$SOURCE/$file" ;; esac
done
command -v flock >/dev/null
command -v timeout >/dev/null
id knowledge >/dev/null
# Honor the same repository lock override used by the updated runners.
LOCK="$(cd "$APP" && runuser -u knowledge -- node --input-type=module -e "import dotenv from 'dotenv'; dotenv.config({path:'.env',quiet:true}); console.log(process.env.KNOWLEDGE_REPO_LOCK || '/tmp/knowledge-repo.lock');")"
[[ "$LOCK" == /* ]] || { echo 'Repository lock path must be absolute'; exit 1; }
BOT_ACTIVE=0
TIMER_ACTIVE=0
systemctl is-active --quiet knowledge-agent.service && BOT_ACTIVE=1
systemctl is-active --quiet knowledge-ingest.timer && TIMER_ACTIVE=1
restore() {
  flock -u 9 2>/dev/null || true
  if [[ "$BOT_ACTIVE" == 1 ]]; then systemctl start knowledge-agent.service; fi
  if [[ "$TIMER_ACTIVE" == 1 ]]; then systemctl start knowledge-ingest.timer; fi
}
trap restore EXIT
systemctl stop knowledge-ingest.timer
echo 'Waiting up to 20 minutes for the current KB transaction to finish...'
# fs.protected_regular can reject root's O_CREAT open of a knowledge-owned
# file in sticky /tmp. Create as its owner, then take flock on a read-only FD.
runuser -u knowledge -- touch -- "$LOCK"
exec 9<"$LOCK"
flock -w 1200 9 || { echo 'KB is still busy. Nothing was installed; retry later.'; exit 1; }
# Once we hold the repository lock, no cooperating writer can be mid-edit.
systemctl stop knowledge-agent.service knowledge-ingest.service
BACKUP="$APP/backups/codex-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP"
for file in "${FILES[@]}"; do
  if [[ -e "$APP/$file" ]]; then cp -a "$APP/$file" "$BACKUP/"; fi
done
install -d -o knowledge -g knowledge -m 700 "$APP/var" "$APP/var/codex"
for file in "${FILES[@]}"; do
  mode=644
  [[ "$file" != *.sh ]] || mode=755
  install -o knowledge -g knowledge -m "$mode" "$SOURCE/$file" "$APP/$file"
done
echo "Codex controls deployed. Previous application files: $BACKUP"
echo 'Previously active agent/timer will restart. Existing .env and sessions are preserved.'
