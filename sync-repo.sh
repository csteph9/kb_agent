#!/bin/bash

set -u

REPO="/home/knowledge/repo"
BRANCH="master"

echo "$(date -Is) Starting repository synchronization"

cd "$REPO" || {
    echo "$(date -Is) ERROR: Could not enter repository: $REPO"
    exit 1
}

# ---------------------------------------------------------------------------
# The caller MUST already hold the repository flock.
# ---------------------------------------------------------------------------

# Never begin a sync with an unexpected dirty working tree.
if [ -n "$(git status --porcelain)" ]; then
    echo "$(date -Is) ERROR: Working tree is dirty; refusing to sync."
    git status --short
    exit 1
fi

# ---------------------------------------------------------------------------
# Fetch remote changes
# ---------------------------------------------------------------------------

echo "$(date -Is) Fetching origin"

if ! git fetch origin; then
    echo "$(date -Is) ERROR: git fetch failed."
    exit 1
fi

# ---------------------------------------------------------------------------
# Rebase local commits onto GitHub.
#
# A rebase may encounter more than one conflict if multiple local commits
# need to be replayed. We therefore continue resolving conflicts until the
# rebase completes or something occurs that we cannot safely handle.
# ---------------------------------------------------------------------------

echo "$(date -Is) Rebasing onto origin/$BRANCH"

if git rebase "origin/$BRANCH"; then
    echo "$(date -Is) Rebase completed normally."
else

    while true; do

        CONFLICTS="$(git diff --name-only --diff-filter=U)"

        if [ -z "$CONFLICTS" ]; then
            echo "$(date -Is) ERROR: Rebase failed, but no merge conflicts were found."
            git rebase --abort || true
            exit 1
        fi

        echo "$(date -Is) Rebase conflict detected."
        echo "$(date -Is) Conflicted files:"
        echo "$CONFLICTS"

        # -------------------------------------------------------------------
        # Automatic semantic resolution is restricted to Markdown.
        # -------------------------------------------------------------------

        while IFS= read -r file; do
            case "$file" in
                *.md)
                    ;;
                *)
                    echo "$(date -Is) ERROR: Non-Markdown conflict: $file"
                    echo "$(date -Is) Automatic resolution is restricted to Markdown."
                    git rebase --abort || true
                    exit 1
                    ;;
            esac
        done <<< "$CONFLICTS"

        # -------------------------------------------------------------------
        # Ask Codex to semantically resolve the Markdown conflicts.
        # -------------------------------------------------------------------

        PROMPT=$(cat <<'EOF'
A Git rebase is currently paused because Markdown files in this
personal knowledge base contain merge conflicts.

Resolve ONLY the existing Git conflicts.

For every conflicted Markdown file:

1. Read the entire conflicted file, including both sides of every
   Git conflict.

2. Understand the meaning and chronology of the information rather
   than simply combining the text mechanically.

3. Preserve useful knowledge from both sides whenever the information
   is compatible.

4. If one side clearly represents a correction, replacement,
   cancellation, update, or superseding fact, treat the newer
   information as the current fact.

5. Preserve older information as historical or superseded information
   when doing so remains useful.

6. Do NOT blindly concatenate conflicting sections.

7. Do NOT invent facts in order to reconcile contradictory information.

8. Do NOT delete unrelated information from either side.

9. Remove all Git conflict markers from conflicts you can confidently
   resolve.

10. Modify ONLY files that currently contain Git merge conflicts.

If a factual conflict cannot be resolved without guessing which version
is correct, LEAVE THAT CONFLICT UNRESOLVED. Do not choose arbitrarily.

Do NOT run Git commands.

Specifically, do not run:

- git add
- git commit
- git rebase
- git merge
- git push
- git checkout
- git restore
- git reset

Your responsibility is only to edit the conflicted Markdown files into
their correct merged state.

The synchronization script will inspect your work and perform the Git
operations afterward.
EOF
)

        echo "$(date -Is) Asking Codex to resolve Markdown conflicts"

        if ! printf '%s\n' "$PROMPT" | codex exec \
            --sandbox workspace-write \
            -C "$REPO" \
            -; then

            echo "$(date -Is) ERROR: Codex conflict resolution failed."
            git rebase --abort || true
            exit 1
        fi

        # -------------------------------------------------------------------
        # Verify that Codex removed all conflict markers.
        # -------------------------------------------------------------------

        MARKERS=0

        while IFS= read -r file; do

            if grep -nE '^(<<<<<<<|=======|>>>>>>>)' "$file" >/dev/null 2>&1; then
                echo "$(date -Is) ERROR: Conflict markers remain in $file"
                grep -nE '^(<<<<<<<|=======|>>>>>>>)' "$file" || true
                MARKERS=1
            fi

        done <<< "$CONFLICTS"

        if [ "$MARKERS" -ne 0 ]; then
            echo "$(date -Is) ERROR: Codex did not fully resolve the conflict."
            git rebase --abort || true
            exit 1
        fi

        # -------------------------------------------------------------------
        # Stage only the originally conflicted files.
        # -------------------------------------------------------------------

        echo "$(date -Is) Codex resolved conflict markers. Staging files."

        while IFS= read -r file; do

            if ! git add -- "$file"; then
                echo "$(date -Is) ERROR: Could not stage $file"
                git rebase --abort || true
                exit 1
            fi

        done <<< "$CONFLICTS"

        REMAINING="$(git diff --name-only --diff-filter=U)"

        if [ -n "$REMAINING" ]; then
            echo "$(date -Is) ERROR: Git still reports unresolved conflicts:"
            echo "$REMAINING"
            git rebase --abort || true
            exit 1
        fi

        # -------------------------------------------------------------------
        # Continue replaying local commits.
        # -------------------------------------------------------------------

        echo "$(date -Is) Continuing rebase"

        if GIT_EDITOR=true git rebase --continue; then

            # Rebase completed.
            echo "$(date -Is) Semantic conflict resolution complete."
            break

        else

            # It may simply have encountered another Markdown conflict.
            NEXT_CONFLICTS="$(git diff --name-only --diff-filter=U)"

            if [ -n "$NEXT_CONFLICTS" ]; then
                echo "$(date -Is) Additional rebase conflict encountered."
                continue
            fi

            echo "$(date -Is) ERROR: Rebase failed for a reason other than a merge conflict."
            git rebase --abort || true
            exit 1
        fi
    done
fi

# ---------------------------------------------------------------------------
# Final repository integrity check
# ---------------------------------------------------------------------------

if [ -n "$(git status --porcelain)" ]; then
    echo "$(date -Is) ERROR: Working tree is not clean after rebase."
    git status --short
    exit 1
fi

# ---------------------------------------------------------------------------
# Push local history to GitHub
# ---------------------------------------------------------------------------

echo "$(date -Is) Pushing"

if ! git push origin "$BRANCH"; then
    echo "$(date -Is) ERROR: git push failed."
    exit 1
fi

echo "$(date -Is) Repository synchronization complete"
