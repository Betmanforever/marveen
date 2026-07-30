#!/usr/bin/env python3
"""Phase A of the zenom1 mirror-then-swap migration: continuous dark mirror.

Full spec + audit trail: agents/neo/migration/mirror-then-swap-PLAN.md (v5,
five auditor rounds, PASS). Section references in the comments below point
there. This script is the executable form of the plan's "A fazis".

Runs ON WSL (the live production host), driven by a systemd timer. It only
COPIES FILES to zenom1 -- it never starts a service there, never touches any
.env on either side, and refuses to run at all if zenom1 is not dark.

What it does, in order:
  1. preflight: ssh reachable + zenom1 dark (no dashboard/claude/tmux)   -- plan 2/A
  2. repo tree rsync, `/.env` ANCHORED so only the ROOT .env is excluded
     and the four sub-agent bot-token .env files DO travel            -- plan D3
  3. one consistent SQLite snapshot (Connection.backup), DDL + row
     counts written to a local manifest for Phase B to compare against -- plan B/6
  4. store/ rsync: EVERYTHING except *.log / *.pid and the db triple,
     the triple being replaced by the consistent snapshot; the stale
     zenom1-side -wal/-shm are deleted BEFORE the snapshot lands       -- plan B7/D7
  5. ~/.claude/ rsync (cache/paste-cache/downloads/file-history out,
     plus *.log/*.pid -- D6 resolved here, see EXCLUDE_CLAUDE)         -- plan D6
  6. ~/.claude.json
  7. git push develop -> zenom1 wsl-develop (+ index reconcile)        -- plan 2/A
  8. informational drift capture: crontab + systemd unit files         -- plan F13
  9. manifest write; Telegram alert on failure (throttled)

Usage:
  mirror-sync.py                 full sync
  mirror-sync.py --dry-run       rsync --dry-run everywhere, no remote writes,
                                 no snapshot placement, no git push. Prints the
                                 would-be transfer lists (used to prove D3).
  mirror-sync.py --no-alert      never send Telegram (test runs)

Exit codes: 0 ok, 1 controlled failure (alerted), 2 preflight refusal.
"""

import argparse
import hashlib
import json
import os
import re
import shlex
import socket
import sqlite3
import subprocess
import sys
import time
import traceback
import urllib.request
from datetime import datetime

REPO = "/home/szabgabor/marveen"
HOME = "/home/szabgabor"
ZENOM = "szabgabor@192.168.1.131"
SSH_KEY = f"{REPO}/agents/neo/.ssh/zenom1_ed25519"

# State lives OUTSIDE every mirrored tree (not in the repo, not in ~/.claude),
# otherwise the manifest and the 25 MB snapshot would ride along on every sync.
STATE_DIR = f"{HOME}/.marveen-migration"
MANIFEST = f"{STATE_DIR}/last-sync-manifest.json"
SNAPSHOT = f"{STATE_DIR}/claudeclaw-snapshot.db"
SYNC_LOG = f"{STATE_DIR}/mirror-sync.log"
THROTTLE = f"{STATE_DIR}/alert-throttle.json"
FAILSTREAK = f"{STATE_DIR}/fail-streak.json"

DB = f"{REPO}/store/claudeclaw.db"

# Alerting: the same direct Bot API path nightly-memory-backup.py uses (plan 2/B11).
# sendMessage does NOT contend for the getUpdates slot (web.ts:385-397), so this
# is collision-safe against the live fleet.
TELEGRAM_ENV = f"{HOME}/.claude/channels/telegram/.env"
TELEGRAM_CHAT_ID = "8765540529"
ALERT_THROTTLE_S = 3600

SSH_TIMEOUT = 60
RSYNC_TIMEOUT = 3 * 3600  # first full sync moves ~5 GB of agents/ive

# --- rsync exclusion sets -------------------------------------------------
#
# ANCHORING MATTERS (plan D3): a leading "/" pins the pattern to the ROOT of
# the transferred tree. `--exclude ".env"` (unanchored) would also drop
# agents/{alex,charlie,ive,neo}/.claude/channels/telegram/.env -- the four
# sub-agent bot tokens -- freezing them at their F0 state and surfacing only as
# a G-SMOKE red INSIDE the swap window. `/.env` excludes the root .env only.
#
# node_modules stays UNANCHORED on purpose: every copy at every depth is a
# rebuildable artifact. /dist/ and /.git/ are anchored so that a project's own
# dist (projects/ibanguardian/dist) still travels; there are no nested .git
# repos in the tree today (verified 2026-07-25).
EXCLUDE_REPO = [
    "node_modules",
    "/dist/",
    "/.git/",
    "/store/",
    "/.env",
]
# store/: everything travels EXCEPT transient runtime state and the db triple.
# The triple is replaced by the Connection.backup() snapshot (plan B7).
EXCLUDE_STORE = [
    "*.log",
    "*.pid",
    "claudeclaw.db",
    "claudeclaw.db-wal",
    "claudeclaw.db-shm",
]
# D6 resolved: only two *.log/*.pid files exist under ~/.claude outside the
# already-excluded caches -- channels/telegram/bot.pid (host-local runtime PID,
# a stale WSL value on zenom1 is actively misleading) and
# channels/telegram/progress/debug.log. Same rule as store/ applies.
EXCLUDE_CLAUDE = [
    "cache",
    "paste-cache",
    "downloads",
    "file-history",
    "*.log",
    "*.pid",
]

# Tables the dashboard mutates on EVERY boot regardless of WEB_ONLY/RESPAWN
# (index.ts:412 runDecaySweep -> memory.ts:155 -> db.ts:2653 pruneAuditLogs,
# db.ts:2665 pruneTokenUsage). Recorded in the manifest so Phase B can treat
# them as informational instead of raising a periodic false red (plan D4).
BOOT_MUTABLE_TABLES = [
    "config_change_log",
    "idea_status_log",
    "store_file_audit",
    "token_usage",
]


class SyncError(Exception):
    """Controlled failure: alert, exit non-zero, leave zenom1 as it was."""


# --------------------------------------------------------------------------
# small helpers
# --------------------------------------------------------------------------

def log(msg):
    line = f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {msg}"
    print(line, flush=True)
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        with open(SYNC_LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:  # noqa: BLE001 -- logging must never fail the run
        pass


def human(n):
    return f"{n / 1024 / 1024:.2f} MB" if n >= 1024 * 1024 else f"{n / 1024:.1f} kB"


def env_value(path, key):
    """Read KEY=value out of a dotenv-style file. Never logs the value."""
    if not os.path.exists(path):
        return None
    with open(path, "r", errors="replace") as f:
        for line in f:
            line = line.strip()
            if line.startswith(f"{key}="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return None


def run(cmd, timeout, check=True, ok_codes=(0,)):
    """subprocess.run with a HARD timeout.

    A python-side timeout kills the child; ssh's own ConnectTimeout only bounds
    the handshake and would not save us from a wedged post-auth session (the
    exact failure class the plan's rollback rules call out).
    """
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if check and p.returncode not in ok_codes:
        raise SyncError(f"parancs hibaval tert vissza (rc={p.returncode}): "
                        f"{' '.join(shlex.quote(c) for c in cmd)[:300]}\n"
                        f"stderr: {p.stderr.strip()[:800]}")
    return p


def ssh(remote_cmd, timeout=SSH_TIMEOUT, check=True, ok_codes=(0,)):
    return run(["ssh", "-i", SSH_KEY, "-o", "BatchMode=yes",
                "-o", "ConnectTimeout=10", ZENOM, remote_cmd],
               timeout=timeout, check=check, ok_codes=ok_codes)


def ssh_python(script, timeout=SSH_TIMEOUT):
    """Run python3 on zenom1 with the source on STDIN.

    stdin, not argv: nothing sensitive the script reads (bot tokens) can leak
    into the remote process list -- same reasoning as nightly-memory-backup.py
    preferring urllib over shelling out to curl.
    """
    p = subprocess.run(["ssh", "-i", SSH_KEY, "-o", "BatchMode=yes",
                        "-o", "ConnectTimeout=10", ZENOM, "python3 -"],
                       input=script, capture_output=True, text=True, timeout=timeout)
    if p.returncode != 0:
        raise SyncError(f"tavoli python3 hiba (rc={p.returncode}): "
                        f"{p.stderr.strip()[:800]}")
    return p.stdout


def rsync(src, dst, excludes, dry_run, extra=()):
    cmd = ["rsync", "-a", "--delete",
           "-e", f"ssh -i {SSH_KEY} -o BatchMode=yes -o ConnectTimeout=10"]
    for e in excludes:
        cmd += ["--exclude", e]
    cmd += list(extra)
    if dry_run:
        cmd += ["--dry-run", "-i"]
    cmd += [src, dst]
    # rc 24 = "some files vanished before transfer": unavoidable and harmless
    # while the WSL fleet is live and rotating logs/transcripts under us.
    p = run(cmd, timeout=RSYNC_TIMEOUT, ok_codes=(0, 24))
    if p.returncode == 24:
        log("  FIGYELEM: rsync rc=24 (fajlok eltuntek atvitel kozben, elo flotta mellett vart)")
    return p


# --------------------------------------------------------------------------
# notification (plan 2/B11, same mechanism as nightly-memory-backup.py)
# --------------------------------------------------------------------------

def telegram_send(text):
    token = env_value(TELEGRAM_ENV, "TELEGRAM_BOT_TOKEN")
    if not token:
        raise SyncError(f"nincs TELEGRAM_BOT_TOKEN itt: {TELEGRAM_ENV}")
    body = json.dumps({"chat_id": TELEGRAM_CHAT_ID, "text": text[:3900]}).encode()
    req = urllib.request.Request(f"https://api.telegram.org/bot{token}/sendMessage",
                                 data=body, method="POST",
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        payload = json.load(r)
    if not payload.get("ok"):
        raise SyncError(f"Telegram API elutasitotta: {str(payload)[:200]}")


def _load_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return default


def _save_json(path, data):
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        with open(path, "w") as f:
            json.dump(data, f)
    except Exception:  # noqa: BLE001
        pass


def bump_failstreak(stage):
    d = _load_json(FAILSTREAK, {})
    d[stage] = int(d.get(stage, 0)) + 1
    _save_json(FAILSTREAK, d)
    return d[stage]


def clear_failstreak():
    _save_json(FAILSTREAK, {})


def alert(stage, message, enabled=True):
    """Throttled failure alert.

    A 15-minute timer failing persistently would otherwise emit 4 messages an
    hour; the plan explicitly warns that a wolf-crying alert ends up allowlisted
    and hides the real event. One message per stage per hour, with the
    consecutive-failure count carried in the text so a long streak is visible.
    """
    streak = bump_failstreak(stage)
    text = (f"[mirror-sync] HIBA -- {stage} (egymast koveto {streak}. hiba)\n"
            f"{message}\n"
            f"Host: {socket.gethostname()}  Ido: {datetime.now():%Y-%m-%d %H:%M:%S}\n"
            f"zenom1 valtozatlan maradt, a WSL flotta erintetlen.")
    if not enabled:
        log("ALERT (nem kuldve, --no-alert):\n" + text)
        return
    thr = _load_json(THROTTLE, {})
    now = time.time()
    if now - float(thr.get(stage, 0)) < ALERT_THROTTLE_S:
        log(f"ALERT elnyomva (throttle {ALERT_THROTTLE_S}s, {stage}) -- {message[:200]}")
        return
    try:
        telegram_send(text)
        thr[stage] = now
        _save_json(THROTTLE, thr)
        log("riasztas elkuldve Telegramra")
    except Exception as e:  # noqa: BLE001
        log(f"CRITICAL: az alert sem ment ki ({e}) -- eredeti hiba: {message}")


# --------------------------------------------------------------------------
# 1. preflight (plan 2/A: zenom1 stays TOTALLY dark during phase A)
# --------------------------------------------------------------------------

def preflight():
    p = ssh("echo alive; hostname", timeout=30, check=False)
    if p.returncode != 0 or "alive" not in p.stdout:
        raise SyncError(f"zenom1 nem erheto el SSH-n (rc={p.returncode}): "
                        f"{p.stderr.strip()[:300]}")
    host = p.stdout.split()[-1].strip()
    if host != "zenom1":
        raise SyncError(f"a tavoli host neve '{host}', nem 'zenom1' -- rossz cel, leallok")

    # [i]ndex bracket trick: keeps pgrep from matching the ssh bash -c wrapper.
    out = ssh('pgrep -a -f "dist/[i]ndex.js" || true; '
              'echo ---; systemctl --user is-active mr-wolfe-dashboard.service || true; '
              'echo ---; systemctl --user is-active mr-wolfe-channels.service || true',
              timeout=30).stdout
    procs, dash, chan = (out.split("---") + ["", "", ""])[:3]
    if procs.strip():
        raise SyncError("zenom1 NEM sotet: fut egy dist/index.js folyamat -- "
                        f"a store/ szinkron egy elo DB-t irna felul. Talalat:\n{procs.strip()[:400]}")
    if dash.strip() == "active" or chan.strip() == "active":
        raise SyncError(f"zenom1 NEM sotet: dashboard={dash.strip()} channels={chan.strip()}")
    log(f"preflight OK -- zenom1 sotet (dashboard={dash.strip()}, channels={chan.strip()})")


# --------------------------------------------------------------------------
# 3. consistent DB snapshot + manifest (plan 2/B6, nightly-memory-backup C5/D3)
# --------------------------------------------------------------------------

def snapshot_db(dest):
    """One consistent point-in-time copy of the live DB.

    The WSL fleet is fully live during phase A, so per-table SELECTs would tear
    across concurrent writes. Connection.backup() (pages=-1) copies the whole
    database inside a single read transaction -- the same guarantee
    nightly-memory-backup.py relies on.
    """
    if os.path.exists(dest):
        os.remove(dest)
    for suffix in ("-wal", "-shm"):
        if os.path.exists(dest + suffix):
            os.remove(dest + suffix)
    src = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    try:
        dst = sqlite3.connect(dest)
        try:
            src.backup(dst)
        finally:
            dst.close()
    finally:
        src.close()
    # The live DB is 0600. sqlite3.connect() creates the snapshot under the
    # process umask (0644), and rsync -a would carry that downgrade onto
    # zenom1 -- a world-readable copy of every memory and kanban row. Restore
    # the source mode before the file is allowed to travel.
    os.chmod(dest, 0o600)
    return os.path.getsize(dest)


def export_ddl(conn):
    """Filtered, replay-ordered schema DDL.

    Raw `SELECT sql FROM sqlite_master` is not replayable: it carries the FTS5
    shadow tables as plain CREATE TABLEs, sqlite_sequence (implicit from
    AUTOINCREMENT) and sqlite_autoindex_* rows whose sql is NULL. Shadow names
    are derived from the FTS table name, never hardcoded. Lifted verbatim in
    spirit from scripts/nightly-memory-backup.py:530 (plan D3).
    """
    rows = conn.execute("SELECT type, name, tbl_name, sql FROM sqlite_master").fetchall()
    fts_tables = {
        name for typ, name, _tbl, sql in rows
        if typ == "table" and sql and re.match(r"\s*CREATE\s+VIRTUAL\s+TABLE", sql, re.I)
        and "fts5" in sql.lower()
    }
    shadow_prefixes = tuple(f"{n}_" for n in fts_tables)

    kept, skipped = [], []
    for idx, (typ, name, _tbl, sql) in enumerate(rows):
        if name.startswith("sqlite_"):
            skipped.append({"name": name, "reason": "sqlite_ internal"})
            continue
        if sql is None:
            skipped.append({"name": name, "reason": "sql is NULL (implicit index)"})
            continue
        if name not in fts_tables and name.startswith(shadow_prefixes):
            skipped.append({"name": name, "reason": "fts5 shadow object"})
            continue
        is_virtual = bool(re.match(r"\s*CREATE\s+VIRTUAL\s+TABLE", sql, re.I))
        bucket = {"table": 0, "view": 2, "index": 3, "trigger": 4}.get(typ, 5)
        if typ == "table" and is_virtual:
            bucket = 1  # virtual tables after the plain tables they shadow
        kept.append((bucket, idx, name, sql))

    kept.sort(key=lambda k: (k[0], k[1]))
    ddl = "\n".join(f"{sql};" for _b, _i, _n, sql in kept)
    return ddl, [n for _b, _i, n, _s in kept], skipped, sorted(fts_tables)


def row_counts(conn, fts_tables):
    """COUNT(*) for every real table in the snapshot.

    FTS5 shadow tables are skipped: their contents are derived, their counts
    carry no transfer-fidelity signal and would only add noise to Phase B.
    """
    shadow_prefixes = tuple(f"{n}_" for n in fts_tables)
    names = [r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'"
        " ORDER BY name")]
    counts, errors = {}, {}
    for t in names:
        if t not in fts_tables and t.startswith(shadow_prefixes):
            continue
        try:
            counts[t] = conn.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]
        except sqlite3.Error as e:
            errors[t] = str(e)
    return counts, errors


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


# --------------------------------------------------------------------------
# D3 proof (plan section 6): the anchored /.env exclusion, live
# --------------------------------------------------------------------------

# Descend only to the five .env files, so the probe is cheap on a ~5 GB tree.
# --ignore-times forces every candidate to be itemized even when it already
# matches on the target, which a plain --dry-run would silently omit.
ENV_PROBE_FILTERS = [
    "--include", "/agents/",
    "--include", "/agents/*/",
    "--include", "/agents/*/.claude/",
    "--include", "/agents/*/.claude/channels/",
    "--include", "/agents/*/.claude/channels/telegram/",
    "--include", "/agents/*/.claude/channels/telegram/.env",
    "--include", "/.env",
    "--exclude", "*",
]


def prove_env_anchor(excludes, label):
    """List the .env files rsync would transfer under `excludes`.

    The trailing `--include /.env` is deliberate: rsync applies filters in
    order, so the earlier exclusion still wins. If it did NOT win, the root
    .env would show up here -- which is the point of the probe.
    """
    cmd = ["rsync", "-a", "-n", "-i", "--ignore-times",
           "-e", f"ssh -i {SSH_KEY} -o BatchMode=yes -o ConnectTimeout=10"]
    for e in excludes:
        cmd += ["--exclude", e]
    cmd += ENV_PROBE_FILTERS + [f"{REPO}/", f"{ZENOM}:{REPO}/"]
    p = run(cmd, timeout=900, ok_codes=(0, 24))
    hits = sorted(l.split(None, 1)[1] for l in p.stdout.splitlines()
                  if l.split(None, 1)[1:] and l.split(None, 1)[1].endswith(".env"))
    log(f"  [{label}] atvitelre kerulo .env fajlok ({len(hits)}):")
    for h in hits:
        log(f"    {h}")
    return hits


# --------------------------------------------------------------------------
# 8. informational drift capture (plan F13)
# --------------------------------------------------------------------------

def local_cmd_text(cmd):
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        return (p.stdout or p.stderr).strip()
    except Exception as e:  # noqa: BLE001
        return f"<hiba: {e}>"


def unit_inventory_local():
    d = f"{HOME}/.config/systemd/user"
    out = {}
    if os.path.isdir(d):
        for name in sorted(os.listdir(d)):
            p = os.path.join(d, name)
            if os.path.isfile(p):
                out[name] = sha256_file(p)[:16]
    return out


UNIT_INVENTORY_REMOTE = r"""
import hashlib, json, os
d = os.path.expanduser("~/.config/systemd/user")
out = {}
if os.path.isdir(d):
    for name in sorted(os.listdir(d)):
        p = os.path.join(d, name)
        if os.path.isfile(p):
            h = hashlib.sha256()
            with open(p, "rb") as f:
                h.update(f.read())
            out[name] = h.hexdigest()[:16]
print(json.dumps(out))
"""


def store_inventory_local():
    """Relative paths that the store/ leg is expected to deliver, so Phase B can
    prove B7 (vault key, dashboard token, agents-desired.json ... really landed)
    without re-deriving the exclusion rules."""
    base = f"{REPO}/store"
    out = []
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = sorted(dirnames)
        for name in sorted(filenames):
            if name.endswith(".log") or name.endswith(".pid"):
                continue
            if name in ("claudeclaw.db-wal", "claudeclaw.db-shm"):
                continue
            rel = os.path.relpath(os.path.join(dirpath, name), base)
            out.append(rel)
    return out


# --------------------------------------------------------------------------
# main sync
# --------------------------------------------------------------------------

def do_sync(args):
    started = datetime.now()
    t0 = time.time()
    os.makedirs(STATE_DIR, exist_ok=True)
    log("=" * 72)
    log(f"mirror-sync indul (dry_run={args.dry_run})")

    preflight()

    # -- 2. repo tree ------------------------------------------------------
    log("2. repo-fa rsync (/.env LEHORGONYOZVA, sub-agent .env-ek atmennek)")
    p = rsync(f"{REPO}/", f"{ZENOM}:{REPO}/", EXCLUDE_REPO, args.dry_run)
    if args.dry_run:
        log(f"  DRY-RUN: {len(p.stdout.splitlines())} valtozas-sor")
        # plan section 6 / D3: prove the anchoring live, with a negative control
        # that shows the probe can actually detect the bug it guards against.
        good = prove_env_anchor(EXCLUDE_REPO, "ELES minta: /.env (lehorgonyozva)")
        bad_excl = ["node_modules", "/dist/", "/.git/", "/store/", ".env"]
        bad = prove_env_anchor(bad_excl, "NEGATIV KONTROLL: .env (lehorgonyzas nelkul)")
        sub = [h for h in good if h.startswith("agents/")]
        if len(sub) != 4 or any(h == ".env" for h in good):
            raise SyncError(f"D3 bizonyitas BUKOTT: sub-agent .env talalat={len(sub)} "
                            f"(vart 4), gyoker .env atmegy={'.env' in good}")
        if bad:
            raise SyncError(f"D3 negativ kontroll ervenytelen: a lehorgonyzatlan minta "
                            f"melett is atment volna {len(bad)} .env")
        log("  D3 IGAZOLVA: 4 sub-agent .env atmegy, a gyoker .env kizarva; "
            "lehorgonyzas nelkul mind az 5 kimaradna")
    log("  repo-fa kesz")

    # -- 3. DB snapshot + manifest data ------------------------------------
    log("3. konzisztens DB pillanatkep (Connection.backup)")
    size = snapshot_db(SNAPSHOT)
    # The snapshot inherits WAL journal mode from the source header. Inspect it
    # over a READ-WRITE connection: a `mode=ro` connection CREATES -wal/-shm on
    # a WAL database and cannot remove them on close (measured 2026-07-25),
    # which would ship exactly the inconsistent db+wal+shm triple the plan
    # forbids. A read-write last connection checkpoints and deletes both.
    # Safe by construction: this is our own private copy, never the live DB.
    conn = sqlite3.connect(SNAPSHOT)
    try:
        integrity = conn.execute("PRAGMA integrity_check").fetchone()[0]
        if integrity != "ok":
            raise SyncError(f"a FORRAS pillanatkep integrity_check != ok: {integrity[:300]}")
        ddl, ddl_objects, ddl_skipped, fts_tables = export_ddl(conn)
        counts, count_errors = row_counts(conn, set(fts_tables))
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    finally:
        conn.close()
    # Assert the single-file result rather than assume it (the assumption was
    # wrong on the first live run).
    for suffix in ("-wal", "-shm"):
        if os.path.exists(SNAPSHOT + suffix):
            raise SyncError(f"a pillanatkep mellett maradt {suffix} fajl -- "
                            "inkonzisztens harmast szallitanank")
    digest = sha256_file(SNAPSHOT)
    log(f"  pillanatkep {human(size)}, integrity ok, {len(counts)} tabla, sha256 {digest[:16]}...")
    if count_errors:
        log(f"  FIGYELEM: sorszamlalas hiba: {count_errors}")

    # -- 4. store/ ---------------------------------------------------------
    # Order is load-bearing (plan D7, single implementation point): the stale
    # zenom1-side -wal/-shm are removed BEFORE the fresh db lands, so no sync
    # point ever leaves an inconsistent db+wal+shm triple on the target.
    log("4. store/ szinkron (db-harmas nelkul) + stale -wal/-shm torles + pillanatkep")
    # Inventory taken BEFORE the transfer, not at manifest-write time: the WSL
    # source is live, so anything created after this point cannot have been in
    # the rsync, and listing it would make Phase B report a phantom shortfall.
    store_files = store_inventory_local()
    if not args.dry_run:
        ssh(f"rm -f {shlex.quote(REPO)}/store/claudeclaw.db-wal "
            f"{shlex.quote(REPO)}/store/claudeclaw.db-shm", timeout=30)
        log("  zenom1 stale -wal/-shm torolve")
    else:
        log("  DRY-RUN: -wal/-shm torles kihagyva")
    rsync(f"{REPO}/store/", f"{ZENOM}:{REPO}/store/", EXCLUDE_STORE, args.dry_run)
    # The snapshot is copied WITHOUT --delete (single file, and --delete against
    # a file target is meaningless); a separate call keeps the store/ leg's
    # exclusion set honest.
    snap_cmd = ["rsync", "-a", "-e",
                f"ssh -i {SSH_KEY} -o BatchMode=yes -o ConnectTimeout=10"]
    if args.dry_run:
        snap_cmd += ["--dry-run", "-i"]
    snap_cmd += [SNAPSHOT, f"{ZENOM}:{REPO}/store/claudeclaw.db"]
    run(snap_cmd, timeout=RSYNC_TIMEOUT, ok_codes=(0, 24))
    log("  store/ kesz")

    # -- 5/6. ~/.claude + ~/.claude.json -----------------------------------
    log("5. ~/.claude/ rsync")
    rsync(f"{HOME}/.claude/", f"{ZENOM}:{HOME}/.claude/", EXCLUDE_CLAUDE, args.dry_run)
    log("6. ~/.claude.json")
    cj = ["rsync", "-a", "-e",
          f"ssh -i {SSH_KEY} -o BatchMode=yes -o ConnectTimeout=10"]
    if args.dry_run:
        cj += ["--dry-run", "-i"]
    cj += [f"{HOME}/.claude.json", f"{ZENOM}:{HOME}/.claude.json"]
    run(cj, timeout=600, ok_codes=(0, 24))

    # -- 7. git ------------------------------------------------------------
    git_info = {"head": local_cmd_text(["git", "-C", REPO, "rev-parse", "HEAD"]),
                "branch": local_cmd_text(["git", "-C", REPO, "rev-parse", "--abbrev-ref", "HEAD"])}
    if args.dry_run:
        log("7. git push kihagyva (dry-run)")
    else:
        log("7. git push develop -> zenom1:wsl-develop")
        # zenom1 has wsl-develop CHECKED OUT, so the default
        # receive.denyCurrentBranch=refuse would reject the push. `ignore` lets
        # the ref move while leaving the working tree alone -- correct here,
        # because the working tree is owned by rsync, not by git checkout.
        # (`updateInstead` would fight rsync for the tree; never use it here.)
        ssh(f"git -C {shlex.quote(REPO)} config receive.denyCurrentBranch ignore", timeout=30)
        env = dict(os.environ)
        env["GIT_SSH_COMMAND"] = f"ssh -i {SSH_KEY} -o BatchMode=yes -o ConnectTimeout=10"
        p = subprocess.run(["git", "-C", REPO, "push", "-f",
                            f"ssh://{ZENOM}{REPO}", "develop:refs/heads/wsl-develop"],
                           capture_output=True, text=True, timeout=1800, env=env)
        if p.returncode != 0:
            raise SyncError(f"git push sikertelen (rc={p.returncode}): {p.stderr.strip()[:800]}")
        # HEAD already points at wsl-develop on zenom1; only the index is stale
        # after the ref moved. `reset --mixed` realigns the index WITHOUT
        # touching the working tree, so `git status` on zenom1 mirrors WSL.
        # Never `checkout -f` here: that would discard the rsynced content of
        # any tracked file modified but not committed on WSL.
        rp = ssh(f"git -C {shlex.quote(REPO)} reset --mixed -q 2>&1 | tail -3; "
                 f"git -C {shlex.quote(REPO)} rev-parse HEAD", timeout=300, check=False)
        remote_head = rp.stdout.strip().splitlines()[-1] if rp.stdout.strip() else ""
        git_info["zenom1_head"] = remote_head
        if remote_head != git_info["head"]:
            raise SyncError(f"git HEAD elteres a push utan: WSL={git_info['head']} "
                            f"zenom1={remote_head}")
        log(f"  git ok, HEAD={remote_head[:12]}")

    # -- 8. informational drift ------------------------------------------
    log("8. informacios drift-rogzites (crontab, systemd unit-fajlok)")
    cron_local = local_cmd_text(["crontab", "-l"])
    cron_remote = ssh("crontab -l 2>&1 || true", timeout=30, check=False).stdout.strip()
    units_local = unit_inventory_local()
    try:
        units_remote = json.loads(ssh_python(UNIT_INVENTORY_REMOTE, timeout=60))
    except Exception as e:  # noqa: BLE001 -- informational only
        units_remote = {"<hiba>": str(e)}
    unit_diff = {
        "only_wsl": sorted(set(units_local) - set(units_remote)),
        "only_zenom1": sorted(set(units_remote) - set(units_local)),
        "content_differs": sorted(n for n in set(units_local) & set(units_remote)
                                  if units_local[n] != units_remote[n]),
    }
    log(f"  unit-diff: csak-WSL={unit_diff['only_wsl']} csak-zenom1={unit_diff['only_zenom1']} "
        f"eltero={unit_diff['content_differs']}")
    if cron_local != cron_remote:
        log(f"  crontab elteres: WSL='{cron_local[:80]}' zenom1='{cron_remote[:80]}'")

    # -- 9. manifest -------------------------------------------------------
    manifest = {
        "created_at": started.isoformat(timespec="seconds"),
        "finished_at": datetime.now().isoformat(timespec="seconds"),
        "sync_seconds": round(time.time() - t0, 1),
        "dry_run": args.dry_run,
        "source_host": socket.gethostname(),
        "target": ZENOM,
        "db_sha256": digest,
        "db_bytes": size,
        "db_row_counts": counts,
        "db_row_count_errors": count_errors,
        "db_boot_mutable_tables": BOOT_MUTABLE_TABLES,
        "ddl": ddl,
        "ddl_objects": ddl_objects,
        "ddl_skipped": ddl_skipped,
        "fts_tables": fts_tables,
        "store_files": store_files,
        "exclude_repo": EXCLUDE_REPO,
        "exclude_store": EXCLUDE_STORE,
        "exclude_claude": EXCLUDE_CLAUDE,
        "git": git_info,
        "crontab_wsl": cron_local,
        "crontab_zenom1": cron_remote,
        "systemd_unit_diff": unit_diff,
    }
    if args.dry_run:
        log("9. manifest NEM irodott ki (dry-run)")
    else:
        tmp = MANIFEST + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=2)
        os.replace(tmp, MANIFEST)  # atomic: Phase B never reads a half-written manifest
        log(f"9. manifest kiirva: {MANIFEST}")

    log(f"mirror-sync KESZ {manifest['sync_seconds']}s alatt")
    clear_failstreak()
    return 0


def main():
    ap = argparse.ArgumentParser(description="zenom1 mirror-then-swap, A fazis (tukrozes)")
    ap.add_argument("--dry-run", action="store_true",
                    help="rsync --dry-run mindenhol, semmi tavoli iras, nincs git push")
    ap.add_argument("--no-alert", action="store_true", help="ne kuldjon Telegram riasztast")
    args = ap.parse_args()
    try:
        return do_sync(args)
    except SyncError as e:
        log(f"HIBA: {e}")
        alert("mirror-sync", str(e), enabled=not args.no_alert)
        return 1
    except subprocess.TimeoutExpired as e:
        msg = f"idotullepes: {str(e)[:400]}"
        log(f"HIBA: {msg}")
        alert("mirror-sync-timeout", msg, enabled=not args.no_alert)
        return 1
    except Exception as e:  # noqa: BLE001 -- last resort, must still alert
        msg = f"varatlan kivetel: {e}\n{traceback.format_exc()[-1200:]}"
        log(f"HIBA: {msg}")
        alert("mirror-sync-unexpected", msg, enabled=not args.no_alert)
        return 1


if __name__ == "__main__":
    sys.exit(main())
