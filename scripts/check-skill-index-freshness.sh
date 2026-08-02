#!/usr/bin/env bash
# Output-side freshness guard for the skill index (card 0123b6bd, 2026-08-02).
# Complements check-hook-drift.sh: that one proves the hook is REGISTERED,
# this one proves the hook's OUTPUT is fresh. A hook can be registered and
# still not fire; only the artifact tells the truth.
#
# Predicate (why not a raw mtime compare): the autoregen hook is DEBOUNCED
# (45s quiet window + regen runtime), so "index older than newest SKILL.md"
# is the NORMAL state for up to ~1-2 minutes after an edit burst. The
# 2026-08-02 false alarm was exactly this: two mid-window mtime reads were
# diagnosed as missed runs, and both manual regens raced the debounce worker
# by seconds (12:49:38 manual vs 12:49:32 auto; 13:51:50 vs 13:51:35 --
# store/skill-index-autoregen.log). Staleness is only real once the newest
# SKILL.md edit is older than GRACE and the index still predates it.
#
# Output contract (same as check-hook-drift.sh): NOTHING on stdout and exit 0
# when healthy. Any stdout line / nonzero exit means "look at this" -- the
# caller (a heartbeat prompt) surfaces it verbatim, no further parsing.
set -euo pipefail

SKILLS_DIR="$HOME/.claude/skills"
INDEX="$SKILLS_DIR/.skill-index.md"
FAIL_SENTINEL="$(cd "$(dirname "$0")/.." && pwd)/store/skill-index-autoregen.FAILED"
GRACE_SEC=180   # debounce (45s) + regen runtime + margin

# A failed regen attempt is a finding regardless of mtimes.
if [ -f "$FAIL_SENTINEL" ]; then
  echo "SKILL-INDEX: regen FAILED sentinel present: $(head -1 "$FAIL_SENTINEL")"
  exit 1
fi

if [ ! -f "$INDEX" ]; then
  echo "SKILL-INDEX: index file missing ($INDEX)"
  exit 1
fi

newest_file=""
newest_mtime=0
for f in "$SKILLS_DIR"/*/SKILL.md; do
  [ -f "$f" ] || continue
  m=$(stat -c '%Y' "$f" 2>/dev/null || echo 0)
  if [ "$m" -gt "$newest_mtime" ]; then newest_mtime=$m; newest_file=$f; fi
done

[ "$newest_mtime" -gt 0 ] || exit 0   # no skills at all -- nothing to index

index_mtime=$(stat -c '%Y' "$INDEX")
now=$(date +%s)

if [ "$newest_mtime" -gt "$index_mtime" ] && [ $((now - newest_mtime)) -gt "$GRACE_SEC" ]; then
  echo "SKILL-INDEX: stale -- $newest_file ($(date -d "@$newest_mtime" '+%H:%M:%S')) is newer than the index ($(date -d "@$index_mtime" '+%H:%M:%S')) and the grace window (${GRACE_SEC}s) has passed. Recover: bash $(cd "$(dirname "$0")" && pwd)/skill-index.sh"
  exit 1
fi

exit 0
