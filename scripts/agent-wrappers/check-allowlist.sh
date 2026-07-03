#!/usr/bin/env bash
# check-allowlist.sh <sender_id>
#
# Auditor-approved fixed wrapper (2026-07-03): strict-profile agents
# (marketer/researcher) must NOT run free-form `python3 -c` to check whether a
# sender is paired. This script is the ONLY allow-listed way. It reads the
# CALLING agent's own channel access.json (resolved from the CWD, which is the
# agent's working directory -- the path is NOT parameterizable), and prints
# exactly MATCH or NO-MATCH. Read-only, no network, no other output.
set -euo pipefail

if [ $# -ne 1 ] || [ -z "$1" ]; then
  echo "usage: check-allowlist.sh <sender_id>" >&2
  exit 2
fi
sender="$1"

# Sender ids are numeric-ish channel ids; refuse anything shell/JSON-exotic so
# a prompt-injected "sender id" cannot smuggle payloads into the comparison.
case "$sender" in
  *[!A-Za-z0-9_-]*) echo "NO-MATCH"; exit 1 ;;
esac

found=0
for f in ./.claude/channels/*/access.json; do
  [ -f "$f" ] || continue
  if python3 - "$f" "$sender" <<'PYEOF'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(1)
sys.exit(0 if sys.argv[2] in d.get("allowFrom", []) else 1)
PYEOF
  then
    found=1
    break
  fi
done

if [ "$found" -eq 1 ]; then
  echo "MATCH"
  exit 0
fi
echo "NO-MATCH"
exit 1
