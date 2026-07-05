#!/usr/bin/env bash
# daily-log.sh <agent_id> <content>
#
# Auditor-approved fixed wrapper (2026-07-03): strict-profile agents
# must NOT run free-form `curl -X POST/-d` (deny-listed). This script is the
# ONLY allow-listed way to append a daily-log entry. Endpoint and method are
# hardcoded; the Bearer token is read by the script itself from
# store/.dashboard-token (the model never sees it). No free URL or header
# parameters. The API is append-only, so the blast radius of a prompt-injected
# content string is a bogus log line, nothing more.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TOKEN_FILE="$ROOT/store/.dashboard-token"
ENDPOINT="http://localhost:3420/api/daily-log"

if [ $# -ne 2 ]; then
  echo "usage: daily-log.sh <agent_id> <content>" >&2
  exit 2
fi
agent_id="$1"; content="$2"

case "$agent_id" in
  *[!a-z0-9-]*|'') echo "daily-log.sh: invalid agent_id" >&2; exit 2 ;;
esac
[ -n "$content" ] || { echo "daily-log.sh: empty content" >&2; exit 2; }
[ -r "$TOKEN_FILE" ] || { echo "daily-log.sh: token file not readable" >&2; exit 3; }

payload="$(python3 - "$agent_id" "$content" <<'PYEOF'
import json, sys
print(json.dumps({"agent_id": sys.argv[1], "content": sys.argv[2]}))
PYEOF
)"

curl -s -f -m 15 -X POST "$ENDPOINT" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(cat "$TOKEN_FILE")" \
  --data "$payload" > /dev/null \
  && echo "OK: daily-log entry saved" \
  || { echo "daily-log.sh: API call failed" >&2; exit 4; }
