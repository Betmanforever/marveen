#!/usr/bin/env python3
"""Site monitoring stats aggregator (kanban #8fc05c73).

Reads the site_checks table written by site-monitor.py and prints
uptime %, latency and incident stats for a time window. Deterministic,
stdlib-only -- meant to be called by the weekly report pipeline
(weekly-report-extract.py) and the monthly evaluation.

Usage:
  site-monitor-stats.py --days 7              # markdown, last 7 days
  site-monitor-stats.py --days 30 --json      # JSON for pipelines
  site-monitor-stats.py --week 2026-W30       # ISO week window
"""

import argparse
import datetime as dt
import json
import sqlite3
import sys
from zoneinfo import ZoneInfo

DB = "/home/szabgabor/marveen/store/claudeclaw.db"
TZ = ZoneInfo("Europe/Budapest")


def week_window(week: str) -> tuple[int, int]:
    year, wnum = week.split("-W")
    monday = dt.datetime.fromisocalendar(int(year), int(wnum), 1).replace(tzinfo=TZ)
    return int(monday.timestamp()), int((monday + dt.timedelta(days=7)).timestamp())


def percentile(values: list[int], pct: float) -> int | None:
    if not values:
        return None
    values = sorted(values)
    k = min(len(values) - 1, int(round(pct * (len(values) - 1))))
    return values[k]


def collect(start: int, end: int) -> dict:
    db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    sites = [r["site"] for r in db.execute(
        "SELECT DISTINCT site FROM site_checks WHERE ts>=? AND ts<?", (start, end))]
    out = {}
    for site in sites:
        rows = db.execute(
            "SELECT ts, ok, latency_ms, ssl_days, error FROM site_checks"
            " WHERE site=? AND ts>=? AND ts<? ORDER BY ts", (site, start, end)).fetchall()
        total = len(rows)
        ok_n = sum(r["ok"] for r in rows)
        lats = [r["latency_ms"] for r in rows if r["ok"] and r["latency_ms"] is not None]
        # incidents: consecutive runs of failed checks
        incidents, run_start, prev_ok = [], None, True
        for r in rows:
            if not r["ok"] and prev_ok:
                run_start = r["ts"]
            if r["ok"] and not prev_ok and run_start:
                incidents.append((run_start, r["ts"]))
                run_start = None
            prev_ok = bool(r["ok"])
        if run_start and not prev_ok:
            incidents.append((run_start, end))
        last_ssl = next((r["ssl_days"] for r in reversed(rows) if r["ssl_days"] is not None), None)
        out[site] = {
            "checks": total,
            "uptime_pct": round(100.0 * ok_n / total, 3) if total else None,
            "avg_latency_ms": round(sum(lats) / len(lats)) if lats else None,
            "p95_latency_ms": percentile(lats, 0.95),
            "incidents": len(incidents),
            "downtime_minutes": round(sum(e - s for s, e in incidents) / 60),
            "ssl_days_left": last_ssl,
        }
    db.close()
    return out


def to_markdown(stats: dict, label: str) -> str:
    if not stats:
        return f"### Site-felugyelet ({label})\n\nNincs adat a vizsgalt idoszakra.\n"
    lines = [f"### Site-felugyelet ({label})", "",
             "| Site | Uptime | Atl. valaszido | p95 | Incidens | Kieses | SSL hatra |",
             "|------|--------|----------------|-----|----------|--------|-----------|"]
    for site, s in sorted(stats.items()):
        lines.append(
            f"| {site} | {s['uptime_pct']}% | {s['avg_latency_ms']} ms | {s['p95_latency_ms']} ms"
            f" | {s['incidents']} | {s['downtime_minutes']} perc | {s['ssl_days_left']} nap |")
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, help="window: last N days")
    ap.add_argument("--week", help="window: ISO week, e.g. 2026-W30")
    ap.add_argument("--json", action="store_true", help="JSON output instead of markdown")
    args = ap.parse_args()

    if args.week:
        start, end = week_window(args.week)
        label = args.week
    else:
        days = args.days or 7
        end = int(dt.datetime.now(TZ).timestamp())
        start = end - days * 86400
        label = f"utolso {days} nap"

    stats = collect(start, end)
    if args.json:
        print(json.dumps({"window": label, "sites": stats}, ensure_ascii=False, indent=2))
    else:
        print(to_markdown(stats, label))
    return 0


if __name__ == "__main__":
    sys.exit(main())
