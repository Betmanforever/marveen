#!/usr/bin/env bash
# worker-guard.sh -- event-driven agent-worker health watcher.
#
# Replaces the old */5 LLM heartbeat (worker-health-guard scheduled task).
# Tails store/dashboard.log and reacts ONLY when the agent-worker actually
# fails ("worker not ready" / "Failed to generate agent"). On a real failure it
# cleans a wedged/parked marveen-worker (kill + relaunch, per the
# marveen-agent-worker-stuck skill) and pings the owner on Telegram via the Bot
# API. Zero model tokens, instant reaction, no polling.
#
# Run in background (nohup) and add to WSL autostart alongside the other
# Marveen services. Idempotent debounce: acts at most once per DEBOUNCE_SEC.

set -uo pipefail

# Single-instance lock -- never let duplicate watchers accumulate.
LOCK="/tmp/marveen-worker-guard.lock"
exec 9>"$LOCK"
flock -n 9 || { echo "worker-guard: already running, exiting" >&2; exit 0; }

INSTALL_DIR="/home/szabgabor/marveen"
LOG="$INSTALL_DIR/store/dashboard.log"
WORKER_HOME="$HOME/.marveen-worker"
WORKER_MODEL="claude-opus-4-8[1m]"
DEBOUNCE_SEC=120
CHAT_ID="8765540529"
PATTERN='worker not ready|Failed to generate agent'

BOT_TOKEN="$(grep -E '^TELEGRAM_BOT_TOKEN=' "$HOME/.claude/channels/telegram/.env" 2>/dev/null | head -1 | cut -d= -f2-)"

notify() {
  # Alert-policy routing (card 5e68c5e1, audit C-1): coordinator first; the
  # direct Bot API leg survives only as the dashboard-down backstop, and even
  # then never inside quiet hours (22:00-06:00, src/quiet-hours.ts) -- the guard
  # keeps running, so a persisting failure re-alerts after 06:00.
  . "$INSTALL_DIR/scripts/alert-route.sh"
  if dashboard_alive && route_to_coordinator "$1"; then
    return 0
  fi
  local hour
  hour=$((10#$(date +%H)))
  if [ "$hour" -ge 22 ] || [ "$hour" -lt 6 ]; then
    echo "[worker-guard] QUIET-DEFER (22-06, dashboard down): $1" >> "$INSTALL_DIR/store/host-watchdog.log" 2>/dev/null || true
    return 0
  fi
  [ -z "$BOT_TOKEN" ] && return 0
  curl -s -m 15 -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${CHAT_ID}" \
    --data-urlencode "text=$1" >/dev/null 2>&1
}

worker_box_dirty() {
  # Returns 0 (dirty) only if there is PARKED TEXT on the ❯ prompt line.
  # A clean idle box is "❯ " (nothing after the caret); the idle footer
  # ("⏵⏵ bypass permissions...") is always present and must NOT count as dirty.
  # Missing session also counts as dirty (needs a relaunch).
  tmux has-session -t marveen-worker 2>/dev/null || return 0
  local promptline after
  promptline="$(tmux capture-pane -t marveen-worker -p 2>/dev/null | grep -m1 '❯')"
  after="${promptline#*❯}"
  # Dirty only if a real glyph (alnum/punct) sits after the caret. A clean box is
  # "❯ " followed by a non-breaking space (U+00A0), which tr -d '[:space:]' would
  # miss -- so test for visible parked-text characters instead.
  printf '%s' "$after" | grep -q '[[:alnum:][:punct:]]'
}

clean_worker() {
  tmux kill-session -t marveen-worker 2>/dev/null
  local launch="export CLAUDE_CONFIG_DIR='$WORKER_HOME/.claude-config'; cd '$WORKER_HOME' && claude --dangerously-skip-permissions --model '$WORKER_MODEL'"
  tmux new-session -d -s marveen-worker -c "$WORKER_HOME" bash -lc "$launch"
}

last_action=0
# tail -F survives log rotation; grep is line-buffered so matches surface at once.
tail -n0 -F "$LOG" 2>/dev/null | grep --line-buffered -E "$PATTERN" | while IFS= read -r line; do
  now="$(date +%s)"
  (( now - last_action < DEBOUNCE_SEC )) && continue
  last_action="$now"

  ts="$(date '+%H:%M:%S')"
  if worker_box_dirty; then
    clean_worker
    notify "🔧 Worker-őr (${ts}): az agent-worker beragadt (${line##*] }). Tiszta újraindítás megtörtént, a generálás újra futtatható a Tovább gombbal."
  else
    # Failure logged but the worker is already idle/clean -- the dashboard's own
    # ensureWorkerReady() will relaunch on the next request. Just inform.
    notify "⚠️ Worker-őr (${ts}): agent-worker hiba a logban (${line##*] }), de a worker box tiszta. A dashboard a következő kérésnél magától újraindítja. Ha a Tovább megint elhasal, szólj."
  fi
done
