#!/bin/bash

set -u

LOCK="/tmp/knowledge-repo.lock"
SYNC="/opt/knowledge-agent/sync-repo.sh"

echo "$(date -Is) Starting scheduled knowledge repository sync"

(
    flock -w 300 9 || {
        echo "$(date -Is) ERROR: Could not acquire repository lock"
        exit 1
    }

    echo "$(date -Is) Repository lock acquired"

    if ! "$SYNC"; then
        echo "$(date -Is) ERROR: Repository synchronization failed"
        exit 1
    fi

    echo "$(date -Is) Scheduled knowledge repository sync complete"

) 9>"$LOCK"
