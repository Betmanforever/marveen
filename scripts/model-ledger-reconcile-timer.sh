#!/bin/bash
# Agent-INDEPENDENT host for the model-ledger reconciliation
# (check-model-ledger-reconcile.sh, audit AC-10). Same architecture as the other
# host timers: a control that lives inside an agent's turn cycle is unreachable
# exactly when that agent is the fault.
#
# ROUTING, and it is the point of this wrapper: findings go to the COORDINATOR,
# never to Gabor. This is an audit-trail control -- "a model switch happened
# that nobody wrote down" is never a decision only the owner can make, and it
# can always wait for the next daily run. So there is deliberately NO notify.sh
# fallback here: if the dashboard is down we exit non-zero, leave the finding in
# the journal, and let tomorrow's run report it. Growing the owner-facing
# surface for a governance check is precisely what the 2026-07-31 audit told us
# to stop doing.
#
# Cadence is DAILY, not hourly: the ledger gap it looks for is measured in days
# (the 07-23/24 precedent went unrecorded for two of them).
set -uo pipefail

REPO="/home/szabgabor/marveen"
CHECK="$REPO/scripts/check-model-ledger-reconcile.sh"
# shellcheck source=scripts/alert-route.sh
source "$REPO/scripts/alert-route.sh"

out="$(bash "$CHECK" 2>&1)"
rc=$?

# Silent by default: exit 0 and no output means every model switch in the window
# has a config_change_log row. A clean pass re-arms the dedup.
if [ $rc -eq 0 ]; then
  rm -f "$REPO/store/.model-ledger-reconcile.state"
  exit 0
fi

# DEDUP on the finding set: the same unlogged boundary is reported at most once
# per DEDUP_MIN, a NEW boundary changes the key and reports immediately, and the
# gap closing (someone wrote the entry) re-arms.
DEDUP_MIN="${DEDUP_MIN:-1440}"
STATE="$REPO/store/.model-ledger-reconcile.state"
key="$(printf '%s' "$out" | grep -oE '^\s+- [^(]+' | sort -u | md5sum | cut -d' ' -f1)"
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

if dashboard_alive; then
  if route_to_coordinator "[HOST-WATCHDOG] Modell-naplozasi res (audit-nyom hiany, nem uzemzavar).

$out

Ez governance-jelzes: tortent modellvaltas, amirol nincs config_change_log sor. A te dolgod: derits ki mi valtott (session-hatar ideje a sorban van), es potold a config_change_log bejegyzest a szokasos kulcs-formaval (agent_model:<agent>), a valos idoponttal es a provenanciaval a value-ban. Gabort NEM kell ertesiteni."; then
    exit 1
  fi
  echo "route_to_coordinator failed despite a live dashboard: $out" >&2
  exit 2
fi

# Dashboard down: deliberately silent towards Gabor (see the header). The
# journal keeps the finding and the next daily run re-reports it.
echo "dashboard unreachable, ledger finding not routed (will retry next run): $out" >&2
exit 2
