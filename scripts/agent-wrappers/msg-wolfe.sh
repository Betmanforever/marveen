#!/usr/bin/env bash
# msg-wolfe.sh <agent_id> <content>
#
# Auditor-approved fixed wrapper (2026-07-03): strict-profile agents must NOT
# run free-form `curl -X POST/-d` (deny-listed). This script is the ONLY
# allow-listed way to send an inter-agent message, and the recipient is
# HARDCODED to mr-wolfe (escalation/coordination path -- e.g. the unknown-sender
# ARANYSZABALY ping). Endpoint and method are hardcoded; the Bearer token is
# read by the script itself from store/.dashboard-token (the model never sees
# it). No free URL, recipient, or header parameters.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TOKEN_FILE="$ROOT/store/.dashboard-token"
ENDPOINT="http://localhost:3420/api/messages"
RECIPIENT="mr-wolfe"

if [ $# -ne 2 ]; then
  echo "usage: msg-wolfe.sh <agent_id> <content>" >&2
  exit 2
fi
agent_id="$1"; content="$2"

case "$agent_id" in
  *[!a-z0-9-]*|'') echo "msg-wolfe.sh: invalid agent_id" >&2; exit 2 ;;
esac
[ -n "$content" ] || { echo "msg-wolfe.sh: empty content" >&2; exit 2; }
[ -r "$TOKEN_FILE" ] || { echo "msg-wolfe.sh: token file not readable" >&2; exit 3; }

payload="$(python3 - "$agent_id" "$RECIPIENT" "$content" <<'PYEOF'
import json, sys
print(json.dumps({"from": sys.argv[1], "to": sys.argv[2], "content": sys.argv[3]}))
PYEOF
)"

curl -s -f -m 15 -X POST "$ENDPOINT" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(cat "$TOKEN_FILE")" \
  --data "$payload" > /dev/null \
  && echo "OK: message sent to ${RECIPIENT}" \
  || { echo "msg-wolfe.sh: send failed" >&2; exit 4; }
