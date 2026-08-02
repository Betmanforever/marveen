#!/usr/bin/env bash
# Silent-by-default drift check for the skill-index-autoregen PostToolUse hook
# across the 5 fleet registration points (0123b6bd, 2026-07-29).
#
# SCOPE: this script proves REGISTRATION only. A green result here does NOT
# mean the hook fired or the index is fresh. If you are investigating a
# suspected missed regen:
#   - the canonical run register is store/skill-index-autoregen.log
#     (QUEUE lines = hook fired, OK/FAIL lines = regen outcome) -- read THAT,
#     not the index mtime;
#   - the hook is DEBOUNCED (45s quiet window + regen runtime), so for ~1-2
#     minutes after an edit burst the index legitimately predates the newest
#     SKILL.md -- a mid-window mtime read is not a miss (2026-08-02 lesson);
#   - the output-side guard is check-skill-index-freshness.sh (grace-aware);
#     run that instead of comparing mtimes by hand. This is a NET,
# not the primary defense -- the primary defense is templates/settings.json.template
# (single source, applied via the idempotent ensureAgentHooks() merge on every
# dashboard startup AND every agent spawn). This script exists only to catch a
# future hand-edit or partial migration that silently diverges one of the five
# files from the rest, same failure class as the 2026-07-29 gmail-zenom
# per-agent .mcp.json drift and the near-miss where the hook almost went into
# ~/.claude/settings.json only (which does not cover the sub-agents).
#
# Logic lives HERE, not in a heartbeat prompt: prose in a scheduled-task prompt
# re-costs tokens every firing (measured ~61-68k tokens/agent per session entry,
# 2026-07-29). A deterministic comparison needs no judgment, so it does not
# belong in the agent's context at all -- same principle that removed Bash from
# skill-writer.
#
# Output contract: NOTHING on stdout/stderr and exit 0 when all five agree.
# Any exit !=0 or any stdout line means "look at this" -- the caller (a
# heartbeat prompt) should surface it, not parse it further.
set -euo pipefail

MARVEEN_ROOT="/home/szabgabor/marveen"
HOOK_BASENAME="skill-index-autoregen.py"
MATCHER="Write|Edit"

python3 - "$MARVEEN_ROOT" "$HOOK_BASENAME" "$MATCHER" <<'PYEOF'
import json
import sys
import os

marveen_root, hook_basename, matcher = sys.argv[1:4]

targets = {
    "mr-wolfe": os.path.join(marveen_root, ".claude", "settings.json"),
    "neo": os.path.join(marveen_root, "agents", "neo", ".claude", "settings.json"),
    "alex": os.path.join(marveen_root, "agents", "alex", ".claude", "settings.json"),
    "charlie": os.path.join(marveen_root, "agents", "charlie", ".claude", "settings.json"),
    "ive": os.path.join(marveen_root, "agents", "ive", ".claude", "settings.json"),
}

def has_hook(settings_path):
    if not os.path.exists(settings_path):
        return False, f"file missing: {settings_path}"
    try:
        with open(settings_path) as f:
            data = json.load(f)
    except Exception as e:
        return False, f"unparseable JSON: {e}"
    post = (data.get("hooks") or {}).get("PostToolUse")
    if not isinstance(post, list):
        return False, "no PostToolUse block at all"
    for group in post:
        if not isinstance(group, dict):
            continue
        if group.get("matcher") != matcher:
            continue
        for h in group.get("hooks") or []:
            cmd = h.get("command", "")
            if cmd.endswith(hook_basename) or f"/{hook_basename}" in cmd:
                return True, None
    return False, f"no PostToolUse group with matcher '{matcher}' referencing {hook_basename}"

problems = []
for agent, path in targets.items():
    ok, reason = has_hook(path)
    if not ok:
        problems.append(f"{agent}: {reason} ({path})")

if problems:
    print(f"HOOK DRIFT DETECTED ({hook_basename}, matcher={matcher!r}):")
    for p in problems:
        print(f"  - {p}")
    sys.exit(1)

sys.exit(0)
PYEOF
