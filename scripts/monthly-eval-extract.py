#!/usr/bin/env python3
"""Monthly model-agent evaluation raw-data extractor (kanban #FD97334A).

Collects the per-agent raw signals defined in
agents/neo/deliverables/modell-agent-metrikak.md (M1-M5, plus the
memory/message slices of M6) for one calendar month. The scoring,
trigger evaluation and reassignment proposals (see
agents/neo/deliverables/modell-ujrakiosztas-logika.md) are done by the
monthly report agent -- this script is deterministic on purpose.

NOTE: task_runs only records fired/skipped (dispatch, not outcome) --
result-status extension was explicitly deferred by mr-wolfe. Stall
signals therefore combine skipped counts with log-file events.

Usage:
  monthly-eval-extract.py                 # previous calendar month
  monthly-eval-extract.py --month 2026-06
"""

import argparse
import datetime as dt
import glob
import json
import os
import re
import sqlite3
import subprocess
import sys
from zoneinfo import ZoneInfo

REPO = "/home/szabgabor/marveen"
DB = f"{REPO}/store/claudeclaw.db"
TZ = ZoneInfo("Europe/Budapest")

FIX_PREFIXES = ("fix", "security", "revert", "hotfix")
# assignee spellings seen in kanban -> canonical agent_id; non-agents map to None
ASSIGNEE_MAP = {"mr. wolfe": "mr-wolfe"}
NON_AGENTS = {"szabó gábor", "szabo gabor", "gábor", "gabor"}
CORRECTION_RX = re.compile(
    r"\b(jav[ií]t|hib[aá]s|rossz|ne [ií]gy|nem ezt|helyette|[uú]jra|korrekci[oó]|t[eé]ved)", re.I)
AUDIT_RX = re.compile(r"\b(audit|auditor|verdikt|PASS[- ]?COND|PASS WITH|FAIL)\b", re.I)
STALL_RX = re.compile(r"\b(parked|stuck|beragad|pending|megakad|deadlock|restart)\b", re.I)


def month_bounds(arg: str | None) -> tuple[str, dt.date, dt.date]:
    if arg:
        first = dt.date.fromisoformat(arg + "-01")
    else:
        today = dt.datetime.now(TZ).date()
        first = (today.replace(day=1) - dt.timedelta(days=1)).replace(day=1)
    nxt = (first.replace(day=28) + dt.timedelta(days=4)).replace(day=1)
    return first.strftime("%Y-%m"), first, nxt - dt.timedelta(days=1)


def to_epoch(d: dt.date, end: bool) -> int:
    t = dt.time(23, 59, 59) if end else dt.time(0, 0, 0)
    return int(dt.datetime.combine(d, t, tzinfo=TZ).timestamp())


def canon_assignee(name: str | None) -> str | None:
    if not name:
        return None
    low = name.strip().lower()
    if low in NON_AGENTS:
        return None
    return ASSIGNEE_MAP.get(low, low)


def read_assignment() -> dict:
    # main agent (mr-wolfe): model comes from the repo-level .claude/settings.json
    try:
        wolfe = json.load(open(f"{REPO}/.claude/settings.json")).get("model")
    except (OSError, json.JSONDecodeError):
        wolfe = None
    assignment = {"mr-wolfe": wolfe}
    for cfg in sorted(glob.glob(f"{REPO}/agents/*/agent-config.json")):
        agent = os.path.basename(os.path.dirname(cfg))
        try:
            assignment[agent] = json.load(open(cfg)).get("model")
        except (OSError, json.JSONDecodeError):
            assignment[agent] = None
    return assignment


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--month", help="calendar month like 2026-06 (default: previous)")
    args = ap.parse_args()

    month_id, first, last = month_bounds(args.month)
    ep0, ep1 = to_epoch(first, False), to_epoch(last, True)
    conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    agents: dict[str, dict] = {}

    def bucket(agent: str | None) -> dict | None:
        if not agent:
            return None
        return agents.setdefault(agent, {
            "m1_done_cards": [], "m1_daily_log_entries": 0, "m1_tokens": {},
            "m2_cold_memories": [], "m3_task_title_repeats": [],
            "m3_correction_comments": [], "m4_audit_memories": [],
            "m5_task_runs": {}, "m5_stall_memories": [],
            "m6_correction_memories": [], "m6_inbound_corrections": [],
            # M7 (kanban #87a97029): estimate-vs-actual work-time accuracy.
            "m7_estimation": {"samples": [], "hits": 0, "n": 0},
        })

    # M1: done kanban cards (updated_at approximates the closing time -- no
    # status-history table exists; flagged in caveats).
    for r in conn.execute(
            "SELECT id, title, assignee, updated_at FROM kanban_cards"
            " WHERE status='done' AND updated_at BETWEEN ? AND ?", (ep0, ep1)):
        b = bucket(canon_assignee(r["assignee"]))
        if b is not None:
            b["m1_done_cards"].append({"id": r["id"], "title": r["title"]})

    # M7 (kanban #87a97029): estimate-vs-actual work-time accuracy. For cards
    # with BOTH an estimate and full work timing, record the actual/estimated
    # ratio and whether it lands in the 0.9-1.1 target band (the 90% goal), per
    # assignee -> the report correlates accuracy with the agent's model (via
    # assignment_now). Defensive: the estimate/timing columns are a newer
    # migration; on a DB that predates it, skip M7 rather than erroring.
    try:
        m7_rows = conn.execute(
            "SELECT id, assignee, estimated_hours, work_started_at, work_completed_at"
            " FROM kanban_cards WHERE status='done' AND updated_at BETWEEN ? AND ?"
            " AND estimated_hours IS NOT NULL AND work_started_at IS NOT NULL"
            " AND work_completed_at IS NOT NULL", (ep0, ep1)).fetchall()
    except sqlite3.OperationalError:
        m7_rows = []
    for r in m7_rows:
        b = bucket(canon_assignee(r["assignee"]))
        if b is None:
            continue
        est, ws, wc = r["estimated_hours"], r["work_started_at"], r["work_completed_at"]
        if est and est > 0 and wc >= ws:
            actual = (wc - ws) / 3600.0
            ratio = actual / est
            hit = 0.9 <= ratio <= 1.1
            m7 = b["m7_estimation"]
            m7["samples"].append({"id": r["id"], "estimated_h": est,
                                  "actual_h": round(actual, 2), "ratio": round(ratio, 2), "hit": hit})
            m7["n"] += 1
            m7["hits"] += 1 if hit else 0

    for r in conn.execute(
            "SELECT agent_id, COUNT(*) n FROM daily_logs WHERE date >= ? AND date <= ?"
            " GROUP BY agent_id", (first.isoformat(), last.isoformat())):
        b = bucket(canon_assignee(r["agent_id"]))
        if b is not None:
            b["m1_daily_log_entries"] = r["n"]

    for r in conn.execute(
            "SELECT agent, SUM(input_tokens) i, SUM(output_tokens) o,"
            " SUM(cache_read_tokens) cr, SUM(cache_creation_tokens) cc"
            " FROM token_usage WHERE timestamp BETWEEN ? AND ? GROUP BY agent",
            (ep0, ep1)):
        b = bucket(canon_assignee(r["agent"]))
        if b is not None:
            b["m1_tokens"] = {"input": r["i"], "output": r["o"],
                              "cache_read": r["cr"], "cache_creation": r["cc"]}

    # M2 / M4 / M5 / M6: memories in window, classified by content patterns.
    # Caveat (metrika-doc M2): agent_id marks the DOCUMENTER, not the culprit.
    for r in conn.execute(
            "SELECT id, agent_id, category, content, keywords, created_at FROM memories"
            " WHERE created_at BETWEEN ? AND ?", (ep0, ep1)):
        b = bucket(canon_assignee(r["agent_id"]))
        if b is None:
            continue
        entry = {"id": r["id"], "category": r["category"],
                 "keywords": r["keywords"], "preview": (r["content"] or "")[:200]}
        text = (r["content"] or "") + " " + (r["keywords"] or "")
        if r["category"] == "cold":
            b["m2_cold_memories"].append(entry)
        if AUDIT_RX.search(text):
            b["m4_audit_memories"].append(entry)
        if STALL_RX.search(text):
            b["m5_stall_memories"].append(entry)
        if CORRECTION_RX.search(text):
            b["m6_correction_memories"].append(entry)

    # M3: repeated task titles in token_usage (iteration proxy)
    for r in conn.execute(
            "SELECT agent, task_title, COUNT(DISTINCT date(timestamp,'unixepoch')) days,"
            " COUNT(*) n FROM token_usage WHERE timestamp BETWEEN ? AND ?"
            " AND task_title IS NOT NULL AND task_title != ''"
            " GROUP BY agent, task_title HAVING days > 1", (ep0, ep1)):
        b = bucket(canon_assignee(r["agent"]))
        if b is not None:
            b["m3_task_title_repeats"].append(
                {"title": r["task_title"], "days": r["days"], "calls": r["n"]})

    # M3: correction-flavoured kanban comments, attributed to the card assignee
    for r in conn.execute(
            "SELECT c.card_id, c.author, c.content, k.assignee FROM kanban_comments c"
            " JOIN kanban_cards k ON k.id = c.card_id"
            " WHERE c.created_at BETWEEN ? AND ?", (ep0, ep1)):
        if CORRECTION_RX.search(r["content"] or ""):
            b = bucket(canon_assignee(r["assignee"]))
            if b is not None:
                b["m3_correction_comments"].append(
                    {"card": r["card_id"], "author": r["author"],
                     "preview": r["content"][:150]})

    # M5: scheduled-task dispatch stats (fired/skipped only -- see module note)
    for r in conn.execute(
            "SELECT agent, name, status, COUNT(*) n FROM task_runs"
            " WHERE ts BETWEEN ? AND ? GROUP BY agent, name, status", (ep0, ep1)):
        b = bucket(canon_assignee(r["agent"]))
        if b is not None:
            b["m5_task_runs"].setdefault(r["name"], {})[r["status"]] = r["n"]

    # M6: inbound inter-agent messages with correction flavour (per recipient)
    for r in conn.execute(
            "SELECT from_agent, to_agent, content FROM agent_messages"
            " WHERE created_at BETWEEN ? AND ?", (ep0, ep1)):
        if CORRECTION_RX.search(r["content"] or ""):
            b = bucket(canon_assignee(r["to_agent"]))
            if b is not None:
                b["m6_inbound_corrections"].append(
                    {"from": r["from_agent"], "preview": r["content"][:150]})
    conn.close()

    # M2: weekly reports of the month (already root-caused incident cards)
    weekly = []
    for path in sorted(glob.glob(f"{REPO}/reports/weekly/*.md")):
        wk = os.path.basename(path)[:-3]
        try:
            monday = dt.date.fromisocalendar(
                int(wk[:4]), int(wk.split("-W")[1]), 1)
        except ValueError:
            continue
        if first <= monday <= last or first <= monday + dt.timedelta(days=6) <= last:
            body = open(path).read()
            weekly.append({
                "week": wk, "file": path,
                "severity_counts": {p: len(re.findall(rf"`{p}`", body))
                                    for p in ("P1", "P2", "P3", "P4")},
            })

    # M2: git fix commits (weak per-agent attribution -- fleet-level signal)
    git_out = subprocess.run(
        ["git", "-C", REPO, "log", "--date=short",
         f"--since={first.isoformat()} 00:00", f"--until={last.isoformat()} 23:59",
         "--pretty=format:%h|%ad|%s"], capture_output=True, text=True, check=True).stdout
    git_fixes = [
        {"hash": h, "date": d, "subject": s}
        for h, d, s in (l.split("|", 2) for l in git_out.splitlines())
        if s.lower().startswith(FIX_PREFIXES)]

    # M5: fleet-level failure-log events inside the window
    log_events = []
    for logfile in ("channels-failures.log", "restart-trigger.log"):
        path = f"{REPO}/store/{logfile}"
        if not os.path.exists(path):
            continue
        for line in open(path, errors="replace"):
            m = re.match(r"(\d{4}-\d{2}-\d{2}) ", line)
            if m and first.isoformat() <= m.group(1) <= last.isoformat():
                log_events.append({"log": logfile, "line": line.strip()[:200]})

    json.dump({
        "month": month_id, "from": first.isoformat(), "to": last.isoformat(),
        "extracted_at": dt.datetime.now(TZ).strftime("%Y-%m-%d %H:%M %Z"),
        "assignment_now": read_assignment(),
        "caveats": [
            "assignment_now = extraction-time state, NOT month-start snapshot (#A39B0BA8)",
            "mr-wolfe model read from repo .claude/settings.json 'model' key",
            "m1_done_cards timing uses updated_at (no status-history table)",
            "m2 memory agent_id marks the documenter, not the culprit",
            "m5 task_runs records dispatch (fired/skipped), not outcome",
            "git fix commits are fleet-level (weak per-agent attribution)",
            "M6 transcript analysis is out of scope here (card #18351D78)",
        ],
        "agents": agents,
        "fleet": {"weekly_reports": weekly, "git_fix_commits": git_fixes,
                  "failure_log_events": log_events},
    }, sys.stdout, ensure_ascii=False, indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
