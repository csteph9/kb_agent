#!/bin/bash

set -u

REPO="/home/knowledge/repo"
LOCK="/tmp/knowledge-repo.lock"
SYNC="/opt/knowledge-agent/sync-repo.sh"

OUTPUT="$1"
SESSION_ID="${2:-}"
IMAGE="${3:-}"
JSON_OUTPUT="${4:-}"
MODE="${5:-READ}"

if [ "$MODE" != "READ" ] && [ "$MODE" != "WRITE" ]; then
    echo "Invalid mode: $MODE" >&2
    exit 1
fi

cd "$REPO" || {
    echo "Could not enter repository: $REPO" >&2
    exit 1
}

(
    # -----------------------------------------------------------------------
    # Serialize repository access.
    # -----------------------------------------------------------------------

    flock -w 300 9 || {
        echo "Could not acquire repository lock" >&2
        exit 1
    }

    echo "$(date -Is) Telegram transaction lock acquired"
    echo "$(date -Is) Request mode: $MODE"

    # -----------------------------------------------------------------------
    # Every transaction must start with a clean repository.
    # -----------------------------------------------------------------------

    if [ -n "$(git status --porcelain)" ]; then
        echo "$(date -Is) ERROR: Repository was dirty before Telegram request" >&2
        git status --short >&2
        exit 1
    fi

    # -----------------------------------------------------------------------
    # WRITE requests synchronize BEFORE Codex sees the repository.
    #
    # READ requests intentionally skip this.
    # -----------------------------------------------------------------------

    if [ "$MODE" = "WRITE" ]; then

        echo "$(date -Is) WRITE request: running pre-Codex GitHub sync"

        if ! "$SYNC"; then
            echo "$(date -Is) ERROR: Pre-Codex synchronization failed" >&2
            exit 1
        fi

        echo "$(date -Is) Pre-Codex GitHub sync complete"

    else

        echo "$(date -Is) READ request: skipping GitHub sync"

    fi

    # -----------------------------------------------------------------------
    # Run Codex.
    #
    # New sessions start workspace-write because the same session may later
    # contain WRITE turns.
    #
    # Resumed sessions use the existing Codex session.
    # -----------------------------------------------------------------------

    if [ -n "$SESSION_ID" ]; then

        echo "$(date -Is) Resuming Codex session $SESSION_ID"

        CODEX_ARGS=(
            exec
            resume
            "$SESSION_ID"
        )

        if [ -n "$IMAGE" ]; then
            CODEX_ARGS+=(--image "$IMAGE")
        fi

        CODEX_ARGS+=(
            -o "$OUTPUT"
            -
        )

        if ! codex "${CODEX_ARGS[@]}"; then
            echo "$(date -Is) ERROR: Codex failed" >&2
            exit 1
        fi

    else

        echo "$(date -Is) Starting new Codex session"

        if [ -z "$JSON_OUTPUT" ]; then
            echo "$(date -Is) ERROR: JSON output file not supplied for new session" >&2
            exit 1
        fi

        CODEX_ARGS=(
            exec
            --json
            --sandbox workspace-write
            -C "$REPO"
            -o "$OUTPUT"
        )

        if [ -n "$IMAGE" ]; then
            CODEX_ARGS+=(--image "$IMAGE")
        fi

        CODEX_ARGS+=(-)

        if ! codex "${CODEX_ARGS[@]}" >"$JSON_OUTPUT"; then
            echo "$(date -Is) ERROR: Codex failed" >&2
            exit 1
        fi

    fi

    echo "$(date -Is) Codex complete"

    # -----------------------------------------------------------------------
    # READ SAFETY
    #
    # READ requests must never modify the KB.
    #
    # Because the repository was clean when we acquired the lock, any changes
    # now were made during this Codex turn.
    # -----------------------------------------------------------------------

    if [ "$MODE" = "READ" ]; then

        if [ -n "$(git status --porcelain)" ]; then

            echo "$(date -Is) WARNING: Codex modified repository during READ request" >&2
            echo "$(date -Is) Discarding unexpected READ-side changes" >&2

            git status --short >&2

            if ! git reset --hard HEAD; then
                echo "$(date -Is) ERROR: Could not restore tracked files" >&2
                exit 1
            fi

            if ! git clean -fd; then
                echo "$(date -Is) ERROR: Could not remove unexpected untracked files" >&2
                exit 1
            fi

        fi

        echo "$(date -Is) READ transaction complete"
        exit 0
    fi

    # -----------------------------------------------------------------------
    # WRITE MODE
    #
    # Commit only if Codex actually changed the KB.
    # -----------------------------------------------------------------------

    if [ -n "$(git status --porcelain)" ]; then

        echo "$(date -Is) Knowledge base changed; creating commit"

        if ! git add -A; then
            echo "$(date -Is) ERROR: git add failed" >&2
            exit 1
        fi

        if ! git commit -m "Knowledge update via Telegram"; then
            echo "$(date -Is) ERROR: git commit failed" >&2
            exit 1
        fi

        # -------------------------------------------------------------------
        # Only perform the post-sync if an actual KB commit was created.
        # -------------------------------------------------------------------

        echo "$(date -Is) Running post-Codex GitHub sync"

        if ! "$SYNC"; then
            echo "$(date -Is) ERROR: Knowledge was committed locally, but GitHub synchronization failed" >&2
            exit 2
        fi

        echo "$(date -Is) Post-Codex GitHub sync complete"

    else

        echo "$(date -Is) WRITE request produced no repository changes"
        echo "$(date -Is) No post-sync required"

    fi

    echo "$(date -Is) WRITE transaction complete"

) 9>"$LOCK"
