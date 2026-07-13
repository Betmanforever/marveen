#!/usr/bin/env bash
# taskstate.sh <agent_id> <json|@path>
#
# Fixed wrapper (2026-07-13, same class as memo.sh/daily-log.sh): strict-profile
# agents must NOT run free-form `curl -X POST/-d` (deny-listed), but the
# PreCompact hook needs to persist the compact task-state record. This script is
# the ONLY allow-listed way to write it. Endpoint and method are hardcoded; the
# Bearer token is read by the script itself from store/.dashboard-token (the
# model never sees it). The JSON body is validated against the fixed
# agent-taskstate field set, so no free-form payload reaches the API.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TOKEN_FILE="$ROOT/store/.dashboard-token"

if [ $# -ne 2 ]; then
  echo "usage: taskstate.sh <agent_id> <json|@path>" >&2
  exit 2
fi
agent_id="$1"; json_arg="$2"

# Validate the identity BEFORE any @file read and bind the claimed agent_id to
# the REAL caller: its CWD must be that agent's own dir. Proven guard from
# memo-search.sh (2026-07-03) -- without it a spoofed agent_id could point the
# @file fence into another agent's directory.
case "$agent_id" in
  *[!a-z0-9-]*|'') echo "taskstate.sh: invalid agent_id" >&2; exit 2 ;;
esac
case "$PWD/" in
  "$ROOT/agents/$agent_id/"*) ;;
  *) echo "taskstate.sh: agent_id does not match calling agent dir" >&2; exit 2 ;;
esac

# JSON may be given inline or as `@<path>` to read from a file, so multi-line
# records don't trip Claude Code's newline+`#` argument-safety guard (the same
# freeze class root-caused 2026-07-05). SECURITY: @file is restricted to the
# calling agent's OWN dir -- an unfenced read would bypass tool-layer denies.
if [ "${json_arg#@}" != "$json_arg" ]; then
  raw="$(python3 - "$ROOT/agents/$agent_id" "${json_arg#@}" <<'PYEOF'
import os, sys
agent_root = os.path.realpath(sys.argv[1])
p = os.path.realpath(sys.argv[2])
if p != agent_root and not p.startswith(agent_root + os.sep):
    sys.stderr.write("json @file must be under the agent's own dir\n")
    sys.exit(9)
with open(p, encoding="utf-8") as f:
    sys.stdout.write(f.read())
PYEOF
)" || { echo "taskstate.sh: json @file rejected or unreadable" >&2; exit 2; }
else
  raw="$json_arg"
fi

[ -r "$TOKEN_FILE" ] || { echo "taskstate.sh: token file not readable" >&2; exit 3; }

# Validate shape: object with ONLY the known agent-taskstate fields, correct
# types. Rejecting unknown keys keeps this wrapper a fixed-function endpoint,
# not a generic POST primitive.
payload="$(python3 - "$raw" <<'PYEOF'
import json, sys
try:
    d = json.loads(sys.argv[1])
except Exception:
    sys.stderr.write("invalid JSON\n"); sys.exit(9)
if not isinstance(d, dict):
    sys.stderr.write("payload must be a JSON object\n"); sys.exit(9)
STR = ("summary", "nextAction", "pendingDecision")
LST = ("doneSteps", "alreadyDelegated")
for k, v in d.items():
    if k in STR:
        if not isinstance(v, str): sys.stderr.write(f"{k} must be a string\n"); sys.exit(9)
    elif k in LST:
        if not (isinstance(v, list) and all(isinstance(x, str) for x in v)):
            sys.stderr.write(f"{k} must be a list of strings\n"); sys.exit(9)
    else:
        sys.stderr.write(f"unknown field: {k}\n"); sys.exit(9)
print(json.dumps(d))
PYEOF
)" || { echo "taskstate.sh: payload rejected" >&2; exit 2; }

ENDPOINT="http://localhost:3420/api/agent-taskstate/$agent_id"

curl -s -f -m 15 -X POST "$ENDPOINT" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(cat "$TOKEN_FILE")" \
  --data "$payload" > /dev/null \
  && echo "OK: task-state saved" \
  || { echo "taskstate.sh: API call failed" >&2; exit 4; }
