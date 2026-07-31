#!/bin/bash
# Agent-INDEPENDENT host for the daily-ritual execution check
# (check-ritual-execution.sh, card 1945ac7b). Same architecture as
# pending-inbox-starvation-timer.sh and model-drift-timer.sh: a control that
# lives inside an agent's turn cycle is unreachable exactly when that agent
# (or the scheduler feeding it) is the fault -- and twice in one week it was
# GABOR who noticed a missed ritual first.
#
# ROUTING (card 8bcbd8fe, audit verdict (b), 2026-07-31): a missed ritual is
# mr-wolfe's to fix -- he owns the schedule and can re-fire the task -- so while
# the dashboard answers, the finding goes to him via /api/messages and Gabor
# hears nothing. notify.sh (direct Bot API) survives ONLY for the dashboard-down
# case, which is the genuine backstop role: the dashboard, the coordinator, the
# inter-agent queue and sendAlert's quiet-hours buffer are then all gone at once.
set -uo pipefail

REPO="/home/szabgabor/marveen"
CHECK="$REPO/scripts/check-ritual-execution.sh"
NOTIFY="$REPO/scripts/notify.sh"
# shellcheck source=scripts/alert-route.sh
source "$REPO/scripts/alert-route.sh"

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

# The missed ritual names are the "  - <name>: ..." lines of the check output;
# pass them through verbatim so the coordinator sees WHICH ritual to re-fire.
if dashboard_alive; then
  if route_to_coordinator "[HOST-WATCHDOG] Ritual-kimaradas eszlelve (host-szintu timer, nem agens).

$out

Fontos: a scheduler gap-catchup meg utolag kezbesitheti a kimaradt slotot, tehat ez nem feltetlenul vegleges kimaradas -- eloszor ellenorizd. Ha tenyleg kimaradt, a te dolgod ujrainditani vagy potolni az adott ritualet (a schedule a te hataskorod). Gabort NEM ertesitettuk."; then
    exit 1
  fi
  echo "route_to_coordinator failed despite a live dashboard -- falling back to notify.sh" >&2
  fallback_note="(a koordinator-utvonal nem valaszolt)"
else
  fallback_note="(a dashboard nem valaszol, ezert kozvetlen ertesites)"
fi

bash "$NOTIFY" "RITUALE-KIMARADAS RIASZTAS (host-szintu timer, nem agens) $fallback_note

$out"
notify_rc=$?

if [ $notify_rc -ne 0 ]; then
  echo "ALERT DELIVERY FAILED (notify.sh rc=$notify_rc) for: $out" >&2
  printf '%s notify.sh rc=%s\n%s\n' "$(date -Is)" "$notify_rc" "$out" \
    >> "$REPO/store/ritual-execution.ALERT-FAILED"
  exit 2
fi
exit 1
