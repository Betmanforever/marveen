#!/usr/bin/env bash
# memo-search.sh <agent_id> <query> [category]
#
# Auditor-approved fixed wrapper (2026-07-03): strict-profile agents have no
# allow-listed way to search their memories (plain `curl -H` GET is not
# deny-listed but falls through to an interactive approval prompt that nobody
# clicks, freezing the session). This script is the ONLY allow-listed way.
# Endpoint and method are hardcoded, the query is URL-encoded by the script,
# the Bearer token is read from store/.dashboard-token (the model never sees
# it). Read-only: GET, no mutation surface.
#
# Auditor finding (2026-07-03): /api/memories serves ANY agent's memories for
# an arbitrary `agent` param, so a prompt-injected strict agent could read a
# peer's memory tier through this wrapper. Countermeasure below: agent_id must
# match the CALLING agent's own directory (resolved from CWD, same philosophy
# as check-allowlist.sh) -- own-memory reads only, not parameterizable.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TOKEN_FILE="$ROOT/store/.dashboard-token"
BASE="http://localhost:3420/api/memories"

if [ $# -lt 2 ] || [ $# -gt 3 ]; then
  echo "usage: memo-search.sh <agent_id> <query> [category]" >&2
  exit 2
fi
agent_id="$1"; query="$2"; category="${3:-}"

case "$agent_id" in
  *[!a-z0-9-]*|'') echo "memo-search.sh: invalid agent_id" >&2; exit 2 ;;
esac
# Own-memory only: the caller's CWD must be the agent's own directory (or a
# subdirectory of it). Prevents cross-agent memory exfiltration via a spoofed
# agent_id from a prompt-injected session.
case "$PWD/" in
  "$ROOT/agents/$agent_id/"*) ;;
  *) echo "memo-search.sh: agent_id does not match calling agent dir (own memories only)" >&2; exit 2 ;;
esac
case "$category" in
  ''|hot|warm|cold|shared) ;;
  *) echo "memo-search.sh: category must be hot|warm|cold|shared" >&2; exit 2 ;;
esac
[ -n "$query" ] || { echo "memo-search.sh: empty query" >&2; exit 2; }
[ -r "$TOKEN_FILE" ] || { echo "memo-search.sh: token file not readable" >&2; exit 3; }

url="$(python3 - "$BASE" "$agent_id" "$query" "$category" <<'PYEOF'
import sys
from urllib.parse import urlencode
base, agent, q, cat = sys.argv[1:5]
params = {"agent": agent, "q": q}
if cat:
    params["category"] = cat
print(base + "?" + urlencode(params))
PYEOF
)"

curl -s -f -m 15 "$url" \
  -H "Authorization: Bearer $(cat "$TOKEN_FILE")" \
  || { echo "memo-search.sh: API call failed" >&2; exit 4; }
