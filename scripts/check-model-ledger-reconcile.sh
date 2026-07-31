#!/usr/bin/env bash
# MODEL-LEDGER RECONCILIATION: did every model switch get written down?
#
# This is the governance half of the retired check-model-drift.sh (its
# "detector B"), rehomed as its own control on the 2026-07-31 audit's condition
# (AC-10): "the config_change_log reconciliation survives the cleanup as its own
# silent, coordinator-routed, daily check. It is not folded into the operational
# drift path, and its retirement is not implied by this card."
#
# WHY IT IS NOT AN OPERATIONAL CHECK (do not merge it back into a drift
# monitor): it does not ask "is an agent on the wrong model right now" -- the
# in-process model-fallback runner owns that question and answers it better
# (live tmux binding, entrypoint filter, already-recovered veto). It asks
# whether the AUDIT TRAIL is complete: by 2026-07-30 there had been 5 usage-
# dialog model switches and only 3 config_change_log entries (39, 41, 44); the
# 07-23 and 07-24 switches were reconstructed afterwards from measurement alone.
# A switch nobody wrote down is the signal, and it is also the only detector
# that catches the CONFIG itself moving unrecorded -- which a plain
# config-vs-measured comparison is blind to by construction.
#
# It never alerted falsely. Its noisy sibling (detector A) is retired.
#
# LIVENESS (audit P1): a session boundary only counts when both sides are a live
# agent's own INTERACTIVE work. Headless `claude -p` runs (the fallback runner's
# probe, the audit-brief exporter, morning-briefing.sh) write session logs into
# the same project dirs and would otherwise read as switches -- exactly the
# 2026-07-31 16:38 false-positive class (sessions 8dff4bdf sonnet, c18e1438
# haiku). Told apart by `entrypoint`.
#
# Schema facts already learned the hard way elsewhere, encoded so they are not
# rediscovered: token_usage.timestamp is a UNIX EPOCH INTEGER (date(...) returns
# ZERO rows, i.e. a mute detector); the column is `agent`, not `agent_id`;
# sessions are NOT single-model (subagent traffic logs under the same
# session_id), so the main-loop model comes from the session's FIRST rows, not
# from token weight.
#
# LOAD-BEARING CONVENTION for config_change_log: for RECONSTRUCTED (backfilled)
# entries created_at is the MEASURED boundary time, NOT the write time
# (provenance lives in the value text; see entries 45-47). That is what makes
# the grace-window match below work for backfills. "Fixing" it would re-open
# every backfilled boundary as an unlogged switch.
#
# Output contract: silent + exit 0 when clean; findings on stdout + exit 1. The
# caller (model-ledger-reconcile-timer.sh) dedups and routes to the coordinator.
# Every finding line starts with "  - " (the wrapper's dedup key depends on it).
set -euo pipefail

MARVEEN_ROOT="/home/szabgabor/marveen"
DB="$MARVEEN_ROOT/store/claudeclaw.db"
LOOKBACK_H="${LOOKBACK_H:-48}"                     # boundary scan window
MIN_SESSION_TOKENS="${MIN_SESSION_TOKENS:-20000}"  # probe floor
LOG_GRACE_BEFORE_H=12                              # a log entry this long BEFORE the boundary counts
LOG_GRACE_AFTER_H=2                                # ... or this long after (post-hoc logging)

python3 - "$MARVEEN_ROOT" "$DB" "$LOOKBACK_H" "$MIN_SESSION_TOKENS" \
          "$LOG_GRACE_BEFORE_H" "$LOG_GRACE_AFTER_H" <<'PYEOF'
import glob
import json
import os
import re
import sqlite3
import sys
from collections import Counter

(marveen_root, db_path, lookback_h, min_tokens,
 grace_before_h, grace_after_h) = sys.argv[1:7]
lookback_h, min_tokens = int(lookback_h), int(min_tokens)
grace_before_s, grace_after_s = int(grace_before_h) * 3600, int(grace_after_h) * 3600

MAIN_AGENT = 'mr-wolfe'

# Mirror of MODEL_ALIASES + DEFAULT_MODEL in src/web/agent-config.ts.
DEFAULT_MODEL = 'claude-sonnet-5'
MODEL_ALIASES = {
    'opus': 'claude-opus-5',
    'sonnet': 'claude-sonnet-5',
    'sonnet-5': 'claude-sonnet-5',
    'sonnet-4-6': 'claude-sonnet-4-6',
    'haiku': 'claude-haiku-4-5-20251001',
    'inherit': DEFAULT_MODEL,
}

def normalize(model):
    """Alias-resolve, strip the [1m] marker and a trailing -YYYYMMDD suffix."""
    m = MODEL_ALIASES.get(model, model)
    m = m.replace('[1m]', '')
    return re.sub(r'-20\d{6}$', '', m)

def transcript_path(agent, session_id):
    """The session's own transcript, under THAT agent's project dirs only.
    Top level only, so <session>/subagents/agent-*.jsonl sidecars cannot be
    mistaken for the session log."""
    if agent == MAIN_AGENT:
        roots = [os.path.join(os.path.expanduser('~'), '.claude', 'projects')]
    else:
        roots = [os.path.join(marveen_root, 'agents', agent, d, 'projects')
                 for d in ('.claude', '.claude-config')]
    for root in roots:
        hits = glob.glob(os.path.join(root, '*', f'{session_id}.jsonl'))
        if hits:
            return hits[0]
    return None

def is_interactive(session_id, agent):
    """True unless the transcript PROVES the session is headless. Fail-loud: an
    unfindable/unreadable transcript keeps the session, because a governance
    control that goes quiet on a missing file is not a control."""
    path = transcript_path(agent, session_id)
    if path is None:
        return True
    try:
        with open(path, encoding='utf-8', errors='replace') as f:
            saw_assistant = False
            for i, line in enumerate(f):
                if i > 400:
                    break
                try:
                    e = json.loads(line)
                except Exception:
                    continue
                if e.get('type') != 'assistant':
                    continue
                saw_assistant = True
                if e.get('entrypoint') == 'cli':
                    return True
            return not saw_assistant
    except Exception:
        return True

con = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True)

sess_rows = con.execute(
    """
    SELECT agent, session_id,
           MIN(timestamp) AS start_ts, MAX(timestamp) AS end_ts,
           SUM(input_tokens + output_tokens + cache_creation_tokens + thinking_tokens) AS weight,
           datetime(MIN(timestamp),'unixepoch','localtime') AS start_local
    FROM token_usage
    WHERE timestamp >= strftime('%s','now') - ? * 3600
      AND model IS NOT NULL AND model != '<synthetic>'
    GROUP BY agent, session_id
    HAVING weight >= ?
    """,
    (lookback_h, min_tokens),
).fetchall()

def main_model(agent, session_id):
    """Main-loop model: majority of the session's earliest 7 model-bearing rows
    (weight-dominance is wrong under subagent traffic)."""
    first = con.execute(
        """
        SELECT model FROM token_usage
        WHERE agent = ? AND session_id = ?
          AND model IS NOT NULL AND model != '<synthetic>'
        ORDER BY timestamp, id LIMIT 7
        """,
        (agent, session_id),
    ).fetchall()
    if not first:
        return None
    return Counter(m for (m,) in first).most_common(1)[0][0]

def model_log_entries(agent):
    """config_change_log rows that legitimize a model change for this agent.
    Key styles in the wild: agent_model:<a>, agent.<a>.model,
    agent_model_dialog:<a>, model-fallback:*."""
    rows = con.execute(
        "SELECT key, created_at FROM config_change_log WHERE key LIKE '%model%'",
    ).fetchall()
    return [ts for key, ts in rows if agent in key]

sessions_by_agent = {}
for agent, sid, start_ts, end_ts, weight, start_local in sess_rows:
    if not is_interactive(sid, agent):
        continue  # headless probe/exporter run -- not a session boundary (P1)
    sessions_by_agent.setdefault(agent, []).append(
        (start_ts, end_ts, sid, weight, start_local))

problems = []
for agent, sessions in sorted(sessions_by_agent.items()):
    resolved = []
    for start_ts, end_ts, sid, weight, start_local in sorted(sessions):
        mm = main_model(agent, sid)
        if mm:
            resolved.append((start_ts, end_ts, sid, mm, start_local))

    log_ts = model_log_entries(agent)
    for prev, cur in zip(resolved, resolved[1:]):
        p_start, p_end, p_sid, p_model, _pl = prev
        c_start, c_end, c_sid, c_model, c_local = cur
        if normalize(p_model) == normalize(c_model):
            continue
        if c_start < p_end:
            continue  # overlapping/parallel sessions, not a boundary
        logged = any(c_start - grace_before_s <= ts <= c_start + grace_after_s
                     for ts in log_ts)
        if not logged:
            problems.append(
                f"  - {agent}: NAPLOZATLAN MODELLVALTAS a session-hataron: "
                f"{p_model} ({p_sid[:8]}) -> {c_model} ({c_sid[:8]}, indult {c_local}) "
                f"-- nincs config_change_log bejegyzes a hatar korul "
                f"(-{grace_before_h}h..+{grace_after_h}h)")

con.close()

if problems:
    print(f"MODELL-NAPLOZASI RES ({lookback_h}h ablak, "
          f"session-floor {min_tokens} token):")
    for line in problems:
        print(line)
    sys.exit(1)

sys.exit(0)
PYEOF
