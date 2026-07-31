#!/usr/bin/env bash
# Shadow-git history for the fleet's INSTRUCTION FILES (wolfe's finding,
# 2026-07-31, msg 3226): CLAUDE.md / SOUL.md are deliberately gitignored in
# the main repo (install-personalized; the consumer install cannot push and
# update.sh needs a clean tree, only templates/ are tracked upstream) -- which
# means the fleet's most load-bearing prose has NO history. Twice on
# 2026-07-31 a stale sentence was found in it with no way to see when it
# drifted (skill-writer model claim; the CLAUDE.md edit wolfe believed he had
# committed). This script keeps a LOCAL git repo under store/ with a commit
# per observed change, so "when did this sentence change" has an answer.
#
# Boundaries, deliberate:
#   - LOCAL ONLY: store/ is a hard-deny tree for the nightly offsite export
#     (auth material lives there), so this history never leaves the host. The
#     instruction files THEMSELVES already go offsite nightly via the backup's
#     `identity` category -- offsite coverage exists, this adds diffability.
#   - WHAT + WHEN, not WHO: a timer snapshot cannot attribute the author.
#     Attribution, when needed, comes from cross-referencing fleet logs.
#   - Silent-if-clean (same contract as the other check scripts): no output
#     and exit 0 when nothing changed or a snapshot was committed cleanly.
set -euo pipefail

REPO="/home/szabgabor/marveen"
HIST="$REPO/store/instruction-history"

FILES=(
  "CLAUDE.md" "SOUL.md"
  "agents/neo/CLAUDE.md" "agents/neo/SOUL.md"
  "agents/alex/CLAUDE.md" "agents/alex/SOUL.md"
  "agents/charlie/CLAUDE.md" "agents/charlie/SOUL.md"
  "agents/ive/CLAUDE.md" "agents/ive/SOUL.md"
)

if [ ! -d "$HIST/.git" ]; then
  mkdir -p "$HIST"
  git -C "$HIST" init -q
  git -C "$HIST" config user.name "instruction-history"
  git -C "$HIST" config user.email "noreply@marveen.local"
fi

for f in "${FILES[@]}"; do
  if [ -f "$REPO/$f" ]; then
    mkdir -p "$HIST/$(dirname "$f")"
    cp "$REPO/$f" "$HIST/$f"
  fi
done

git -C "$HIST" add -A
if ! git -C "$HIST" diff --cached --quiet; then
  git -C "$HIST" commit -q -m "snapshot $(date -Is)"
fi
