#!/usr/bin/env python3
"""Weekly report raw-data extractor (kanban #6A302E35).

Collects errors, bugs and lessons for one ISO week from the agreed
sources (see shared memory "heti riport forrasdefinicio", #FF55DF20):
  1. memories table   -- cold/shared tier lessons (all categories included,
                         grouped, so the synthesizer can pick)
  2. daily_logs table -- per-agent daily journal entries
  3. git history      -- fix()/security()/revert commits + release markers
  4. Skool activity log -- projects/skool/activity-log.md dated sections
                         (Ive's Do-Track-Preserve journal, added 2026-07-13)

Output: structured JSON on stdout. The report synthesis (filling
agents/ive/deliverables/heti-riport-sablon.md) is done by the scheduled
agent, NOT by this script -- this script is deterministic on purpose.

Usage:
  weekly-report-extract.py              # Monday: previous ISO week,
                                        # other days: current week-to-date
  weekly-report-extract.py --week 2026-W27
"""

import argparse
import datetime as dt
import json
import sqlite3
import subprocess
import sys
from zoneinfo import ZoneInfo

REPO = "/home/szabgabor/marveen"
DB = f"{REPO}/store/claudeclaw.db"
TZ = ZoneInfo("Europe/Budapest")

FIX_PREFIXES = ("fix", "security", "revert", "hotfix")

# User-facing agent-friction tracking (2026-07-04, Gabor kerese): memories
# tagged with a "friction:<type>" keyword get counted by type/agent so the
# report can show which recurring pain points are worth a real fix instead
# of repeated manual firefighting. Tag convention documented in the
# "agent-friction-taxonomia" warm-tier memory (agent_id mr-wolfe).
FRICTION_PREFIX = "friction:"


def week_bounds(week_arg: str | None) -> tuple[str, dt.date, dt.date]:
    """Return (iso_week_id, monday, sunday) in Budapest time."""
    if week_arg:
        year, wnum = week_arg.upper().split("-W")
        monday = dt.date.fromisocalendar(int(year), int(wnum), 1)
    else:
        today = dt.datetime.now(TZ).date()
        if today.isoweekday() == 1:
            monday = today - dt.timedelta(days=7)  # previous full week
        else:
            monday = today - dt.timedelta(days=today.isoweekday() - 1)
    sunday = monday + dt.timedelta(days=6)
    iso = monday.isocalendar()
    return f"{iso.year}-W{iso.week:02d}", monday, sunday


def to_epoch(d: dt.date, end: bool) -> int:
    t = dt.time(23, 59, 59) if end else dt.time(0, 0, 0)
    return int(dt.datetime.combine(d, t, tzinfo=TZ).timestamp())


def fetch_db(monday: dt.date, sunday: dt.date) -> tuple[list, dict]:
    conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    logs = [dict(r) for r in conn.execute(
        "SELECT agent_id, date, content, created_at FROM daily_logs"
        " WHERE date >= ? AND date <= ? ORDER BY date, agent_id, created_at",
        (monday.isoformat(), sunday.isoformat()))]
    mems: dict[str, list] = {}
    rows = conn.execute(
        "SELECT id, agent_id, category, content, keywords, created_at FROM memories"
        " WHERE created_at >= ? AND created_at <= ? ORDER BY created_at",
        (to_epoch(monday, False), to_epoch(sunday, True)))
    for r in rows:
        m = dict(r)
        m["created_local"] = dt.datetime.fromtimestamp(
            m["created_at"], TZ).strftime("%Y-%m-%d %H:%M")
        mems.setdefault(m["category"] or "uncategorized", []).append(m)
    conn.close()
    return logs, mems


def _friction_tags(keywords: str | None) -> list[str]:
    """Extract normalized 'friction:<type>' tags from a comma-separated
    keywords field. Case and stray whitespace after the colon are folded
    so 'Friction: Path-Scope' and 'friction:path-scope' land in one bucket.
    """
    tags = []
    for raw in (keywords or "").split(","):
        low = raw.strip().lower()
        if low.startswith(FRICTION_PREFIX):
            tags.append(FRICTION_PREFIX + low[len(FRICTION_PREFIX):].strip())
    return tags


def friction_tracking(mems: dict) -> dict:
    """Aggregate memories tagged 'friction:<type>' by type and by agent.

    by_agent counts one INCIDENT per memory (an agent that hit a multi-tag
    freeze is counted once there), while by_tag/events count per tag -- a
    memory can legitimately span more than one friction type.
    """
    by_tag: dict[str, int] = {}
    by_agent: dict[str, int] = {}
    events: list[dict] = []
    for entries in mems.values():
        for m in entries:
            friction_tags = _friction_tags(m.get("keywords"))
            if not friction_tags:
                continue
            by_agent[m["agent_id"]] = by_agent.get(m["agent_id"], 0) + 1
            for tag in friction_tags:
                by_tag[tag] = by_tag.get(tag, 0) + 1
                events.append({
                    "tag": tag,
                    "agent_id": m["agent_id"],
                    "created_local": m["created_local"],
                    "memory_id": m["id"],
                })
    return {"by_tag": by_tag, "by_agent": by_agent, "events": events}


def model_fallback_events(monday: dt.date, sunday: dt.date) -> dict:
    """Auto model-fallback events for the week (Gabor, 2026-07-04): every
    downgrade/revert the model-fallback watcher performed, from
    config_change_log (key='agent.<name>.model', actor='model-fallback:<cause>';
    legacy rows may carry a bare 'model-fallback' actor). Also reports each
    affected agent's CURRENT model so the report can say "still downgraded"
    vs "already back", plus a deterministic suggested action -- the prose
    around it is the synthesizer's job, the facts are this script's.
    """
    conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    rows = [dict(r) for r in conn.execute(
        "SELECT key, old_value, new_value, actor, created_at FROM config_change_log"
        " WHERE actor LIKE 'model-fallback%' AND created_at >= ? AND created_at <= ?"
        " ORDER BY created_at",
        (to_epoch(monday, False), to_epoch(sunday, True)))]
    conn.close()

    events = []
    agents_seen: dict[str, dict] = {}
    for r in rows:
        key = r["key"] or ""
        agent = key[len("agent."):-len(".model")] if key.startswith("agent.") and key.endswith(".model") else key
        cause = r["actor"].split(":", 1)[1] if ":" in r["actor"] else "unknown"
        ev = {
            "agent": agent,
            "from": r["old_value"],
            "to": r["new_value"],
            "cause": cause,  # usage-limit | model-access | revert | unknown
            "at_local": dt.datetime.fromtimestamp(r["created_at"], TZ).strftime("%Y-%m-%d %H:%M"),
        }
        events.append(ev)
        agents_seen[agent] = ev  # last event wins for status

    status = []
    for agent, last in agents_seen.items():
        current = None
        try:
            with open(f"{REPO}/agents/{agent}/agent-config.json") as f:
                current = json.load(f).get("model")
        except OSError:
            pass  # main agent / removed agent -- current model not readable here
        still_downgraded = last["cause"] in ("usage-limit", "model-access")
        if last["cause"] == "revert":
            action = "nincs teendo (mar visszaallt)"
        elif last["cause"] == "model-access":
            action = ("manualis dontes szukseges: a modell elofizetes/credit miatt nem elerheto;"
                      " visszaallitas csak credit-vasarlas vagy modell-donto utan")
        elif last["cause"] == "usage-limit":
            action = "auto-revert varhato a limit-ablak utan; ellenorizd hogy megtortent-e"
        else:
            action = "ellenorizd kezzel (regi formatumu esemeny, ok nem ismert)"
        status.append({
            "agent": agent,
            "current_model": current,
            "last_event": last,
            "still_downgraded": still_downgraded,
            "suggested_action": action,
        })
    return {"events": events, "agent_status": status}


def fetch_skool_activity(monday: dt.date, sunday: dt.date) -> list:
    """Parse projects/skool/activity-log.md (append-only Do-Track-Preserve
    journal, owner: ive) and return the dated sections that fall inside the
    reported week. Sections are '## YYYY-MM-DD' headers followed by '-' bullet
    lines; anything that isn't a bullet under a dated header is ignored so a
    malformed edit can't break the extraction. Missing file = empty list (the
    Skool project may be dormant), NOT an error."""
    path = f"{REPO}/projects/skool/activity-log.md"
    days: list[dict] = []
    current: dict | None = None
    try:
        with open(path, encoding="utf-8") as f:
            lines = f.read().splitlines()
    except OSError:
        return []
    for line in lines:
        if line.startswith("## "):
            current = None
            try:
                day = dt.date.fromisoformat(line[3:].strip())
            except ValueError:
                continue
            if monday <= day <= sunday:
                current = {"date": day.isoformat(), "entries": []}
                days.append(current)
        elif current is not None and line.lstrip().startswith("- "):
            current["entries"].append(line.lstrip()[2:].strip())
    return [d for d in days if d["entries"]]


def fetch_git(monday: dt.date, sunday: dt.date) -> dict:
    out = subprocess.run(
        ["git", "-C", REPO, "log", "--date=short",
         f"--since={monday.isoformat()} 00:00",
         f"--until={sunday.isoformat()} 23:59",
         "--pretty=format:%h|%ad|%s"],
        capture_output=True, text=True, check=True).stdout
    git = {"fixes": [], "releases": [], "other": []}
    for line in out.splitlines():
        h, date, subject = line.split("|", 2)
        entry = {"hash": h, "date": date, "subject": subject}
        low = subject.lower()
        if low.startswith("chore(release)"):
            git["releases"].append(entry)
        elif low.startswith(FIX_PREFIXES):
            git["fixes"].append(entry)
        else:
            git["other"].append(entry)
    return git


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--week", help="ISO week like 2026-W27 (default: auto)")
    args = ap.parse_args()

    week_id, monday, sunday = week_bounds(args.week)
    logs, mems = fetch_db(monday, sunday)
    git = fetch_git(monday, sunday)
    friction = friction_tracking(mems)
    fallback = model_fallback_events(monday, sunday)
    skool = fetch_skool_activity(monday, sunday)

    result = {
        "week": week_id,
        "from": monday.isoformat(),
        "to": sunday.isoformat(),
        "extracted_at": dt.datetime.now(TZ).strftime("%Y-%m-%d %H:%M %Z"),
        "stats": {
            "daily_log_entries": len(logs),
            "memories_by_category": {k: len(v) for k, v in mems.items()},
            "git_fix_commits": len(git["fixes"]),
            "git_release_commits": len(git["releases"]),
            "git_other_commits": len(git["other"]),
            "agent_friction_events": len(friction["events"]),
            "model_fallback_events": len(fallback["events"]),
            "skool_activity_days": len(skool),
        },
        "daily_logs": logs,
        "memories": mems,
        "git": git,
        "agent_friction": friction,
        "model_fallback": fallback,
        "skool_activity": skool,
    }
    json.dump(result, sys.stdout, ensure_ascii=False, indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
