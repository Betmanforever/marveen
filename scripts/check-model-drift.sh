#!/usr/bin/env bash
# Silent-by-default MODEL-IDENTITY drift check: compares the model MEASURED in
# token_usage against the model CONFIGURED for each fleet agent, and speaks
# only on mismatch.
#
# WHY MODEL IDENTITY AND NOT COST (do not rewrite this into a cost monitor):
# the 2026-07-23/24 precedent -- an agent silently ran on the WRONG model for
# two days and it only surfaced afterwards, from backfilled data. That drift
# was NOT a cost problem but a CAPABILITY problem: it actually SAVED roughly
# 322 USD-equivalent, so any cost-based alerting would have been blind to it
# by construction. The failure mode is "the fleet quietly runs dumber (or
# just different) than configured", and the only signal that catches it is
# comparing measured model id vs configured model id.
#
# Config sources (verified in src/web/agent-config.ts readModelFor()):
#   - MAIN agent (mr-wolfe): repo-root .claude/settings.json `model` field.
#     agents/mr-wolfe/agent-config.json is INERT for the main agent's launch
#     (channels.sh passes the settings.json value as --model) -- reading the
#     agent-config there would make this check report a false drift on
#     mr-wolfe every single round.
#   - Sub-agents (agents/<name>/): agents/<name>/agent-config.json `model`.
#
# Measurement source: store/claudeclaw.db token_usage. Two schema facts that
# have already caused silent failures elsewhere, encoded here so they are not
# rediscovered the hard way:
#   - token_usage.timestamp is a UNIX EPOCH INTEGER. Use
#     datetime(timestamp,'unixepoch','localtime'); date(timestamp,'localtime')
#     does NOT error -- it returns ZERO rows, i.e. a mute detector.
#   - the agent column is named `agent`, not `agent_id`.
#
# Dominance weighting: within the window the models are ranked by token volume
# (input+output+cache_creation+thinking), not row count, and rows with model
# NULL or '<synthetic>' are excluded. Small background calls (e.g. haiku
# summarizers) therefore cannot outvote the session model; additionally haiku
# rows are ignored outright unless haiku IS the configured model, so an
# almost-idle agent whose only window traffic is background haiku does not
# false-alarm.
#
# Output contract (same as check-hook-drift.sh): NOTHING on stdout/stderr and
# exit 0 when every measured agent matches its configured model. Any stdout
# line + exit 1 means drift; the caller (model-drift-timer.sh) surfaces it.
# An agent with no token rows in the window is silently skipped -- absence of
# traffic is not drift.
set -euo pipefail

MARVEEN_ROOT="/home/szabgabor/marveen"
DB="$MARVEEN_ROOT/store/claudeclaw.db"
WINDOW_MIN="${WINDOW_MIN:-180}"

python3 - "$MARVEEN_ROOT" "$DB" "$WINDOW_MIN" <<'PYEOF'
import json
import os
import re
import sqlite3
import sys

marveen_root, db_path, window_min = sys.argv[1], sys.argv[2], int(sys.argv[3])

# Mirror of MODEL_ALIASES + DEFAULT_MODEL in src/web/agent-config.ts (the
# config files may legally contain an alias instead of a full model id).
DEFAULT_MODEL = 'claude-sonnet-5'
MODEL_ALIASES = {
    'opus': 'claude-opus-4-8[1m]',
    'sonnet': 'claude-sonnet-5',
    'sonnet-5': 'claude-sonnet-5',
    'sonnet-4-6': 'claude-sonnet-4-6',
    'haiku': 'claude-haiku-4-5-20251001',
    'inherit': DEFAULT_MODEL,
}

def normalize(model):
    """Alias-resolve, then strip the [1m] context marker and a trailing
    -YYYYMMDD date suffix, so 'claude-opus-4-8[1m]' == 'claude-opus-4-8' and
    'claude-haiku-4-5-20251001' == 'claude-haiku-4-5'."""
    m = MODEL_ALIASES.get(model, model)
    m = m.replace('[1m]', '')
    return re.sub(r'-20\d{6}$', '', m)

def read_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return None

# Configured model per agent.
configured = {}
main_cfg = read_json(os.path.join(marveen_root, '.claude', 'settings.json'))
if isinstance(main_cfg, dict) and isinstance(main_cfg.get('model'), str):
    configured['mr-wolfe'] = main_cfg['model']
else:
    print(f"mr-wolfe: cannot read `model` from {marveen_root}/.claude/settings.json")

agents_dir = os.path.join(marveen_root, 'agents')
for name in sorted(os.listdir(agents_dir)):
    if name == 'mr-wolfe':
        continue  # inert for the main agent, see header
    cfg = read_json(os.path.join(agents_dir, name, 'agent-config.json'))
    if isinstance(cfg, dict) and isinstance(cfg.get('model'), str):
        configured[name] = cfg['model']

# Measured token volume per (agent, model) in the window.
con = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True)
rows = con.execute(
    """
    SELECT agent, model,
           SUM(input_tokens + output_tokens + cache_creation_tokens + thinking_tokens) AS weight,
           MAX(datetime(timestamp,'unixepoch','localtime')) AS last_seen
    FROM token_usage
    WHERE timestamp >= strftime('%s','now') - ? * 60
      AND model IS NOT NULL AND model != '<synthetic>'
    GROUP BY agent, model
    """,
    (window_min,),
).fetchall()
con.close()

measured = {}
for agent, model, weight, last_seen in rows:
    measured.setdefault(agent, []).append((weight or 0, model, last_seen))

drift = []
for agent, cfg_model in configured.items():
    candidates = measured.get(agent, [])
    if normalize(cfg_model) != normalize(MODEL_ALIASES['haiku']):
        candidates = [c for c in candidates if not c[1].startswith('claude-haiku')]
    if not candidates:
        continue  # no traffic in window -- not drift
    weight, dominant, last_seen = max(candidates)
    if normalize(dominant) != normalize(cfg_model):
        drift.append(
            f"  - {agent}: MERT={dominant} vs KONFIGURALT={cfg_model} "
            f"({weight} token a {window_min} perces ablakban, utolso sor: {last_seen})"
        )

if drift:
    print(f"MODELL-DRIFT ({window_min} perces ablak, sulyozas: tokenvolumen):")
    for line in drift:
        print(line)
    sys.exit(1)

sys.exit(0)
PYEOF
