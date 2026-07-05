#!/usr/bin/env bash
# memo.sh <agent_id> <category> <content> [keywords]
#
# Auditor-approved fixed wrapper (2026-07-03): strict-profile agents must NOT
# run free-form `curl -X POST/-d` (deny-listed). This script is the ONLY
# allow-listed way to save a memory. Endpoint and method are hardcoded; the
# Bearer token is read by the script itself from store/.dashboard-token (the
# model never sees it). No free URL or header parameters.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TOKEN_FILE="$ROOT/store/.dashboard-token"
ENDPOINT="http://localhost:3420/api/memories"

if [ $# -lt 3 ] || [ $# -gt 4 ]; then
  echo "usage: memo.sh <agent_id> <category> <content> [keywords]" >&2
  exit 2
fi
agent_id="$1"; category="$2"; content_arg="$3"; keywords="${4:-}"

# Validate the identity BEFORE any @file read (a traversal agent_id must not
# reach the file-open) and bind the claimed agent_id to the REAL caller: its
# CWD must be that agent's own dir. Without this, a prompt-injected agent could
# pass a spoofed agent_id so the @file fence resolves into another agent's dir
# and reads a peer's secrets. Proven guard from memo-search.sh (2026-07-03).
case "$agent_id" in
  *[!a-z0-9-]*|'') echo "memo.sh: invalid agent_id" >&2; exit 2 ;;
esac
case "$PWD/" in
  "$ROOT/agents/$agent_id/"*) ;;
  *) echo "memo.sh: agent_id does not match calling agent dir" >&2; exit 2 ;;
esac
case "$category" in
  hot|warm|cold|shared) ;;
  *) echo "memo.sh: category must be hot|warm|cold|shared" >&2; exit 2 ;;
esac

# Content may be given inline or as `@<path>` to read from a file, so multi-line
# memories whose text contains a newline-then-`#` don't trip Claude Code's
# argument-safety guard and freeze a strict agent (root-caused 2026-07-05).
# SECURITY: @file is restricted to the calling agent's OWN dir (verified above)
# -- an unfenced cat would be a read-anything primitive bypassing the agent's
# tool-layer Read denies. Do not relax the check.
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
)" || { echo "memo.sh: content @file rejected or unreadable" >&2; exit 2; }
else
  content="$content_arg"
fi

[ -n "$content" ] || { echo "memo.sh: empty content" >&2; exit 2; }
[ -r "$TOKEN_FILE" ] || { echo "memo.sh: token file not readable" >&2; exit 3; }

payload="$(python3 - "$agent_id" "$category" "$content" "$keywords" <<'PYEOF'
import json, sys
print(json.dumps({
    "agent_id": sys.argv[1],
    "category": sys.argv[2],
    "content": sys.argv[3],
    "keywords": sys.argv[4],
}))
PYEOF
)"

curl -s -f -m 15 -X POST "$ENDPOINT" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(cat "$TOKEN_FILE")" \
  --data "$payload" > /dev/null \
  && echo "OK: memory saved (${category})" \
  || { echo "memo.sh: save failed" >&2; exit 4; }
