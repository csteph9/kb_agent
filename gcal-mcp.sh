#!/bin/bash
set -euo pipefail
APP="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec /usr/bin/node "$APP/gcal-mcp.js"
