#!/bin/bash
# Shared routing helper for the host-side watchdogs (card 8bcbd8fe, audit
# AC-2/AC-9). Source it; it defines two functions and nothing else.
#
# The rule these scripts got wrong: a host timer's finding is a machine-to-
# machine fact, and machine facts go to the coordinator, not to Gabor's phone.
# The 2026-07-31 audit measured the cost -- 26 of 40 emitters aimed at the owner,
# three messages about one stuck item, and an owner who started discounting
# alerts as a class.
#
# So: while the dashboard answers, findings go to mr-wolfe over /api/messages.
# notify.sh (direct Bot API) survives for exactly ONE case -- the dashboard is
# unreachable, which is also when the coordinator, the inter-agent queue and
# sendAlert's quiet-hours buffering are all unreachable. That is the backstop
# role these timers were built for, and the registry records it as the AC-9
# quiet-hours exemption (src/alert-registry.ts, emitter `notify-sh`).

_ar_repo() {
  cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd
}

# 0 = the dashboard answered an authenticated request. Two attempts, 5s each:
# one refused connection during a restart must not be read as "dashboard down"
# and page the owner. Uses a cheap DB-backed GET, so a process that is up but
# whose database is broken still reads as DOWN.
dashboard_alive() {
  local repo token
  repo="$(_ar_repo)"
  local token_file="$repo/store/.dashboard-token"
  [ -r "$token_file" ] || return 1
  token="$(cat "$token_file")"
  [ -n "$token" ] || return 1
  local attempt
  for attempt in 1 2; do
    if [ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' \
        -H "Authorization: Bearer $token" \
        "http://localhost:3420/api/messages?limit=1" 2>/dev/null)" = "200" ]; then
      return 0
    fi
    [ "$attempt" = "1" ] && sleep 2
  done
  return 1
}

# route_to_coordinator "<text>" -- POST it as an inter-agent message from
# 'host-watchdog'. Returns non-zero if the API refused it, so the caller can
# fall back to notify.sh rather than losing the finding. python3 builds the JSON
# (the finding text is multi-line and quote-bearing; shell string-splicing it
# into a payload is how injection bugs are born).
route_to_coordinator() {
  local repo msg
  repo="$(_ar_repo)"
  msg="$1"
  local main_agent
  main_agent="$(grep -m1 '^MAIN_AGENT_ID=' "$repo/.env" 2>/dev/null | cut -d= -f2-)"
  main_agent="${main_agent:-marveen}"
  MSG="$msg" python3 - "$repo/store/.dashboard-token" "$main_agent" <<'PYEOF'
import json
import os
import sys
import urllib.error
import urllib.request

token_file, main_agent = sys.argv[1:3]
try:
    with open(token_file) as f:
        token = f.read().strip()
except OSError:
    sys.exit(1)
payload = json.dumps({
    "from": "host-watchdog",
    "to": main_agent,
    "content": os.environ.get("MSG", ""),
}).encode()
req = urllib.request.Request(
    "http://localhost:3420/api/messages",
    data=payload,
    headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
)
try:
    with urllib.request.urlopen(req, timeout=5) as resp:
        sys.exit(0 if 200 <= resp.status < 300 else 1)
except (urllib.error.URLError, OSError, ValueError):
    sys.exit(1)
PYEOF
}
