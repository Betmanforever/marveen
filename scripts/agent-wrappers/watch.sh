#!/usr/bin/env bash
# watch.sh [setup] <video-url-or-path> [watch.py options...]
#
# Fixed wrapper for the claude-watch plugin on strict-profile agents
# (2026-07-04, kanban follow-up to the Ive permission-freeze incident).
# Why a wrapper instead of a direct python3 allow rule:
#   - Bash allow rules are literal word-boundary prefixes; the SKILL.md-
#     prescribed invocation (`python3 "${CLAUDE_SKILL_DIR}/scripts/watch.py"`)
#     never matches one: quoting the path breaks the literal match and an
#     unexpanded ${VAR} is hard-blocked as "Contains expansion".
#   - The plugin cache path contains a version directory (watch/0.2.0/), so
#     any absolute allow rule silently dies on plugin update. This wrapper
#     resolves the newest installed version at call time.
#   - watch.py defaults its working dir to the system tmp dir, which is
#     outside a strict agent's Read scope, so the frame Reads that follow
#     would freeze the session. The wrapper forces --out-dir under the
#     agent's own cwd (agents run with cwd = AGENT_DIR).
#   - watch.py stdout is unbounded (yt-dlp/ffmpeg progress, transcript dump).
#     When a Bash tool result exceeds the harness limit, Claude Code spills
#     it to CLAUDE_CONFIG_DIR/projects/<slug>/<session>/tool-results/*.txt --
#     and that transcript area is HARD-protected: no permissions.allow rule
#     matches it (probe-verified on 2.1.201, 2026-07-04: even an exact
#     literal Read(//...path.txt) rule is refused; only the interactive
#     session-scoped grant unblocks, which no one attends). So the wrapper
#     must never let stdout grow that large: the full run output goes to
#     $OUT/run.log inside the agent's own scope and only a short tail is
#     printed.
# No credentials involved; the script only execs the plugin's own python3
# entry points (watch.py / setup.py) with caller-supplied arguments.
set -euo pipefail

CACHE="$HOME/.claude/plugins/cache/claude-watch/watch"

SCRIPTS=""
for dir in $(ls -d "$CACHE"/*/ 2>/dev/null | sort -V); do
  [ -f "${dir}scripts/watch.py" ] && SCRIPTS="${dir}scripts"
done
if [ -z "$SCRIPTS" ]; then
  echo "watch.sh: claude-watch plugin not found under $CACHE" >&2
  exit 1
fi

if [ $# -eq 0 ]; then
  echo "usage: watch.sh [setup] <video-url-or-path> [watch.py options...]" >&2
  exit 2
fi

# `watch.sh setup [--check|--json]` -> preflight via the plugin's setup.py
if [ "$1" = "setup" ]; then
  shift
  exec python3 "$SCRIPTS/setup.py" "$@"
fi

# Force the working dir inside the agent's own directory unless the caller
# picked one explicitly (keeps frames within the agent's Read scope).
has_out_dir=0; no_whisper=0; no_hook=0
OUT=""; prev=""
for arg in "$@"; do
  case "$arg" in
    --out-dir) has_out_dir=1 ;;
    --no-whisper) no_whisper=1 ;;
    --no-hook-microscope) no_hook=1 ;;
  esac
  [ "$prev" = "--out-dir" ] && OUT="$arg"
  prev="$arg"
done
extra=()
# --no-whisper alone does not keep the run offline: hook.py re-loads the API
# key itself when it receives backend=None (upstream bug, observed 2026-07-04
# with a 429 on Ive's test), so pair it with --no-hook-microscope unless the
# caller explicitly asked for the hook pass.
if [ $no_whisper -eq 1 ] && [ $no_hook -eq 0 ]; then
  extra+=(--no-hook-microscope)
fi
if [ $has_out_dir -eq 0 ]; then
  OUT="$PWD/watch-work/$(date +%Y%m%d-%H%M%S)"
  extra+=(--out-dir "$OUT")
fi

# Full output to run.log inside the agent's scope; only a short tail to
# stdout so the Bash tool result never spills to the protected tool-results
# area (see header comment).
mkdir -p "$OUT"
LOG="$OUT/run.log"
set +e
python3 "$SCRIPTS/watch.py" "$@" ${extra[@]+"${extra[@]}"} >"$LOG" 2>&1
rc=$?
set -e
echo "watch.sh: exit=$rc | out-dir: $OUT | full log: $LOG" | tee -a "$LOG"
echo "--- last 40 log lines ---"
tail -n 40 "$LOG"
exit $rc
