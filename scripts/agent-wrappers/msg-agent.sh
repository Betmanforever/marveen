#!/usr/bin/env bash
# msg-agent.sh <from_agent_id> <to_agent_id> <content>
#
# Direct agent-to-agent inter-agent message wrapper for strict-profile agents
# (card 09485ee9, 2026-07-31). msg-wolfe.sh hardcodes the recipient to mr-wolfe,
# so a strict agent (Ive/Alex/Charlie) can only reach the coordinator, never a
# peer directly -- and free-form `curl -X POST` is deny-listed on strict
# profiles (freezes on an unattended approval prompt). This is the allow-listed
# way to send to ANY fleet agent. Endpoint/method/token are handled here exactly
# as in msg-wolfe.sh; only the recipient becomes a (validated) parameter.
#
# Every security property is inherited from msg-wolfe.sh deliberately -- do not
# drop any of them:
#   - the claimed from_agent_id is bound to the REAL caller via a CWD fence
#     (a prompt-injected agent cannot spoof another's id to read its files);
#   - the @file content form is restricted to the caller's OWN agent dir
#     (realpath prefix), so the wrapper -- which runs as the OS user and
#     bypasses the agent's tool-layer Read denies -- is not a read-anything
#     primitive;
#   - the Bearer token is read by the script from store/.dashboard-token; the
#     model never sees it, and there is no free URL/header parameter.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TOKEN_FILE="$ROOT/store/.dashboard-token"
ENDPOINT="http://localhost:3420/api/messages"

if [ $# -ne 3 ]; then
  echo "usage: msg-agent.sh <from_agent_id> <to_agent_id> <content>" >&2
  exit 2
fi
from_agent="$1"; to_agent="$2"; content_arg="$3"

case "$from_agent" in
  *[!a-z0-9-]*|'') echo "msg-agent.sh: invalid from_agent_id" >&2; exit 2 ;;
esac
case "$to_agent" in
  *[!a-z0-9-]*|'') echo "msg-agent.sh: invalid to_agent_id" >&2; exit 2 ;;
esac

# Recipient allowlist (defense in depth on top of the API's own live-agent
# check): the target must be a real fleet agent -- either mr-wolfe (the main
# coordinator, which has no agents/<name> dir) or a directory under agents/.
# A typo'd or injected recipient is rejected here rather than reaching the API.
if [ "$to_agent" != "mr-wolfe" ] && [ ! -d "$ROOT/agents/$to_agent" ]; then
  echo "msg-agent.sh: unknown recipient '$to_agent' (not mr-wolfe, no agents/$to_agent dir)" >&2
  exit 2
fi
# A message from an agent to itself is almost certainly a mistake (and the
# self-pace gate forbids self-addressed prompts); reject it explicitly.
if [ "$from_agent" = "$to_agent" ]; then
  echo "msg-agent.sh: from and to are the same agent" >&2; exit 2
fi

# Bind the claimed from_agent_id to the REAL caller: its CWD must be that
# agent's own directory. MUST precede the @file read. Same proven guard as
# msg-wolfe.sh / memo-search.sh (2026-07-03).
case "$PWD/" in
  "$ROOT/agents/$from_agent/"*) ;;
  *) echo "msg-agent.sh: from_agent_id does not match calling agent dir" >&2; exit 2 ;;
esac

# Content: inline, or `@<path>` to read from a file (the @file form avoids the
# newline+`#` / glob-shaped argument-guard freeze on strict profiles). SECURITY:
# the @file is fenced to the calling agent's OWN directory by realpath prefix
# -- do not relax it (see the msg-wolfe.sh header for why this is the boundary).
if [ "${content_arg#@}" != "$content_arg" ]; then
  content="$(python3 - "$ROOT/agents/$from_agent" "${content_arg#@}" <<'PYEOF'
import os, sys
agent_root = os.path.realpath(sys.argv[1])
p = os.path.realpath(sys.argv[2])
if p != agent_root and not p.startswith(agent_root + os.sep):
    sys.stderr.write("content @file must be under the agent's own dir\n")
    sys.exit(9)
with open(p, encoding="utf-8") as f:
    sys.stdout.write(f.read())
PYEOF
)" || { echo "msg-agent.sh: content @file rejected or unreadable" >&2; exit 2; }
else
  content="$content_arg"
fi

[ -n "$content" ] || { echo "msg-agent.sh: empty content" >&2; exit 2; }
[ -r "$TOKEN_FILE" ] || { echo "msg-agent.sh: token file not readable" >&2; exit 3; }

payload="$(python3 - "$from_agent" "$to_agent" "$content" <<'PYEOF'
import json, sys
print(json.dumps({"from": sys.argv[1], "to": sys.argv[2], "content": sys.argv[3]}))
PYEOF
)"

curl -s -f -m 15 -X POST "$ENDPOINT" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(cat "$TOKEN_FILE")" \
  --data "$payload" > /dev/null \
  && echo "OK: message sent to ${to_agent}" \
  || { echo "msg-agent.sh: send failed" >&2; exit 4; }
