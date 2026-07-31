#!/usr/bin/env python3
"""Export a kanban card + its comments to a PLAIN-TEXT audit brief.

Why (card ee8a9d70, 2026-07-31): the auditor subagent has tools Read/Grep/Glob
only -- deliberately no Bash, to keep an audit-only role least-privileged. But
the kanban lives in store/claudeclaw.db, a SQLite BINARY that Read cannot open,
so an auditor asked to check "does the plan cover the order" cannot see the
order (Gabor's verbatim spec + the coordinator's requirements live in the card
and its comments). During the NDA-portal audit this forced the auditor to work
from the calling agent's paraphrase -- a structural risk: it could not see
exactly what it was told to verify. This script writes the card + every comment
to a text file the auditor CAN Read; the calling agent runs it (it has Bash)
before delegating, and passes the output path in the audit prompt alongside the
plan and research files.

Least-privilege stays intact: the auditor gains nothing new, the source is just
staged into a format its existing Read tool reaches.

Usage:
  audit-brief.py <card-id-prefix> [output-file]
Default output: agents/auditor/qa-in/audit-brief-<card-id>.txt
"""

import os
import sqlite3
import sys
import time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(REPO, "store", "claudeclaw.db")


def fmt_ts(v):
    if not v:
        return "-"
    return time.strftime("%Y-%m-%d %H:%M", time.localtime(v))


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    card_id = sys.argv[1]
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    rows = con.execute(
        "SELECT * FROM kanban_cards WHERE id LIKE ? || '%'", (card_id,)).fetchall()
    if not rows:
        print(f"nincs kartya erre a prefixre: {card_id}")
        return 1
    if len(rows) > 1:
        print(f"tobb kartya illeszkedik ({len(rows)}) -- adj hosszabb prefixet: "
              + ", ".join(r["id"] for r in rows))
        return 1
    card = rows[0]
    full_id = card["id"]

    out_path = (sys.argv[2] if len(sys.argv) > 2
                else os.path.join(REPO, "agents", "auditor", "qa-in",
                                  f"audit-brief-{full_id}.txt"))
    os.makedirs(os.path.dirname(out_path), exist_ok=True)

    lines = [
        f"AUDIT-BRIEF -- kanban kartya {full_id}",
        f"generalva: {time.strftime('%Y-%m-%d %H:%M:%S')}",
        "=" * 70,
        f"CIM: {card['title']}",
        f"statusz: {card['status']}   assignee: {card['assignee']}   "
        f"prioritas: {card['priority']}",
        f"letrehozva: {fmt_ts(card['created_at'])}   frissitve: {fmt_ts(card['updated_at'])}",
        "",
        "LEIRAS:",
        card["description"] or "(nincs)",
        "",
        "=" * 70,
        "KOMMENTEK (idorendben):",
    ]
    comments = con.execute(
        "SELECT author, content, created_at FROM kanban_comments "
        "WHERE card_id = ? ORDER BY created_at", (full_id,)).fetchall()
    if not comments:
        lines.append("(nincs komment)")
    for c in comments:
        lines.append("")
        lines.append(f"--- [{fmt_ts(c['created_at'])}] {c['author']} ---")
        lines.append(c["content"])
    con.close()

    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(out_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
