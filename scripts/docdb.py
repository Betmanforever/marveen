#!/usr/bin/env python3
"""Document registry + sample-size thresholds (cards gm-doc-sqldb / gm-sample-size).

Gabor's order (2026-07-30, wolfe msg 3142): "General data retention: invoices,
contracts, etc. For the time being build an sql database for the documents.
Legal expiry date will be added later and once data retention policy is created
in line with GDPR and other legal obligations, the system will be reviewed."

Scope discipline, spelled out because it is a Gabor constraint and not caution:
  - STORAGE + REGISTRY ONLY for now. There is deliberately NO legal_expiry
    column and NO expiry/deletion logic -- the schema leaves room to ADD the
    column later (plain ALTER TABLE), nothing more. Do not build retention
    logic here until the GDPR-conform policy exists and the system is
    re-reviewed.
  - Invoices are ORIGINALS shared with the bookkeeper; Gabor is legally
    required to keep them available for tax audit. That is why the DB lives
    under projects/ (projects/document-registry/documents.db): the nightly
    offsite backup's `projects` discovery category picks it up automatically,
    while store/ is a HARD-DENY tree for that export.

The scores table + `thresholds` subcommand implement Gabor's sample-sizing
order ("Can be scripted. No need for agentic token spend.") with Charlie's
machine-form parameters (wolfe msg 3143). Charlie's key principle: the real
constraint is the RARER CLASS's count (band45 = scores of 4 or 5), not the
total -- every aggregate threshold carries a band45 floor.

Usage:
  docdb.py init                          create the DB (idempotent)
  docdb.py add PATH --type invoice [--date YYYY-MM-DD --partner X --title T --notes N]
  docdb.py scan-invoices                 ingest projects/zenom/szamlak/* as invoices
  docdb.py list [--type invoice]
  docdb.py add-score ITEM SCORE [--category C --source S --notes N]
  docdb.py thresholds [--json]           Charlie's five thresholds, current status
"""

import argparse
import hashlib
import json
import os
import sqlite3
import sys
import time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_DIR = os.path.join(REPO, "projects", "document-registry")
DB_PATH = os.path.join(DB_DIR, "documents.db")
INVOICE_DIR = os.path.join(REPO, "projects", "zenom", "szamlak")

SCHEMA = """
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_type TEXT NOT NULL,              -- invoice | contract | other
  path TEXT NOT NULL UNIQUE,           -- repo-relative path of the ORIGINAL file
  sha256 TEXT NOT NULL,                -- integrity anchor: proves the original is unaltered
  size_bytes INTEGER NOT NULL,
  doc_date TEXT,                       -- ISO date on the document itself, if known
  partner TEXT,                        -- counterparty (customer / supplier)
  title TEXT,
  added_at INTEGER NOT NULL,           -- unix epoch, when registered
  notes TEXT
  -- legal_expiry: intentionally absent; to be ADDED once the GDPR-conform
  -- retention policy exists (Gabor, 2026-07-30). See module docstring.
);

CREATE TABLE IF NOT EXISTS scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item TEXT NOT NULL,                  -- what was scored
  category TEXT,                       -- for the per-category thresholds
  score INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
  scored_at INTEGER NOT NULL,          -- unix epoch (Charlie: kept for windowed training later)
  source TEXT,                         -- who/what produced the score
  notes TEXT
);
"""

# Charlie's threshold set, machine form (wolfe msg 3143). band45 floors are the
# point: the rarer class's count is the real constraint, not the total.
THRESHOLDS = (
    ("preference_visible", lambda t, b, _pc: t >= 50 and b >= 10,
     "total >= 50 AND band45 >= 10"),
    ("predict_attempt", lambda t, b, _pc: t >= 200 and b >= 40,
     "total >= 200 AND band45 >= 40"),
    ("predict_reliable", lambda t, b, _pc: t >= 500 and b >= 100,
     "total >= 500 AND band45 >= 100"),
)
PER_CATEGORY = (
    ("category_direction", 20),
    ("category_confident", 30),
)


def connect():
    os.makedirs(DB_DIR, exist_ok=True)
    con = sqlite3.connect(DB_PATH)
    con.executescript(SCHEMA)
    return con


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def rel(path):
    return os.path.relpath(os.path.realpath(path), REPO)


def add_document(con, path, doc_type, doc_date=None, partner=None, title=None, notes=None):
    """Register one file. Returns 'added' | 'unchanged' | 'CHANGED'.

    An existing path with a matching hash is a no-op; a hash MISMATCH is
    loudly reported and NOT overwritten -- for originals (invoices) a silent
    content change is exactly what the registry exists to catch.
    """
    r = rel(path)
    digest = sha256_file(path)
    size = os.path.getsize(path)
    row = con.execute("SELECT sha256 FROM documents WHERE path = ?", (r,)).fetchone()
    if row:
        return "unchanged" if row[0] == digest else "CHANGED"
    con.execute(
        "INSERT INTO documents (doc_type, path, sha256, size_bytes, doc_date, partner, title, added_at, notes)"
        " VALUES (?,?,?,?,?,?,?,?,?)",
        (doc_type, r, digest, size, doc_date, partner, title, int(time.time()), notes))
    con.commit()
    return "added"


def cmd_scan_invoices(con):
    if not os.path.isdir(INVOICE_DIR):
        print(f"nincs szamla-konyvtar: {INVOICE_DIR}")
        return 1
    changed = 0
    for name in sorted(os.listdir(INVOICE_DIR)):
        p = os.path.join(INVOICE_DIR, name)
        if not os.path.isfile(p):
            continue
        status = add_document(con, p, "invoice")
        print(f"{status:9}  {rel(p)}")
        if status == "CHANGED":
            changed += 1
    if changed:
        print(f"\nFIGYELEM: {changed} regisztralt eredeti fajl TARTALMA ELTER a"
              " nyilvantartott hash-tol -- eredeti dokumentumnal ez vizsgalando,"
              " a registry NEM irta felul.")
        return 2
    return 0


def cmd_thresholds(con, as_json):
    total = con.execute("SELECT COUNT(*) FROM scores").fetchone()[0]
    band45 = con.execute("SELECT COUNT(*) FROM scores WHERE score IN (4,5)").fetchone()[0]
    per_cat = dict(con.execute(
        "SELECT COALESCE(category,'(nincs)'), COUNT(*) FROM scores GROUP BY category"))
    out = {"total": total, "band45": band45, "per_category": per_cat, "thresholds": {}}
    for name, fn, expr in THRESHOLDS:
        out["thresholds"][name] = {"met": fn(total, band45, per_cat), "rule": expr}
    for name, floor in PER_CATEGORY:
        met = sorted(c for c, n in per_cat.items() if n >= floor)
        out["thresholds"][name] = {
            "met_categories": met, "rule": f"per_category_count >= {floor}"}
    if as_json:
        print(json.dumps(out, ensure_ascii=False, indent=2))
    else:
        print(f"total={total}  band45={band45}  kategoriak={per_cat or '{}'}")
        for name, info in out["thresholds"].items():
            state = info.get("met", info.get("met_categories"))
            print(f"  {name:20} {state!r:20} [{info['rule']}]")
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("init")
    p_add = sub.add_parser("add")
    p_add.add_argument("path")
    p_add.add_argument("--type", required=True, dest="doc_type")
    p_add.add_argument("--date", dest="doc_date")
    p_add.add_argument("--partner")
    p_add.add_argument("--title")
    p_add.add_argument("--notes")
    sub.add_parser("scan-invoices")
    p_list = sub.add_parser("list")
    p_list.add_argument("--type", dest="doc_type")
    p_sc = sub.add_parser("add-score")
    p_sc.add_argument("item")
    p_sc.add_argument("score", type=int)
    p_sc.add_argument("--category")
    p_sc.add_argument("--source")
    p_sc.add_argument("--notes")
    p_th = sub.add_parser("thresholds")
    p_th.add_argument("--json", action="store_true")
    args = ap.parse_args()

    con = connect()
    try:
        if args.cmd == "init":
            print(f"DB kesz: {DB_PATH}")
            return 0
        if args.cmd == "add":
            status = add_document(con, args.path, args.doc_type, args.doc_date,
                                  args.partner, args.title, args.notes)
            print(f"{status}  {rel(args.path)}")
            return 2 if status == "CHANGED" else 0
        if args.cmd == "scan-invoices":
            return cmd_scan_invoices(con)
        if args.cmd == "list":
            q = "SELECT doc_type, doc_date, partner, path FROM documents"
            params = ()
            if args.doc_type:
                q += " WHERE doc_type = ?"
                params = (args.doc_type,)
            for row in con.execute(q + " ORDER BY doc_type, doc_date, path", params):
                print("  ".join(str(c) if c is not None else "-" for c in row))
            return 0
        if args.cmd == "add-score":
            con.execute(
                "INSERT INTO scores (item, category, score, scored_at, source, notes)"
                " VALUES (?,?,?,?,?,?)",
                (args.item, args.category, args.score, int(time.time()),
                 args.source, args.notes))
            con.commit()
            print("score rogzitve")
            return 0
        if args.cmd == "thresholds":
            return cmd_thresholds(con, args.json)
    finally:
        con.close()
    return 1


if __name__ == "__main__":
    sys.exit(main())
