#!/bin/bash
# Agent-INDEPENDENT host for the hook-mode inbox starvation check.
#
# Why this exists as a systemd user timer and NOT as a scheduled task on an
# agent (2026-07-29 audit finding): a control that lives inside an agent is
# unreachable exactly when that agent is the fault. Both existing attempts
# failed the same way with OPPOSITE settings:
#   - folyamatos-ellenorzes (skipIfBusy: true)  -> silently dropped at
#     19:30:38, 19:45:50 and 20:00:59 while mr-wolfe was busy all evening,
#     taking check-hook-drift.sh down with it.
#   - pending-uzenet-watchdog (skipIfBusy: false) -> retried every minute
#     into a busy agent from 18:20:39 and never landed once.
# check-pending-inbox-starvation.sh's own header asks for a host "OUTSIDE any
# single agent's turn cycle" and then names folyamatos-ellenorzes, which IS an
# agent turn cycle. This timer is that outside host.
#
# ROUTING (card 8bcbd8fe, audit AC-2/AC-4, 2026-07-31). This wrapper used to
# send every finding straight to Gabor. It is a machine fact about a queue the
# coordinator watches too, and this timer has NO busy-detection at all (audit
# RC-3: it alerts on age alone at 10 minutes while its own check script
# documents legitimate 30-45 minute turns), so it produced the 16:40 false
# alert. Two changes:
#   1. while the dashboard answers, the finding goes to mr-wolfe via
#      /api/messages -- never to Gabor;
#   2. notify.sh survives ONLY for the dashboard-down case, which is the actual
#      backstop role: then the dashboard, the coordinator, the inter-agent queue
#      and sendAlert's quiet-hours buffer are all gone at once.
# The in-process watchdog (src/web/pending-age-watchdog.ts) OWNS this signal and
# has the pane-progress predicate this script lacks; this one is an observer.
set -uo pipefail

REPO="/home/szabgabor/marveen"
CHECK="$REPO/scripts/check-pending-inbox-starvation.sh"
NOTIFY="$REPO/scripts/notify.sh"
# shellcheck source=scripts/alert-route.sh
source "$REPO/scripts/alert-route.sh"

out="$(bash "$CHECK" 2>&1)"
rc=$?

# Silent by default: exit 0 and no output means nothing is starving.
# Clearing the backlog also RE-ARMS the dedup, so the next distinct episode
# alerts immediately instead of being suppressed by a stale state file.
if [ $rc -eq 0 ]; then
  rm -f "$REPO/store/.pending-inbox-starvation.state"
  exit 0
fi

# Non-zero exit is the detection. Anything else (missing script, bad DB) is
# also worth surfacing rather than swallowing -- the whole point of tonight's
# audit was that a silently-failing control is worse than none.
#
# DEDUP, and it is not optional: this timer runs every 10 minutes, while a
# starved message can sit for an hour. Without dedup one stuck row becomes six
# identical Telegram alerts, which is how a useful control trains its reader to
# ignore it. Gabor's standing instruction is explicit: do not spam his
# attention. Key the dedup on the SET of starving message ids, so:
#   - the same backlog re-alerts at most once per DEDUP_MIN,
#   - a NEW id appearing changes the key and alerts immediately (worsening
#     backlogs must never be silenced by an earlier alert),
#   - the backlog clearing removes the state file, re-arming for next time.
DEDUP_MIN="${DEDUP_MIN:-60}"
STATE="$REPO/store/.pending-inbox-starvation.state"
key="$(printf '%s' "$out" | grep -oE 'id=[0-9]+' | sort -u | tr '\n' ',')"
now_s=$(date +%s)
if [ -f "$STATE" ]; then
  prev_key="$(head -1 "$STATE" 2>/dev/null)"
  prev_at="$(sed -n '2p' "$STATE" 2>/dev/null)"
  prev_at="${prev_at:-0}"
  if [ "$key" = "$prev_key" ] && [ $(( now_s - prev_at )) -lt $(( DEDUP_MIN * 60 )) ]; then
    # Same backlog, already reported recently. Stay silent but keep the
    # non-zero exit so `systemctl status` and the journal still show it.
    exit 1
  fi
fi
printf '%s\n%s\n' "$key" "$now_s" > "$STATE"

# Coordinator first. A finding that reaches mr-wolfe is DONE here -- the owner
# is not told, by design: he is told only if the coordinator layer itself is
# unreachable (below) or if the in-process watchdog escalates (audit AC-5).
if dashboard_alive; then
  if route_to_coordinator "[HOST-WATCHDOG] Inbox-starvation eszlelve (host-szintu timer, nem agens).

$out

A dashboard el, a beragadt sorra van sajat figyelo is (pending-age watchdog, pane-progress alapu). A te dolgod: nezd meg a dashboard uzenetsort, es ha valos, oldd fel vagy inditsd ujra az erintett agenst. Gabort NEM ertesitettuk."; then
    exit 1
  fi
  echo "route_to_coordinator failed despite a live dashboard -- falling back to notify.sh" >&2
  fallback_note="(a koordinator-utvonal nem valaszolt)"
else
  fallback_note="(a dashboard nem valaszol, ezert kozvetlen ertesites)"
fi

bash "$NOTIFY" "INBOX-STARVATION RIASZTAS (host-szintu timer, nem agens) $fallback_note

$out"
notify_rc=$?

# Never swallow a failed alert. If the alert itself could not be sent, leave a
# loud trace in the journal AND a sentinel file, so the failure is discoverable
# without reading journald (src/notify.ts's silent last-resort catch is exactly
# the bug this avoids).
if [ $notify_rc -ne 0 ]; then
  echo "ALERT DELIVERY FAILED (notify.sh rc=$notify_rc) for: $out" >&2
  printf '%s notify.sh rc=%s\n%s\n' "$(date -Is)" "$notify_rc" "$out" \
    >> "$REPO/store/pending-inbox-starvation.ALERT-FAILED"
  exit 2
fi

exit 1
