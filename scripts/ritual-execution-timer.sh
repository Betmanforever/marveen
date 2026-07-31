#!/bin/bash
# Agent-INDEPENDENT host for the daily-ritual execution check
# (check-ritual-execution.sh, card 1945ac7b). Same architecture as
# pending-inbox-starvation-timer.sh and model-drift-timer.sh: a control that
# lives inside an agent's turn cycle is unreachable exactly when that agent
# (or the scheduler feeding it) is the fault -- and twice in one week it was
# GABOR who noticed a missed ritual first. Alert path is notify.sh (direct
# Bot API), independent of the dashboard, the inter-agent queue, and every
# agent session.
set -uo pipefail

REPO="/home/szabgabor/marveen"
CHECK="$REPO/scripts/check-ritual-execution.sh"
NOTIFY="$REPO/scripts/notify.sh"

out="$(bash "$CHECK" 2>&1)"
rc=$?

# Silent by default; a clean pass re-arms the dedup for the next episode.
if [ $rc -eq 0 ]; then
  rm -f "$REPO/store/.ritual-execution.state"
  exit 0
fi

# DEDUP on the finding set: the same missed slot re-alerts at most once per
# DEDUP_MIN, a NEW ritual joining the list alerts immediately, and the list
# clearing (rituals ran / day rolled over) re-arms.
DEDUP_MIN="${DEDUP_MIN:-240}"
STATE="$REPO/store/.ritual-execution.state"
key="$(printf '%s' "$out" | grep -oE '^\s+- [a-z0-9-]+' | sort -u | md5sum | cut -d' ' -f1)"
now_s=$(date +%s)
if [ -f "$STATE" ]; then
  prev_key="$(head -1 "$STATE" 2>/dev/null)"
  prev_at="$(sed -n '2p' "$STATE" 2>/dev/null)"
  prev_at="${prev_at:-0}"
  if [ "$key" = "$prev_key" ] && [ $(( now_s - prev_at )) -lt $(( DEDUP_MIN * 60 )) ]; then
    exit 1
  fi
fi
printf '%s\n%s\n' "$key" "$now_s" > "$STATE"

bash "$NOTIFY" "RITUALE-KIMARADAS RIASZTAS (host-szintu timer, nem agens)

$out"
notify_rc=$?

if [ $notify_rc -ne 0 ]; then
  echo "ALERT DELIVERY FAILED (notify.sh rc=$notify_rc) for: $out" >&2
  printf '%s notify.sh rc=%s\n%s\n' "$(date -Is)" "$notify_rc" "$out" \
    >> "$REPO/store/ritual-execution.ALERT-FAILED"
  exit 2
fi
exit 1
