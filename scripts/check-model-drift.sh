#!/usr/bin/env bash
# Silent-by-default MODEL-IDENTITY drift check, two detectors:
#   A) the latest session's MAIN-LOOP model vs the CONFIGURED model per agent
#   B) session-boundary model switches WITHOUT a config_change_log entry --
#      the primary detector. The switch MECHANISM is known and needs no
#      discovery (the Fable5 usage-credits startup dialog resolves to a model
#      choice at session start); what fails in practice is the LOGGING. By
#      2026-07-30 there were 5 dialog occurrences and only 3 log entries
#      (config_change_log 39, 41, 44): the 07-23 and 07-24 switches were
#      proven afterwards from session-level measurement only. A switch that
#      nobody wrote down is the signal -- and this also catches the case
#      where the CONFIG itself moved without anyone recording it, which the
#      plain config-vs-measured comparison is blind to.
#
# DANGER DETAIL for whoever meets the dialog next: its PRE-HIGHLIGHTED
# default is "Switch to Sonnet 5", so a careless Enter DOWNGRADES the agent.
# "Continue with Fable 5" must be selected deliberately (see log entry 39 vs
# 41 for both outcomes).
#
# WHY MODEL IDENTITY AND NOT COST (do not rewrite this into a cost monitor):
# the 2026-07-23/24 precedent -- an agent silently ran on the WRONG model for
# two days and it only surfaced afterwards, from backfilled data. That drift
# was NOT a cost problem but a CAPABILITY problem: it actually SAVED roughly
# 322 USD-equivalent, so any cost-based alerting would have been blind to it
# by construction. The only signal that catches it is comparing measured
# model identity against configured/logged model identity.
#
# Config sources (verified in src/web/agent-config.ts readModelFor()):
#   - MAIN agent (mr-wolfe): repo-root .claude/settings.json `model` field.
#     agents/mr-wolfe/agent-config.json is INERT for the main agent's launch
#     (channels.sh passes the settings.json value as --model) -- reading the
#     agent-config there would make this check report a false drift on
#     mr-wolfe every single round.
#   - Sub-agents (agents/<name>/): agents/<name>/agent-config.json `model`.
#
# Measurement source: store/claudeclaw.db token_usage. Schema facts that have
# already caused silent failures elsewhere, encoded so they are not
# rediscovered the hard way:
#   - token_usage.timestamp is a UNIX EPOCH INTEGER. Use
#     datetime(timestamp,'unixepoch','localtime'); date(timestamp,'localtime')
#     does NOT error -- it returns ZERO rows, i.e. a mute detector.
#   - the agent column is named `agent`, not `agent_id`.
#   - sessions are NOT single-model: subagent traffic (hard-coder on Opus,
#     haiku summarizers) logs under the SAME session_id, and can even
#     out-weigh the main loop (measured 2026-07-30: session 0ba2dcef fable
#     147k vs opus 130k). The main-loop model is therefore taken from the
#     session's FIRST rows (majority of the earliest 7), which was verified
#     correct on all 5 recent multi-model neo sessions -- NOT from total
#     token weight.
#   - tiny sessions are probes (model-fallback watcher runs 1-turn "ok"
#     probes on OTHER models); the weight floor below keeps them from
#     reading as switches.
#
# LIVENESS PREDICATES (2026-07-31 audit, RC-1/RC-2, predicates P1+P2). On
# 2026-07-31 16:38 this check produced two false alerts in one message, and
# fixing only the first cause would not have suppressed it:
#   P1 (RC-1) token_usage carries no `entrypoint` column and no tmux binding, so
#      a headless `claude -p` run (the fallback runner's model probe, the
#      audit-brief exporter, morning-briefing.sh) outranks the live agent the
#      moment it starts later. Verified that day: session 8dff4bdf (mr-wolfe's
#      dir) and c18e1438 (ive's dir) were both `sdk-cli`, answering sonnet and
#      haiku -- neither was a live agent. A measurement now counts only if the
#      session's OWN transcript, under THAT agent's project dir, carries
#      interactive (`entrypoint == "cli"`) assistant rows, and the agent has a
#      live tmux session.
#   P2 (RC-2) detector A measures the BOOT model (earliest rows), which never
#      changes for the life of a session -- so it re-alerts on a closed episode
#      forever. The live coordinator really did boot on sonnet at 15:01 and was
#      corrected at ~15:31; the 16:38 alert described that as current, 67
#      minutes after it ended. A boot mismatch is now vetoed when the LATEST
#      interactive main-loop turn is already on the configured model. This
#      mirrors src/model-fallback.ts's `already-recovered` veto, which the
#      in-process detector has had all along.
# Both predicates FAIL LOUD: when a transcript cannot be found or read the
# session is kept (this script is a backstop, and a silent backstop is none).
#
# Output contract (same as check-hook-drift.sh): NOTHING on stdout/stderr and
# exit 0 when clean. Any stdout + exit 1 means drift; the caller
# (model-drift-timer.sh) dedups and surfaces it. Every finding line starts
# with "  - " (the wrapper's dedup key depends on it).
set -euo pipefail

MARVEEN_ROOT="/home/szabgabor/marveen"
DB="$MARVEEN_ROOT/store/claudeclaw.db"
LOOKBACK_H="${LOOKBACK_H:-48}"       # session-boundary scan window
MIN_SESSION_TOKENS="${MIN_SESSION_TOKENS:-20000}"  # probe floor
LOG_GRACE_BEFORE_H=12                # a log entry this long BEFORE the boundary counts
LOG_GRACE_AFTER_H=2                  # ... or this long after (post-hoc logging)

# P1, part 2: which agents have a LIVE tmux session right now. A measurement
# from an agent that is not running is history, not drift. Collected here (tmux
# is not reachable from inside the heredoc's stdin-fed python) and passed in as
# a comma-separated list; an empty/failed tmux read yields an empty list, which
# the python side treats as "cannot tell" and does NOT use to suppress.
LIVE_SESSIONS="$(tmux list-sessions -F '#S' 2>/dev/null | tr '\n' ',' || true)"

python3 - "$MARVEEN_ROOT" "$DB" "$LOOKBACK_H" "$MIN_SESSION_TOKENS" \
          "$LOG_GRACE_BEFORE_H" "$LOG_GRACE_AFTER_H" "$LIVE_SESSIONS" <<'PYEOF'
import glob
import json
import os
import re
import sqlite3
import sys
from collections import Counter

(marveen_root, db_path, lookback_h, min_tokens,
 grace_before_h, grace_after_h, live_sessions_raw) = sys.argv[1:8]
lookback_h, min_tokens = int(lookback_h), int(min_tokens)
grace_before_s, grace_after_s = int(grace_before_h) * 3600, int(grace_after_h) * 3600
live_sessions = {s for s in live_sessions_raw.split(',') if s}

# Mirror of MODEL_ALIASES + DEFAULT_MODEL in src/web/agent-config.ts (the
# config files may legally contain an alias instead of a full model id).
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

def read_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return None

MAIN_AGENT = 'mr-wolfe'  # see the header: the main agent's config lives elsewhere

def tmux_session_for(agent):
    """The session name the dashboard runs this agent under (mirrors
    agentSessionName() / MAIN_CHANNELS_SESSION in src/web/)."""
    return f'{agent}-channels' if agent == MAIN_AGENT else f'agent-{agent}'

def transcript_path(agent, session_id):
    """The session's OWN transcript, searched only under THAT agent's project
    dirs -- a headless run in the main agent's dir must never be attributed to
    a sub-agent. Only the top level of each project dir is globbed, so the
    <session>/subagents/agent-*.jsonl sidecars CC 2.1.220 writes for Task-tool
    runs cannot be mistaken for the session log. Returns None when not found."""
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

# Tail size for the "latest turn" read: the transcripts are append-only and grow
# to tens of MB, so the whole file is never read (mirrors BOOT_SCAN_TAIL_BYTES
# in src/web/active-model.ts).
TAIL_BYTES = 2 * 1024 * 1024

def scan_transcript(path):
    """(has_cli, latest_main_loop_model) for one transcript.

    has_cli: does it carry ANY interactive assistant row? A file whose rows are
    all `sdk-cli` is a headless run -- the 16:38 false-positive class (P1).
    latest_main_loop_model: the model of the most recent interactive MAIN-LOOP
    turn (isSidechain false, so sub-agent traffic in the same session cannot
    answer for it), read from the tail. Backs the already-recovered veto (P2).
    """
    has_cli = False
    latest = None
    try:
        # Head pass: the first interactive row decides has_cli, cheaply.
        with open(path, encoding='utf-8', errors='replace') as f:
            for i, line in enumerate(f):
                if i > 400:
                    break
                try:
                    e = json.loads(line)
                except Exception:
                    continue
                if e.get('type') == 'assistant' and e.get('entrypoint') == 'cli':
                    has_cli = True
                    break
        # Tail pass: the newest interactive main-loop model.
        size = os.path.getsize(path)
        with open(path, 'rb') as f:
            if size > TAIL_BYTES:
                f.seek(size - TAIL_BYTES)
                f.readline()  # a byte offset lands mid-line; drop the partial
            for raw in f:
                try:
                    e = json.loads(raw.decode('utf-8', 'replace'))
                except Exception:
                    continue
                if e.get('type') != 'assistant' or e.get('entrypoint') != 'cli':
                    continue
                if e.get('isSidechain'):
                    continue
                m = (e.get('message') or {}).get('model')
                if isinstance(m, str) and m and not m.startswith('<'):
                    has_cli = True
                    latest = m
    except Exception:
        return has_cli, latest
    return has_cli, latest

problems = []

# Configured model per agent (see header for why mr-wolfe is special).
configured = {}
main_cfg = read_json(os.path.join(marveen_root, '.claude', 'settings.json'))
if isinstance(main_cfg, dict) and isinstance(main_cfg.get('model'), str):
    configured['mr-wolfe'] = main_cfg['model']
else:
    problems.append(f"  - mr-wolfe: nem olvashato a `model` a {marveen_root}/.claude/settings.json-bol")

agents_dir = os.path.join(marveen_root, 'agents')
for name in sorted(os.listdir(agents_dir)):
    if name == 'mr-wolfe':
        continue  # inert for the main agent, see header
    cfg = read_json(os.path.join(agents_dir, name, 'agent-config.json'))
    if isinstance(cfg, dict) and isinstance(cfg.get('model'), str):
        configured[name] = cfg['model']

con = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True)

# Per-session aggregates in the lookback window (probe sessions floored out).
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
    """Main-loop model: majority of the session's earliest 7 model-bearing
    rows (see header -- weight-dominance is wrong under subagent traffic)."""
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
    agent_model_dialog:<a>; mr-wolfe's main model may also be logged as
    agent_model:mr-wolfe.

    LOAD-BEARING CONVENTION -- do not "fix" it: for RECONSTRUCTED (backfilled)
    entries the created_at is the MEASURED session-boundary time, NOT the time
    the row was written (provenance lives in the value text instead; see
    entries 45-47). This is what makes the grace-window match below work for
    backfills. Rewriting created_at to the write time would silently re-open
    every backfilled boundary as an "unlogged switch" and the detector would
    re-alert on already-explained history."""
    rows = con.execute(
        "SELECT key, created_at FROM config_change_log WHERE key LIKE '%model%'",
    ).fetchall()
    return [ts for key, ts in rows if agent in key]

# P1: keep only sessions that are a LIVE agent's own interactive work. A
# transcript that cannot be found is KEPT (fail-loud: this is a backstop), but
# one that is provably headless is dropped, and so is every session of an agent
# with no running tmux session -- when tmux itself could not be read
# (live_sessions empty) that half of the predicate is skipped rather than
# suppressing everything.
transcript_cache = {}
sessions_by_agent = {}
for agent, sid, start_ts, end_ts, weight, start_local in sess_rows:
    if live_sessions and tmux_session_for(agent) not in live_sessions:
        continue
    path = transcript_path(agent, sid)
    if path is not None:
        has_cli, latest_model = scan_transcript(path)
        transcript_cache[(agent, sid)] = latest_model
        if not has_cli:
            continue  # headless probe / exporter run, not a live agent (P1)
    sessions_by_agent.setdefault(agent, []).append(
        (start_ts, end_ts, sid, weight, start_local))

for agent, cfg_model in sorted(configured.items()):
    sessions = sorted(sessions_by_agent.get(agent, []))
    if not sessions:
        continue  # no qualifying traffic in window -- not drift

    resolved = []
    for start_ts, end_ts, sid, weight, start_local in sessions:
        mm = main_model(agent, sid)
        if mm:
            resolved.append((start_ts, end_ts, sid, mm, start_local))

    # A) latest session's main-loop model vs configured, with the
    # already-recovered veto (P2): a BOOT measurement is a historical claim, so
    # a mismatch whose session has since been corrected is a closed episode, not
    # drift. Only a transcript-backed latest turn can veto -- an unknown latest
    # model leaves the finding standing.
    if resolved:
        start_ts, _end, sid, mm, start_local = resolved[-1]
        latest_model = transcript_cache.get((agent, sid))
        recovered = latest_model is not None and normalize(latest_model) == normalize(cfg_model)
        if normalize(mm) != normalize(cfg_model) and not recovered:
            problems.append(
                f"  - {agent}: MERT={mm} vs KONFIGURALT={cfg_model} "
                f"(utolso session {sid[:8]}, indult {start_local})")

    # B) session-boundary switches without a config_change_log entry.
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
    print(f"MODELL-DRIFT/NAPLOZASI-RES ({lookback_h}h ablak, "
          f"session-floor {min_tokens} token):")
    for line in problems:
        print(line)
    sys.exit(1)

sys.exit(0)
PYEOF
