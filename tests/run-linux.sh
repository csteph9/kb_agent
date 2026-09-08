#!/bin/bash
# Optional development harness for a machine without a system Node runtime.
# Usage: bash tests/run-linux.sh /path/to/node-v22.16.0-linux-x64.tar.xz
# Runs ONLY mocked Codex tests. No OpenAI credentials or API calls are used.
set -euo pipefail
APP="$(cd -- "$(dirname -- "$0")/.." && pwd)"
ARCHIVE="${1:?Supply the official Linux x64 Node archive}"
TEMP="$(mktemp -d /tmp/kb-agent-tests.XXXXXX)"
trap 'rm -rf -- "$TEMP"' EXIT
mkdir "$TEMP/node" "$TEMP/app"
if [[ -d "$ARCHIVE" ]]; then
  cp -R "$ARCHIVE/." "$TEMP/node/"
else
  tar -xf "$ARCHIVE" --strip-components=1 -C "$TEMP/node"
fi
export PATH="$TEMP/node/bin:$PATH"
cp "$APP/"*.js "$APP/"*.sh "$APP/package.json" "$APP/package-lock.json" "$TEMP/app/"
cp -R "$APP/ingest" "$APP/connectors" "$APP/config" "$APP/tests" "$TEMP/app/"
# Existing Windows checkouts may have CRLF despite repository attributes.
find "$TEMP/app" -name '*.sh' -exec sed -i 's/\r$//' {} +
cd "$TEMP/app"
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
node --check bot.js
node --check codex-control.js
for script in ./*.sh; do bash -n "$script"; done
npm test
