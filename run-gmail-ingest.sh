#!/bin/bash

set -u

REPO="/home/knowledge/repo"
LOCK="/tmp/knowledge-repo.lock"
SYNC="/opt/knowledge-agent/sync-repo.sh"
PROMPT_FILE="$1"

cd "$REPO" || {
    echo "$(date -Is) ERROR: Could not enter repository: $REPO" >&2
    exit 1
}

if [ ! -f "$PROMPT_FILE" ]; then
    echo "$(date -Is) ERROR: Gmail ingest prompt file not found: $PROMPT_FILE" >&2
    exit 1
fi

(
    flock -w 300 9 || {
        echo "$(date -Is) ERROR: Could not acquire repository lock" >&2
        exit 1
    }

    echo "$(date -Is) Gmail ingest lock acquired"

    if [ -n "$(git status --porcelain)" ]; then
        echo "$(date -Is) ERROR: Repository was dirty before Gmail ingest" >&2
        git status --short >&2
        exit 1
    fi

    echo "$(date -Is) Running pre-Gmail GitHub sync"

    if ! "$SYNC"; then
        echo "$(date -Is) ERROR: Pre-Gmail synchronization failed" >&2
        exit 1
    fi

    echo "$(date -Is) Running Codex Gmail ingestion"

    if ! codex exec \
        --sandbox workspace-write \
        -C "$REPO" \
        - < "$PROMPT_FILE"; then

        echo "$(date -Is) ERROR: Codex Gmail ingestion failed" >&2
        exit 1
    fi

    if [ -z "$(git status --porcelain)" ]; then
        echo "$(date -Is) Gmail ingest produced no repository changes"
        exit 0
    fi

    echo "$(date -Is) Gmail ingest changed knowledge base; creating commit"

    if ! git add -A; then
        echo "$(date -Is) ERROR: git add failed" >&2
        exit 1
    fi

    if ! git commit -m "Knowledge update from Gmail"; then
        echo "$(date -Is) ERROR: git commit failed" >&2
        exit 1
    fi

    echo "$(date -Is) Running post-Gmail GitHub sync"

    if ! "$SYNC"; then
        echo "$(date -Is) ERROR: Gmail changes were committed locally, but GitHub synchronization failed" >&2
        exit 2
    fi

    echo "$(date -Is) Gmail ingest complete"

) 9>"$LOCK"
