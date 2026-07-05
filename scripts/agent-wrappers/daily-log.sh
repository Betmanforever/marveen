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
agent_id="$1"; content_arg="$2"

case "$agent_id" in
  *[!a-z0-9-]*|'') echo "daily-log.sh: invalid agent_id" >&2; exit 2 ;;
esac

# Content may be given inline or as `@<path>` to read from a file. daily-log
# entries start with `## HH:MM` headers, so an inline multi-line argument almost
# always contains a newline-then-`#`, which trips Claude Code's argument-safety
# guard and freezes a strict agent on an unattended prompt (root-caused
# 2026-07-05). SECURITY: @file is restricted to the calling agent's OWN dir
# (agents/<agent_id>/); an unfenced cat here would be a read-anything primitive
# that bypasses the agent's tool-layer Read denies. Do not relax the check.
if [ "${content_arg#@}" != "$content_arg" ]; then
  content="$(python3 - "$ROOT/agents/$agent_id" "${content_arg#@}" <<'PYEOF'
import os, sys
agent_root = os.path.realpath(sys.argv[1])
p = os.path.realpath(sys.argv[2])
if p != agent_root and not p.startswith(agent_root + os.sep):
    sys.stderr.write("content @file must be under the agent's own dir\n")
    sys.exit(9)
with open(p, encoding="utf-8") as f:
    sys.stdout.write(f.read())
PYEOF
)" || { echo "daily-log.sh: content @file rejected or unreadable" >&2; exit 2; }
else
  content="$content_arg"
fi

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
