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
agent_id="$1"; content_arg="$2"

case "$agent_id" in
  *[!a-z0-9-]*|'') echo "msg-wolfe.sh: invalid agent_id" >&2; exit 2 ;;
esac
# Bind the claimed agent_id to the REAL caller: its CWD must be that agent's
# own directory. Without this, a prompt-injected agent could pass a spoofed
# agent_id and make the @file fence resolve into ANOTHER agent's dir (e.g.
# `msg-wolfe.sh alex @.../agents/alex/.env`), reading a peer's secrets. Same
# proven guard as memo-search.sh (2026-07-03). MUST precede the @file read.
case "$PWD/" in
  "$ROOT/agents/$agent_id/"*) ;;
  *) echo "msg-wolfe.sh: agent_id does not match calling agent dir" >&2; exit 2 ;;
esac

# Content may be given inline, or as `@<path>` to read from a file. The @file
# form exists because a multi-line inline argument that contains a newline
# immediately followed by `#` (common in these summaries: `\n#60 ...`, and in
# daily-log `\n## HH:MM`) trips Claude Code's argument-safety guard and freezes
# the strict agent on an unattended permission prompt (root-caused 2026-07-05).
# SECURITY: the @file is restricted to the calling agent's OWN directory
# (agents/<agent_id>/). Without that fence, `cat`-ing an arbitrary path here
# would hand a strict agent a read-anything primitive (the wrapper runs as the
# OS user and bypasses the agent's tool-layer Read denies) -- e.g. it could
# exfiltrate store/.dashboard-token into a message. The realpath prefix check
# below is the security boundary; do not relax it.
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
)" || { echo "msg-wolfe.sh: content @file rejected or unreadable" >&2; exit 2; }
else
  content="$content_arg"
fi

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
