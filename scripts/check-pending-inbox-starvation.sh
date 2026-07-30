#!/usr/bin/env bash
# Silent-by-default check for the hook-mode (pull) inbox delivery gap
# (2026-07-29, mr-wolfe/neo incident). A hook-mode agent (the main agent
# always, plus any sub-agent flipped to 'hook' in
# store/agent-delivery-config.json) claims its own inbox ONLY when its
# UserPromptSubmit drain-hook fires -- which requires a genuinely NEW turn,
# not a mid-turn message injection and not a SessionStart:compact/resume.
# An agent stuck in one long-running turn (30-45+ min observed) therefore
# stops draining silently: messages sit 'pending', delivered_at NULL, with
# no error anywhere except a single unstructured "Inter-agent message queue
# starving" log line -- which nobody was alerted on until a human noticed by
# reading a peer's own message history.
#
# This is the SAME class of gap the existing 'pending-uzenet-watchdog'
# heartbeat covers for the push (legacy) path, but that heartbeat's own
# firing is itself turn-dependent on the agent running it -- it cannot
# reliably catch a hook-mode agent that has gone silent for the same reason
# it is trying to detect. This script is meant to be run from a host-level
# cron/heartbeat OUTSIDE any single agent's turn cycle (mr-wolfe's
# folyamatos-ellenorzes), so detection does not depend on the very turn
# cycle that can fail.
#
# Logic lives HERE, not in a heartbeat prompt -- same principle as
# check-hook-drift.sh: a deterministic DB query needs no judgment, so it
# does not belong in an agent's context at all.
#
# Output contract: NOTHING on stdout/stderr and exit 0 when clean. Any
# exit !=0 or any stdout line means "look at this" -- the caller should
# surface it (Telegram/reply), not parse it further.
set -euo pipefail

MARVEEN_ROOT="/home/szabgabor/marveen"
DB_PATH="$MARVEEN_ROOT/store/claudeclaw.db"
DELIVERY_CONFIG="$MARVEEN_ROOT/store/agent-delivery-config.json"
ENV_FILE="$MARVEEN_ROOT/.env"
THRESHOLD_MIN="${THRESHOLD_MIN:-10}"

python3 - "$DB_PATH" "$DELIVERY_CONFIG" "$ENV_FILE" "$THRESHOLD_MIN" <<'PYEOF'
import json
import os
import sqlite3
import sys

db_path, delivery_config_path, env_path, threshold_min = sys.argv[1:5]
threshold_min = float(threshold_min)

# Main agent id: same fail-safe default as src/config.ts (MAIN_AGENT_ID),
# read from .env so this never hardcodes an install-specific value.
main_agent_id = "marveen"
try:
    with open(env_path) as f:
        for line in f:
            if line.startswith("MAIN_AGENT_ID="):
                main_agent_id = line.split("=", 1)[1].strip()
except Exception:
    pass

# Hook-mode (pull) agent set: the main agent always (isPullModeAgent's
# unconditional branch), plus any agent explicitly flipped to 'hook' in the
# delivery config. A missing/corrupt config -> only the main agent (the
# fail-safe default is 'legacy' for everyone else, matching
# delivery-config.ts).
pull_agents = {main_agent_id}
try:
    with open(delivery_config_path) as f:
        cfg = json.load(f)
    for agent, mode in (cfg.get("agents") or {}).items():
        if mode == "hook":
            pull_agents.add(agent)
except Exception:
    pass

conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row
placeholders = ",".join("?" for _ in pull_agents)
rows = conn.execute(
    f"""
    SELECT id, from_agent, to_agent, created_at,
           (unixepoch() - created_at) / 60.0 AS age_min
    FROM agent_messages
    WHERE status = 'pending'
      AND delivered_at IS NULL
      AND to_agent IN ({placeholders})
      AND (unixepoch() - created_at) > ? * 60
    ORDER BY created_at
    """,
    (*pull_agents, threshold_min),
).fetchall()

if not rows:
    sys.exit(0)

print(f"HOOK-MODE INBOX STARVATION DETECTED (threshold={threshold_min:.0f}min, pull_agents={sorted(pull_agents)}):")
for r in rows:
    print(f"  - id={r['id']} from={r['from_agent']} to={r['to_agent']} age={r['age_min']:.1f}min")
print("Likely cause: the target agent has been in one continuous turn since before the oldest "
      "row above was created, so its UserPromptSubmit drain-hook has not re-fired. A wake-nudge "
      "alone will NOT fix this (see marveen incident 2026-07-29) -- the target needs a genuinely "
      "new turn (a real user/scheduled prompt, or a session restart).")
sys.exit(1)
PYEOF
