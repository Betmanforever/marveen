#!/usr/bin/env python3
"""Nightly, secret-free memory backup to a third, offsite location (Google Drive).

Full spec + audit trail: agents/neo/nightly-backup-protocol-PLAN.md (v6, five
auditor rounds). This script is the executable form of that plan; the section
numbers in the comments below refer to it.

Purpose (and the line it must never cross): scripts/backup.sh is the local,
secret-BEARING disaster-recovery snapshot and its own comment forbids syncing
it to any cloud. This script is the opposite trade: a narrow, secret-FREE
export of the fleet's memory/knowledge that may leave the host, so a total
host loss is survivable without a single credential travelling with it.

What it does, in order:
  1. fail-closed baseline load (never silently re-baselines)   -- plan 1/23
  2. one consistent SQLite snapshot (Connection.backup)        -- plan C5
  3. JSON dump of an explicit table allowlist + filtered DDL   -- plan C2/D3
  4. raw file collection by runtime discovery + per-category
     non-empty assertions against the baseline                 -- plan C1/D4
  5. git state manifest (what commits would be lost)           -- plan 1
  6. two-layer secret scan: value-shaped = hard stop,
     keyword mention = quarantine note only                    -- plan D1
  7. tar.gz + gzip integrity + sha256 + row-count re-check     -- plan 5
  8. Drive storage-quota pre-check (stop BEFORE uploading)     -- plan 6b
  9. upload through scripts/google-mcp/drive-upload.py         -- plan 7/10
 10. local retention prune, only after a successful upload     -- plan 4
 11. Telegram: manifest + checksum on success, alert on any
     failure, over the bot token directly (never /api/messages
     and never the archive itself)                             -- plan C4/D2

Usage:
  nightly-memory-backup.py                 full run (upload + prune)
  nightly-memory-backup.py --dry-run       everything except upload and prune
  nightly-memory-backup.py --update-baseline
                                           deliberately re-baseline the
                                           category counts from the live state
                                           (never happens by itself)
  nightly-memory-backup.py --rehearsal [archive.tar.gz]
                                           restore rehearsal: rebuild a sandbox
                                           DB from the exported DDL, load the
                                           rows, rebuild the FTS index and run a
                                           real MATCH query (plan C3/D3)
"""

import argparse
import base64
import fnmatch
import glob
import gzip
import hashlib
import json
import os
import re
import shutil
import socket
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOME = os.path.expanduser("~")
REPO_REAL = os.path.realpath(REPO)
HOME_REAL = os.path.realpath(HOME)

DB = f"{REPO}/store/claudeclaw.db"
BASELINE_FILE = f"{REPO}/scripts/nightly-backup-baseline.json"
STAGING_ROOT = f"{REPO}/backups/nightly-memory"
WORK_DIR = f"{STAGING_ROOT}/.work"
UPLOAD_DIR = f"{STAGING_ROOT}/.upload"

DASHBOARD_TOKEN_FILE = f"{REPO}/store/.dashboard-token"
DAILY_LOG_API = "http://localhost:3420/api/daily-log"

TELEGRAM_ENV = f"{HOME}/.claude/channels/telegram/.env"
TELEGRAM_CHAT_ID = "8765540529"
# Known-and-expected failure mode, so a weekly 401 does not start a new
# investigation every time (plan 26).
OAUTH_HINT = ('Megjegyzes: ha OAuth/401-hiba, lasd kanban #135 (tartos Google-fix) -- '
              'vart, amig a kliens "Testing" statuszu, kb. heti egy hibazas normalis, '
              'amig #135 le nem zar.')

DRIVE_TOKEN = f"{HOME}/.gmail-mcp/drive-personal.json"
DRIVE_UPLOAD = f"{REPO}/scripts/google-mcp/drive-upload.py"
# "Marveen Backups" on zenom@zenom.hu My Drive. Gabor explicitly overrode fleet
# rule 2 ("never write to My Drive") for this single target (plan 3, v6).
DRIVE_FOLDER_ID_DEFAULT = "1oNq21oKw7Bs6ww9Z0aUbS1FAqK9KlAez"

KEEP_DAILY = 14
KEEP_WEEKLY = 8
QUOTA_MAX_USED_RATIO = 0.90
QUOTA_HEADROOM = 30 * 1024 * 1024

# Plan 1: the only tables whose ROWS leave the host. Anything outside this set
# reaching the export is drift and stops the run (plan C2).
EXPORT_TABLES = (
    "memories",
    "daily_logs",
    "kanban_cards",
    "kanban_comments",
    "kanban_card_labels",
    "labels",
    "config_change_log",
)
TABLE_ALLOWLIST = frozenset(EXPORT_TABLES)

# Plan 2, layer 2: filename denylist for raw files.
DENY_NAMES = ("*.token", "*dashboard-token*", "*oauth*.json", "*credentials*.json",
              "*.pem", "id_*", ".env", "*access.json*", "*.jsonl")

# Plan 2, layer 3a: value-shaped patterns. A hit here means an actual secret
# value is in the payload -> hard stop, nothing is uploaded.
HARD_PATTERNS = {
    "anthropic_key": re.compile(r"sk-ant-[A-Za-z0-9_-]{20,}"),
    "github_pat": re.compile(r"ghp_[A-Za-z0-9]{36}"),
    "slack_bot_token": re.compile(r"xoxb-[\d-]+"),
    "google_api_key": re.compile(r"AIza[A-Za-z0-9_-]{35}"),
    "telegram_bot_token": re.compile(r"[0-9]{9,10}:AA[\w-]{30,}"),
    "private_key_block": re.compile(r"-----BEGIN[A-Z ]*PRIVATE KEY-----"),
}
# Plan 2, layer 3b: bare keyword mentions. Documentation and memories talk
# about these words constantly; a hard stop here would produce an empty backup
# every night and push towards weakening the control (plan D1). Quarantine
# list in the manifest instead.
SOFT_PATTERNS = {
    "private_key_word": re.compile(r"private_key"),
    "client_secret_word": re.compile(r"client_secret"),
    "refresh_token_word": re.compile(r"refresh_token"),
    "jwt_prefix": re.compile(r"eyJ"),
}

# Plan 2: hard path deny. These trees are read for AUTHENTICATION (bot token,
# dashboard token, Drive refresh token) and must never be read for EXPORT --
# keeping the two purposes from ever meeting is the point.
HARD_DENY_DIRS = (f"{REPO}/store", f"{HOME}/.gmail-mcp", f"{HOME}/.claude/channels")

PRUNE_DIRS = ("node_modules",)


class BackupError(Exception):
    """Controlled failure: alert, exit non-zero, upload nothing."""


# --------------------------------------------------------------------------
# small helpers
# --------------------------------------------------------------------------

def human(n):
    return f"{n / 1024 / 1024:.2f} MB" if n >= 1024 * 1024 else f"{n / 1024:.1f} kB"


def log(msg):
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


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


def drive_folder_id():
    return (os.environ.get("OWNER_DRIVE_FOLDER")
            or env_value(f"{REPO}/.env", "OWNER_DRIVE_FOLDER")
            or DRIVE_FOLDER_ID_DEFAULT)


def is_weekly_run(when):
    """Monday promotes the night to weekly/ -- `date +%u` == 1, nothing else.

    Deterministic on purpose (plan 4): "the week's first run" would silently
    slide to Tuesday after a Monday outage and quietly break the retention
    ladder.
    """
    return when.isoweekday() == 1


def under(path, parent):
    return path == parent or path.startswith(parent.rstrip("/") + "/")


# --------------------------------------------------------------------------
# notification (plan 6 / C4 / D2)
# --------------------------------------------------------------------------

def telegram_send(text):
    """Direct Bot API call. NOT /api/messages (drain-dependent, dead exactly
    when an alert is needed) and NOT the `reply` MCP tool (uncallable from a
    standalone script).

    urllib instead of shelling out to curl: identical request, but the bot
    token never appears in a process argument list.
    """
    token = env_value(TELEGRAM_ENV, "TELEGRAM_BOT_TOKEN")
    if not token:
        raise BackupError(f"no TELEGRAM_BOT_TOKEN in {TELEGRAM_ENV}")
    body = json.dumps({"chat_id": TELEGRAM_CHAT_ID, "text": text[:3900]}).encode()
    req = urllib.request.Request(f"https://api.telegram.org/bot{token}/sendMessage",
                                 data=body, method="POST",
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        payload = json.load(r)
    if not payload.get("ok"):
        raise BackupError(f"Telegram API rejected the message: {str(payload)[:200]}")


def daily_log(content):
    """Best effort: the dashboard may be down at 03:00, that must not fail a
    backup that already succeeded."""
    try:
        with open(DASHBOARD_TOKEN_FILE) as f:
            token = f.read().strip()
        body = json.dumps({"agent_id": "neo", "content": content}).encode()
        req = urllib.request.Request(DAILY_LOG_API, data=body, method="POST",
                                     headers={"Content-Type": "application/json",
                                              "Authorization": f"Bearer {token}"})
        with urllib.request.urlopen(req, timeout=15) as r:
            r.read()
        return True
    except Exception as e:  # noqa: BLE001 -- deliberately non-fatal
        log(f"WARN: daily log write failed ({e})")
        return False


def alert(stage, message, quiet=False):
    text = (f"[nightly-memory-backup] HIBA -- {stage}\n"
            f"{message}\n"
            f"Host: {socket.gethostname()}  Ido: {datetime.now():%Y-%m-%d %H:%M:%S}\n"
            f"{OAUTH_HINT}")
    if quiet:
        log("DRY-RUN, riasztas NEM ment el Telegramra:\n" + text)
        return
    try:
        telegram_send(text)
        log("riasztas elkuldve Telegramra")
    except Exception as e:  # noqa: BLE001
        log(f"CRITICAL: az alert sem ment ki ({e}) -- eredeti hiba: {message}")


# --------------------------------------------------------------------------
# baseline (plan 1 / 23 -- fail closed)
# --------------------------------------------------------------------------

def load_baseline():
    if not os.path.exists(BASELINE_FILE):
        raise BackupError(
            f"nincs baseline ({BASELINE_FILE}) -- manualis felulvizsgalat szukseges, "
            "mielott a script barmit is bazisolna. A script SOHA nem general csendben "
            "ujat a pillanatnyi allapotbol (friss klon vagy visszaallitott, esetleg "
            "degradalt host eseten az valna az uj normava). Szandekos ujra-bazisolas: "
            "nightly-memory-backup.py --update-baseline")
    with open(BASELINE_FILE) as f:
        return json.load(f)


# --------------------------------------------------------------------------
# file discovery (plan 1 -- runtime find, never fixed globs)
# --------------------------------------------------------------------------

def walk_files(root, follow=False, suffix=None, names=None):
    """Collect files under root.

    follow=True dereferences symlinked directories (plan D4 `find -L`), with a
    realpath guard so a symlink loop cannot spin or duplicate. node_modules is
    always pruned (plan 22).
    """
    out, seen = [], set()
    if not os.path.isdir(root):
        return out
    for dirpath, dirnames, filenames in os.walk(root, followlinks=follow):
        real = os.path.realpath(dirpath)
        if real in seen:
            dirnames[:] = []
            continue
        seen.add(real)
        dirnames[:] = sorted(d for d in dirnames if d not in PRUNE_DIRS)
        for name in sorted(filenames):
            if suffix and not name.endswith(suffix):
                continue
            if names and name not in names:
                continue
            out.append(os.path.join(dirpath, name))
    return out


def existing(paths):
    return [p for p in paths if os.path.isfile(p)]


def d_identity():
    paths = [f"{REPO}/CLAUDE.md", f"{REPO}/SOUL.md"]
    paths += sorted(glob.glob(f"{REPO}/agents/*/CLAUDE.md"))
    paths += sorted(glob.glob(f"{REPO}/agents/*/SOUL.md"))
    return existing(paths)


def d_neo_file_memory():
    # Plan B17: the REAL directory, not the .claude-config symlink -- that way
    # the dereference requirement disappears at the highest-value payload.
    return walk_files(f"{REPO}/agents/neo/.claude/projects/-home-szabgabor-marveen/memory",
                      follow=True, suffix=".md")


def d_agent_memory_placeholder():
    # Empty today (0 bytes); "0 is OK" holds only while the baseline says so.
    return existing([f"{REPO}/agents/{a}/memory/MEMORY.md" for a in ("alex", "charlie", "ive")])


def d_mrwolfe_home_memory():
    return walk_files(f"{HOME}/.claude/projects/-home-szabgabor-marveen/memory",
                      follow=True, suffix=".md")


def d_repo_agent_memory():
    return walk_files(f"{REPO}/.claude/agent-memory", follow=True)


def d_scattered_memory_dirs():
    """Sub-agent memory scattered by spawn cwd.

    Mirrors the plan's final pattern exactly (plan 22):
      find $REPO -path '*/node_modules/*' -prune -o \\
           \\( -iname agent-memory -o -iname memory \\) -type d -print
    No -L here on purpose: following symlinks would re-enter the same trees
    through agents/*/.claude-config and duplicate every file.
    """
    hits, out, seen = [], [], set()
    backups_dir = f"{REPO}/backups"
    for dirpath, dirnames, _ in os.walk(REPO, followlinks=False):
        # backups/ is this script's own output tree: a half-written or failed
        # run leaves an extracted payload there containing a literal
        # ".../projects/.../memory" directory, which the sweep would happily
        # re-ingest on the next run. Backups are never a memory source.
        if under(dirpath, backups_dir):
            dirnames[:] = []
            continue
        dirnames[:] = [d for d in dirnames if d not in PRUNE_DIRS]
        for d in sorted(dirnames):
            if d.lower() in ("agent-memory", "memory"):
                hits.append(os.path.join(dirpath, d))
    for h in sorted(hits):
        for p in walk_files(h, follow=False):
            real = os.path.realpath(p)
            if real not in seen:
                seen.add(real)
                out.append(p)
    return out


def d_skills():
    return walk_files(f"{HOME}/.claude/skills", follow=True)


def d_subagent_defs():
    return sorted(glob.glob(f"{REPO}/.claude/agents/*.md"))


def d_slash_commands():
    return sorted(glob.glob(f"{REPO}/.claude/commands/*.md"))


def d_scheduled_tasks():
    return walk_files(f"{HOME}/.claude/scheduled-tasks", follow=True,
                      names={"SKILL.md", "task-config.json"})


def d_mcp_config():
    # Path references to credential files only, never the secrets themselves.
    return existing([f"{REPO}/.mcp.json"] + sorted(glob.glob(f"{REPO}/agents/*/.mcp.json")))


def d_baseline_state():
    # The script's own state file: not secret, but the backup needs it to keep
    # working after a restore (plan 23).
    return existing([BASELINE_FILE])


def d_self_script():
    # The orchestrator itself, plus the transport it shells out to. A restore
    # that has the baseline but not the script that reads it is useless -
    # gap found during live verification, closing it here rather than leaving
    # it for a future incident.
    return existing([
        f"{REPO}/scripts/nightly-memory-backup.py",
        f"{REPO}/scripts/google-mcp/drive-upload.py",
        f"{REPO}/scripts/google-mcp/gapi.py",
    ])


CATEGORIES = (
    ("identity", d_identity),
    ("neo_file_memory", d_neo_file_memory),
    ("agent_memory_placeholder", d_agent_memory_placeholder),
    ("mrwolfe_home_memory", d_mrwolfe_home_memory),
    ("repo_agent_memory", d_repo_agent_memory),
    ("scattered_memory_dirs", d_scattered_memory_dirs),
    ("skills", d_skills),
    ("subagent_defs", d_subagent_defs),
    ("slash_commands", d_slash_commands),
    ("scheduled_tasks", d_scheduled_tasks),
    ("mcp_config", d_mcp_config),
    ("baseline_state", d_baseline_state),
    ("self_script", d_self_script),
)


def discover_all():
    """Run every category discovery. Returns {category: [abs paths]}."""
    found = {}
    for name, fn in CATEGORIES:
        t0 = time.time()
        found[name] = fn()
        log(f"  discovery {name:26} {len(found[name]):5} fajl  ({time.time() - t0:.1f}s)")
    return found


def category_stats(found):
    stats = {}
    for name, paths in found.items():
        size = 0
        for p in paths:
            try:
                size += os.path.getsize(p)
            except OSError:
                pass
        stats[name] = {"files": len(paths), "bytes": size}
    return stats


# --------------------------------------------------------------------------
# staging (raw files)
# --------------------------------------------------------------------------

def stage_rel(src_real):
    """repo/... and home/... top-level groups, same convention as backup.sh, so
    a restore is unambiguous about where each file belongs."""
    if under(src_real, REPO_REAL):
        return os.path.join("repo", os.path.relpath(src_real, REPO_REAL))
    if under(src_real, HOME_REAL):
        return os.path.join("home", os.path.relpath(src_real, HOME_REAL))
    raise BackupError(f"include path outside repo and home: {src_real}")


def assert_not_denied(src_real):
    for deny in HARD_DENY_DIRS:
        if under(src_real, os.path.realpath(deny)):
            raise BackupError(
                f"HARD PATH DENY: {src_real} a tiltott {deny} fa alol jonne -- "
                "az include-logika hibas, a futas leall (plan 2).")


def name_denied(basename):
    for pat in DENY_NAMES:
        if fnmatch.fnmatch(basename, pat):
            return pat
    return None


def stage_raw_files(found, payload_dir):
    """Copy every discovered file into the payload tree, dereferencing symlinks
    (never storing a symlink whose absolute target would dangle on restore)."""
    excluded, staged, seen = [], 0, set()
    for name, paths in found.items():
        for p in paths:
            real = os.path.realpath(p)
            assert_not_denied(real)
            pat = name_denied(os.path.basename(real))
            if pat:
                excluded.append({"category": name, "path": real, "pattern": pat})
                continue
            if real in seen:
                continue
            seen.add(real)
            rel = stage_rel(real)
            dest = os.path.join(payload_dir, rel)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            shutil.copyfile(real, dest)  # follows symlinks, copies content
            staged += 1
    return staged, excluded


# --------------------------------------------------------------------------
# database export (plan C5 / C2 / D3)
# --------------------------------------------------------------------------

def snapshot_db(dest):
    """One consistent point-in-time copy.

    memoria-heartbeat (*/15) and pending-uzenet-watchdog (*/5) can both fire at
    03:00, so per-table SELECTs would tear across concurrent writes (plan C5).
    Connection.backup() with the default pages=-1 copies the whole DB inside a
    single read transaction.
    """
    src = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    try:
        dst = sqlite3.connect(dest)
        try:
            src.backup(dst)
        finally:
            dst.close()
    finally:
        src.close()


def encode_value(v):
    if isinstance(v, bytes):
        return {"__base64__": base64.b64encode(v).decode()}
    return v


def decode_value(v):
    if isinstance(v, dict) and "__base64__" in v:
        return base64.b64decode(v["__base64__"])
    return v


def export_ddl(conn):
    """Filtered, replay-ordered schema DDL.

    Raw `SELECT sql FROM sqlite_master` cannot be replayed (plan D3): it
    contains the FTS5 shadow tables as plain CREATE TABLEs, sqlite_sequence
    (created implicitly by AUTOINCREMENT) and sqlite_autoindex_* rows whose sql
    is NULL. Shadow names are derived from the FTS table name (`<fts>_%`), not
    hardcoded, so a second FTS5 table later cannot reopen this bug.

    There is deliberately no hand-written schema fallback: if this fails, the
    rehearsal fails loudly rather than asserting against an assumed schema.
    """
    rows = conn.execute("SELECT type, name, tbl_name, sql FROM sqlite_master").fetchall()
    fts_tables = {
        name for typ, name, _tbl, sql in rows
        if typ == "table" and sql and re.match(r"\s*CREATE\s+VIRTUAL\s+TABLE", sql, re.I)
        and "fts5" in sql.lower()
    }
    shadow_prefixes = tuple(f"{n}_" for n in fts_tables)

    kept, skipped = [], []
    for idx, (typ, name, tbl, sql) in enumerate(rows):
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


def dump_tables(conn, db_dir):
    """JSON dump of the allowlisted tables + a COUNT(*) cross-check from the
    same snapshot (guards against a truncated export)."""
    all_tables = {r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'")}

    drift = [t for t in EXPORT_TABLES if t not in TABLE_ALLOWLIST]
    if drift:
        raise BackupError(f"tabla-allowlist drift: {drift} exportalasra kerulne, de nincs "
                          "az allowlisten (plan C2)")
    missing = [t for t in EXPORT_TABLES if t not in all_tables]
    if missing:
        raise BackupError(f"az allowlistelt tabla(k) hianyoznak a semabol: {missing} -- "
                          "sema-regresszio, a futas leall")

    counts = {}
    for table in EXPORT_TABLES:
        expected = conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
        cur = conn.execute(f'SELECT * FROM "{table}"')
        cols = [d[0] for d in cur.description]
        rows = [{c: encode_value(v) for c, v in zip(cols, r)} for r in cur]
        if len(rows) != expected:
            raise BackupError(f"{table}: COUNT(*)={expected} de {len(rows)} sort olvastam")
        path = os.path.join(db_dir, f"{table}.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(rows, f, ensure_ascii=False)
        with open(path, encoding="utf-8") as f:  # re-parse: validity + element count
            reread = json.load(f)
        if len(reread) != expected:
            raise BackupError(f"{table}: a kiirt JSON {len(reread)} elem, vart {expected}")
        counts[table] = expected
        log(f"  dump {table:24} {expected:6} sor  {human(os.path.getsize(path))}")
    return counts, sorted(all_tables)


# --------------------------------------------------------------------------
# git state manifest (plan 1)
# --------------------------------------------------------------------------

def git_state_text():
    def git(*args):
        return subprocess.run(["git", "-C", REPO, *args], capture_output=True,
                              text=True, timeout=60).stdout.strip()

    if not shutil.which("git"):
        return "git nem elerheto a PATH-on -- git-allapot nem rogzitheto\n"

    branch = git("rev-parse", "--abbrev-ref", "HEAD")
    head = git("rev-parse", "HEAD")
    lines = [f"branch: {branch}", f"HEAD:   {head}", ""]
    for remote in git("remote").split():
        ref = f"{remote}/{branch}"
        if not git("rev-parse", "--verify", "--quiet", ref):
            lines.append(f"{ref}: nincs ilyen remote-koveto ag")
            continue
        counts = git("rev-list", "--left-right", "--count", f"{ref}...HEAD")
        behind, ahead = (counts.split() + ["?", "?"])[:2]
        lines.append(f"{ref}: {ahead} commit ahead, {behind} commit behind")
        subjects = git("log", "--oneline", "--no-decorate", f"{ref}..HEAD").splitlines()
        if subjects:
            lines.append(f"  el nem kuldott commitok ({len(subjects)}):")
            lines += [f"    {s}" for s in subjects[:200]]
            if len(subjects) > 200:
                lines.append(f"    ... es meg {len(subjects) - 200}")
    dirty = git("status", "--porcelain").splitlines()
    lines += ["", f"working tree: {len(dirty)} modositott/uj bejegyzes"]
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------
# secret scan (plan D1)
# --------------------------------------------------------------------------

def secret_scan(payload_dir):
    hard, soft = [], {}
    for dirpath, dirnames, filenames in os.walk(payload_dir):
        dirnames.sort()
        for name in sorted(filenames):
            path = os.path.join(dirpath, name)
            rel = os.path.relpath(path, payload_dir)
            with open(path, "rb") as f:
                text = f.read().decode("utf-8", errors="replace")
            for key, rx in HARD_PATTERNS.items():
                for m in rx.finditer(text):
                    hard.append({
                        "pattern": key,
                        "file": rel,
                        "line": text.count("\n", 0, m.start()) + 1,
                        # never echo the value itself
                        "masked": m.group(0)[:6] + "..." + f"[{len(m.group(0))} char]",
                    })
            for key, rx in SOFT_PATTERNS.items():
                n = len(rx.findall(text))
                if n:
                    soft.setdefault(key, []).append({"file": rel, "count": n})
    return hard, soft


# --------------------------------------------------------------------------
# archive + verification (plan 5)
# --------------------------------------------------------------------------

def build_archive(payload_dir, archive_path):
    files = []
    for dirpath, dirnames, filenames in os.walk(payload_dir):
        dirnames.sort()
        for name in sorted(filenames):
            files.append(os.path.join(dirpath, name))
    with tarfile.open(archive_path, "w:gz") as tar:
        for p in files:
            tar.add(p, arcname=os.path.relpath(p, payload_dir))
    return len(files)


def verify_archive(archive_path, expected_members):
    """gzip integrity (the `gzip -t` equivalent) plus a full tar member scan --
    a valid gzip stream carrying a truncated tar would otherwise pass."""
    with gzip.open(archive_path, "rb") as f:
        while f.read(1024 * 1024):
            pass
    with tarfile.open(archive_path, "r:gz") as tar:
        members = [m for m in tar.getmembers() if m.isfile()]
    if len(members) != expected_members:
        raise BackupError(f"archivum ellenorzes: {len(members)} fajl az archivumban, "
                          f"vart {expected_members}")
    return len(members)


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


# --------------------------------------------------------------------------
# Drive quota + upload (plan 6b / 7)
# --------------------------------------------------------------------------

def drive_access_token():
    # SA + domain-wide delegation (sa-drive-token.mjs, subject
    # gabor.szabo@zenom.hu) -- the SAME auth path the drive-zenom MCP proves
    # live daily. The old OAuth token files failed both ways (card 139f8f1c,
    # 2026-07-30): drive-personal.json is the WRONG IDENTITY for the zenom
    # target folder (HTTP 404), drive-zenom.json is invalid_grant-expired.
    proc = subprocess.run(["node", f"{REPO}/scripts/google-mcp/sa-drive-token.mjs"],
                          capture_output=True, text=True, timeout=60)
    if proc.returncode != 0 or not proc.stdout.strip():
        raise BackupError(f"sa-drive-token.mjs exit {proc.returncode}: {(proc.stderr or '')[-400:]}")
    return proc.stdout.strip()


def check_quota(archive_size):
    """Stop BEFORE the upload if the account cannot take the archive, instead
    of tearing halfway through (plan 6b)."""
    token = drive_access_token()
    req = urllib.request.Request(
        "https://www.googleapis.com/drive/v3/about?fields=storageQuota,user(emailAddress)",
        headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = json.load(r)
    quota = data.get("storageQuota", {})
    account = data.get("user", {}).get("emailAddress", "?")
    usage = int(quota.get("usage", 0))
    limit = quota.get("limit")
    if limit is None:  # unlimited pool: nothing to check against
        info = f"{account}: usage {human(usage)}, nincs limit (unlimited)"
        log(f"  kvota OK -- {info}")
        return info
    limit = int(limit)
    free = limit - usage
    ratio = usage / limit if limit else 0.0
    info = (f"{account}: {human(usage)} / {human(limit)} hasznalt ({ratio:.1%}), "
            f"szabad {human(free)}")
    if ratio >= QUOTA_MAX_USED_RATIO:
        raise BackupError(f"Drive kvota kuszob atlepve ({ratio:.1%} >= "
                          f"{QUOTA_MAX_USED_RATIO:.0%}) -- {info}. Feltoltes NEM indult el.")
    if free < archive_size + QUOTA_HEADROOM:
        raise BackupError(f"nincs eleg szabad hely: {human(free)} < archivum "
                          f"{human(archive_size)} + tartalek {human(QUOTA_HEADROOM)} -- "
                          f"{info}. Feltoltes NEM indult el.")
    log(f"  kvota OK -- {info}")
    return info


def upload(upload_root, folder_id):
    """Hand the whole night folder to the already battle-tested uploader.

    No parallel upload logic here on purpose: drive-upload.py carries the
    size-verified skip, the resumable path and the fields=id,name,size fix that
    only a live test surfaced.
    """
    env = dict(os.environ, DRIVE_ACCESS_TOKEN=drive_access_token())
    proc = subprocess.run([sys.executable, DRIVE_UPLOAD, DRIVE_TOKEN, upload_root, folder_id],
                          capture_output=True, text=True, timeout=1800, env=env)
    out = (proc.stdout or "").strip()
    err = (proc.stderr or "").strip()
    if proc.returncode != 0:
        raise BackupError(f"drive-upload.py exit {proc.returncode}\nstdout: {out[-800:]}\n"
                          f"stderr: {err[-800:]}")
    return out


# --------------------------------------------------------------------------
# retention (plan 4)
# --------------------------------------------------------------------------

def prune_tier(tier, keep):
    """Timestamped directory names sort chronologically, so no mtime games."""
    tier_dir = os.path.join(STAGING_ROOT, tier)
    if not os.path.isdir(tier_dir):
        return []
    entries = sorted((d for d in os.listdir(tier_dir)
                      if os.path.isdir(os.path.join(tier_dir, d))), reverse=True)
    removed = []
    for d in entries[keep:]:
        shutil.rmtree(os.path.join(tier_dir, d))
        removed.append(d)
    return removed


# --------------------------------------------------------------------------
# nightly run
# --------------------------------------------------------------------------

def run_nightly(dry_run):
    started = datetime.now()
    stamp = started.strftime("%Y%m%d-%H%M%S")
    tier = "weekly" if is_weekly_run(started) else "daily"
    archive_name = f"marveen-memory-{stamp}.tar.gz"
    folder_id = drive_folder_id()

    if os.path.isdir(WORK_DIR):
        shutil.rmtree(WORK_DIR)
    if os.path.isdir(UPLOAD_DIR):
        shutil.rmtree(UPLOAD_DIR)
    payload_dir = f"{WORK_DIR}/{stamp}/payload"
    db_dir = f"{payload_dir}/db"
    os.makedirs(db_dir, exist_ok=True)

    log(f"nightly-memory-backup {stamp}  tier={tier}  dry_run={dry_run}")

    # 1. baseline, fail closed
    baseline = load_baseline()
    log(f"baseline betoltve ({BASELINE_FILE}, {baseline.get('created_at')})")

    # 2-3. consistent snapshot -> JSON dumps + filtered DDL
    snap = f"{WORK_DIR}/{stamp}/snapshot.db"
    snapshot_db(snap)
    log(f"konzisztens DB pillanatkep: {human(os.path.getsize(snap))}")
    conn = sqlite3.connect(f"file:{snap}?mode=ro", uri=True)
    try:
        ddl, ddl_objects, ddl_skipped, fts_tables = export_ddl(conn)
        with open(f"{db_dir}/schema.sql", "w", encoding="utf-8") as f:
            f.write(ddl + "\n")
        log(f"  DDL: {len(ddl_objects)} objektum megtartva, {len(ddl_skipped)} kiszurve "
            f"(FTS5 shadow + sqlite_*), fts5 tablak: {fts_tables}")
        row_counts, all_tables = dump_tables(conn, db_dir)
    finally:
        conn.close()

    # 4. raw files + per-category assertions
    log("fajl-felderites (futaskori find, nem fix glob):")
    found = discover_all()
    stats = category_stats(found)
    base_cats = baseline.get("categories", {})
    grown, unknown = [], []
    for name, cur in stats.items():
        ref = base_cats.get(name)
        if ref is None:
            unknown.append(name)
            continue
        if ref["files"] > 0 and cur["files"] == 0:
            raise BackupError(
                f"kategoria '{name}': 0 fajl, a baseline szerint {ref['files']} volt "
                "-- nema ures backup kizarva, a futas leall (plan C1)")
        if ref["bytes"] > 0 and cur["bytes"] == 0:
            raise BackupError(
                f"kategoria '{name}': 0 bajt, a baseline szerint {ref['bytes']} volt "
                "-- nema ures backup kizarva, a futas leall (plan C1)")
        if ref["bytes"] == 0 and cur["bytes"] > 0:
            grown.append(f"{name}: 0 -> {cur['bytes']} B")
    if unknown:
        raise BackupError(f"ismeretlen kategoria a baseline-ban: {unknown} -- a baseline "
                          "elavult, futtasd: --update-baseline (tudatos lepes)")
    staged, excluded = stage_raw_files(found, payload_dir)
    log(f"nyers fajlok stagelve: {staged} (denylist-kizaras: {len(excluded)})")

    # 5. git state
    with open(f"{payload_dir}/git-state.txt", "w", encoding="utf-8") as f:
        f.write(git_state_text())

    # 6. two-layer secret scan
    hard, soft = secret_scan(payload_dir)
    soft_total = sum(h["count"] for hits in soft.values() for h in hits)
    if hard:
        detail = "\n".join(f"  {h['pattern']} @ {h['file']}:{h['line']} ({h['masked']})"
                           for h in hard[:20])
        raise BackupError(f"ERTEK-ALAKU secret-talalat ({len(hard)} db) a payloadban -- "
                          f"SEMMI nem lett feltoltve:\n{detail}")
    log(f"secret-scan: 0 ertek-alaku talalat, {soft_total} kulcsszo-emlites karantenban")

    table_drift = sorted(set(all_tables) ^ set(baseline.get("db_tables", all_tables)))

    # 7. metadata inside the archive, then tar + verification
    info = {
        "created_at": started.isoformat(timespec="seconds"),
        "stamp": stamp,
        "tier": tier,
        "host": socket.gethostname(),
        "db_row_counts": row_counts,
        "db_tables_in_schema": all_tables,
        "ddl_objects": ddl_objects,
        "ddl_skipped": ddl_skipped,
        "fts_tables": fts_tables,
        "category_stats": stats,
        "denylist_excluded": excluded,
        "quarantine_keyword_hits": soft,
        "baseline_created_at": baseline.get("created_at"),
    }
    with open(f"{payload_dir}/BACKUP-INFO.json", "w", encoding="utf-8") as f:
        json.dump(info, f, ensure_ascii=False, indent=2)

    night_dir = f"{UPLOAD_DIR}/{tier}/{stamp}"
    os.makedirs(night_dir, exist_ok=True)
    archive_path = os.path.join(night_dir, archive_name)
    member_count = build_archive(payload_dir, archive_path)
    verify_archive(archive_path, member_count)
    archive_size = os.path.getsize(archive_path)
    digest = sha256_file(archive_path)
    log(f"archivum: {archive_name} {human(archive_size)}, {member_count} fajl, "
        f"gzip+tar integritas OK")

    # manifest + checksum live NEXT TO the archive, never inside it (the
    # manifest carries the archive's own hash)
    manifest = render_manifest(info, archive_name, archive_size, digest, member_count,
                               staged, soft_total, table_drift, grown, folder_id, tier, stamp)
    with open(os.path.join(night_dir, "MANIFEST.txt"), "w", encoding="utf-8") as f:
        f.write(manifest)
    with open(os.path.join(night_dir, "SHA256SUMS"), "w", encoding="utf-8") as f:
        f.write(f"{digest}  {archive_name}\n")

    # 8. quota BEFORE upload
    quota_info = check_quota(archive_size)

    if dry_run:
        log("DRY-RUN -- feltoltes es prune KIMARAD. Amit feltoltene:")
        log(f"  cel: Drive folder {folder_id} (Marveen Backups)")
        for root, _dirs, files in sorted(os.walk(UPLOAD_DIR)):
            for fn in sorted(files):
                p = os.path.join(root, fn)
                log(f"    {os.path.relpath(p, UPLOAD_DIR)}  {human(os.path.getsize(p))}")
        log(f"  staging megmaradt: {UPLOAD_DIR}")
        print("\n" + manifest)
        return {"dry_run": True, "manifest": manifest, "archive": archive_path,
                "sha256": digest, "quota": quota_info}

    # 9. upload
    out = upload(UPLOAD_DIR, folder_id)
    log("drive-upload.py kimenet:\n" + "\n".join("    " + l for l in out.splitlines()))

    # 10. only now may anything be deleted locally
    final_dir = os.path.join(STAGING_ROOT, tier, stamp)
    os.makedirs(os.path.dirname(final_dir), exist_ok=True)
    if os.path.isdir(final_dir):
        shutil.rmtree(final_dir)
    shutil.move(night_dir, final_dir)
    shutil.rmtree(UPLOAD_DIR, ignore_errors=True)
    pruned_daily = prune_tier("daily", KEEP_DAILY)
    pruned_weekly = prune_tier("weekly", KEEP_WEEKLY)
    shutil.rmtree(WORK_DIR, ignore_errors=True)
    log(f"lokalis prune: daily -{len(pruned_daily)}, weekly -{len(pruned_weekly)}")

    # 11. manifest + checksum out, archive stays put
    summary = (f"[nightly-memory-backup] OK {started:%Y-%m-%d %H:%M}\n"
               f"Archivum: {archive_name} ({human(archive_size)}, {member_count} fajl)\n"
               f"sha256: {digest}\n"
               f"Cel: Drive/Marveen Backups/{tier}/{stamp}\n"
               f"Kvota: {quota_info}\n"
               f"Tablak: " + ", ".join(f"{t} {n}" for t, n in row_counts.items()) + "\n"
               f"Nyers fajlok: {staged} ({len(CATEGORIES)} kategoria)\n"
               f"Karanten (kulcsszo-emlites, emberi atnezesre): {soft_total}\n"
               f"Lokalis prune: daily -{len(pruned_daily)}, weekly -{len(pruned_weekly)}")
    if table_drift:
        summary += f"\nFIGYELEM tabla-drift a baseline ota: {', '.join(table_drift)}"
    if grown:
        summary += f"\nFIGYELEM kategoria notte a 0-t: {'; '.join(grown)} (--update-baseline)"
    # The archive is already offsite at this point -- a Telegram outage must not
    # report the night as failed (the scheduler would retry a finished backup),
    # so the notification is best effort and the failure is recorded instead.
    notify_note = ""
    try:
        telegram_send(summary)
    except Exception as e:  # noqa: BLE001
        notify_note = f"\nFIGYELEM: a Telegram-visszajelzes NEM ment ki ({e})"
        log(f"WARN: Telegram siker-visszajelzes sikertelen ({e})")
    daily_log(f"## {started:%H:%M} -- Ejszakai memoria-backup\n{summary}{notify_note}")
    log("kesz")
    return {"dry_run": False, "manifest": manifest, "archive": final_dir,
            "sha256": digest, "quota": quota_info}


def render_manifest(info, archive_name, archive_size, digest, member_count, staged,
                    soft_total, table_drift, grown, folder_id, tier, stamp):
    lines = [
        "MARVEEN EJSZAKAI MEMORIA-BACKUP -- MANIFEST",
        f"keszult:      {info['created_at']}  (host {info['host']})",
        f"archivum:     {archive_name}  {human(archive_size)}  {member_count} fajl",
        f"sha256:       {digest}",
        f"cel:          Drive folder {folder_id} -> {tier}/{stamp}",
        "",
        "SQL TABLAK (allowlist, sorszam a konzisztens pillanatkepbol):",
    ]
    lines += [f"  {t:24} {n:6} sor" for t, n in info["db_row_counts"].items()]
    lines += ["", "SEMA-DDL:",
              f"  megtartva: {len(info['ddl_objects'])} objektum",
              f"  kiszurve:  {len(info['ddl_skipped'])} (FTS5 shadow + sqlite_* belso)",
              f"  fts5:      {', '.join(info['fts_tables']) or '-'}",
              "", "FAJL-KATEGORIAK (futaskori felderites):"]
    for name, s in info["category_stats"].items():
        lines.append(f"  {name:26} {s['files']:5} fajl  {human(s['bytes'])}")
    # The per-category numbers above are pre-dedup: the repo-wide memory sweep
    # deliberately overlaps the named memory categories, so the staged total is
    # lower by design. Spelling it out keeps a future audit from reading the
    # difference as data loss.
    cat_total = sum(s["files"] for s in info["category_stats"].values())
    lines += ["", f"osszesen stagelve: {staged} nyers fajl "
                  f"(kategoria-osszeg {cat_total}, a kulonbseg a kategoriak kozotti "
                  f"atfedes deduplikalasa realpath szerint, nem adatvesztes)"]

    lines += ["", "DENYLIST-KIZARASOK (fajlnev-szint):"]
    lines += ([f"  {e['pattern']:24} {e['path']}" for e in info["denylist_excluded"]]
              or ["  nincs"])

    lines += ["", "SECRET-SCAN:", "  ertek-alaku (hard stop) talalat: 0",
              f"  kulcsszo-emlites (karanten, emberi atnezesre javasolt): {soft_total}"]
    for key, hits in info["quarantine_keyword_hits"].items():
        lines.append(f"    {key}: {sum(h['count'] for h in hits)} elofordulas "
                     f"{len(hits)} fajlban")
        lines += [f"      {h['file']} ({h['count']})" for h in hits[:10]]
        if len(hits) > 10:
            lines.append(f"      ... es meg {len(hits) - 10} fajl")

    if table_drift:
        lines += ["", f"TABLA-DRIFT a baseline ota: {', '.join(table_drift)}"]
    if grown:
        lines += ["", "KATEGORIA NOTT A 0-ROL (baseline frissitendo, --update-baseline):"]
        lines += [f"  {g}" for g in grown]
    lines += ["", "Visszaallitas: tar -xzf <archivum> -C <temp>; repo/* a repo gyokerebe, "
              "home/* a $HOME ala.", "A DB visszaallitasa: db/schema.sql lejatszasa, a "
              "db/<tabla>.json sorok betoltese, majd KOTELEZO:",
              "  INSERT INTO memories_fts(memories_fts) VALUES('rebuild');",
              "  (enelkul a memoria-kereses halott marad -- lasd --rehearsal)"]
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------
# restore rehearsal (plan C3 / D3)
# --------------------------------------------------------------------------

def newest_archive():
    candidates = []
    for tier in ("daily", "weekly"):
        for d in glob.glob(f"{STAGING_ROOT}/{tier}/*/*.tar.gz"):
            candidates.append(d)
    for d in glob.glob(f"{UPLOAD_DIR}/*/*/*.tar.gz"):
        candidates.append(d)
    if not candidates:
        raise BackupError(f"nincs archivum {STAGING_ROOT} alatt a rehearsalhoz")
    return sorted(candidates, key=lambda p: os.path.basename(p))[-1]


def run_rehearsal(archive_path):
    archive_path = archive_path or newest_archive()
    log(f"restore-rehearsal: {archive_path}")
    checks, failures = [], []
    tmp = tempfile.mkdtemp(prefix="marveen-rehearsal-")
    try:
        with tarfile.open(archive_path, "r:gz") as tar:
            tar.extractall(tmp, filter="data")
        checks.append(f"kicsomagolas OK -> {tmp}")

        with open(f"{tmp}/BACKUP-INFO.json", encoding="utf-8") as f:
            info = json.load(f)
        with open(f"{tmp}/db/schema.sql", encoding="utf-8") as f:
            ddl = f.read()

        sandbox = os.path.join(tmp, "sandbox.db")  # never the live claudeclaw.db
        conn = sqlite3.connect(sandbox)
        try:
            conn.executescript(ddl)  # no hand-written fallback -- it must replay as exported
            checks.append(f"DDL lejatszva ({len(info['ddl_objects'])} objektum), "
                          "kezzel-irt sema NELKUL")

            for table, expected in info["db_row_counts"].items():
                with open(f"{tmp}/db/{table}.json", encoding="utf-8") as f:
                    rows = json.load(f)
                if rows:
                    cols = list(rows[0].keys())
                    sql = (f'INSERT INTO "{table}" ({",".join(chr(34) + c + chr(34) for c in cols)}) '
                           f'VALUES ({",".join("?" * len(cols))})')
                    conn.executemany(sql, [[decode_value(r[c]) for c in cols] for r in rows])
                got = conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
                if got != expected:
                    failures.append(f"{table}: {got} sor toltodott be, vart {expected}")
                else:
                    checks.append(f"{table}: {got} sor visszatoltve")
            conn.commit()

            # The step a restore silently skips and the search stays dead.
            conn.execute("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')")
            conn.commit()
            checks.append("memories_fts rebuild lefutott")

            # A real MATCH, not a COUNT(*) on memories: rows being present does
            # not prove the search works (plan C3).
            row = conn.execute(
                "SELECT id, content FROM memories ORDER BY id DESC LIMIT 1").fetchone()
            if not row:
                failures.append("nincs memories sor, a MATCH-proba nem futtathato")
            else:
                mem_id, content = row
                terms = re.findall(r"[A-Za-zÁÉÍÓÖŐÚÜŰáéíóöőúüű0-9]{6,}", content or "")
                if not terms:
                    failures.append(f"a(z) {mem_id} memoriabol nem nyerheto MATCH-token")
                else:
                    term = terms[0]
                    hits = [r[0] for r in conn.execute(
                        "SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?",
                        (f'"{term}"',))]
                    if mem_id in hits:
                        checks.append(f"FTS MATCH '{term}' -> {len(hits)} talalat, "
                                      f"kozte a vart memories.id={mem_id}")
                    else:
                        failures.append(f"FTS MATCH '{term}' nem adta vissza a vart "
                                        f"memories.id={mem_id} sort ({len(hits)} talalat)")

            sample = conn.execute(
                "SELECT COUNT(*) FROM kanban_cards WHERE status='done'").fetchone()[0]
            checks.append(f"szuroproba: kanban_cards status=done -> {sample}")
            sample2 = conn.execute(
                "SELECT COUNT(DISTINCT agent_id) FROM memories").fetchone()[0]
            checks.append(f"szuroproba: memories distinct agent_id -> {sample2}")
        finally:
            conn.close()
    except Exception as e:  # noqa: BLE001 -- any failure is a rehearsal FAIL, reported
        failures.append(f"{type(e).__name__}: {e}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    verdict = "FAIL" if failures else "PASS"
    report = (f"[nightly-memory-backup] restore-rehearsal {verdict}\n"
              f"archivum: {os.path.basename(archive_path)}\n"
              + "\n".join(f"  OK   {c}" for c in checks)
              + ("\n" + "\n".join(f"  FAIL {f}" for f in failures) if failures else ""))
    print(report)
    daily_log(f"## {datetime.now():%H:%M} -- Restore-rehearsal ({verdict})\n{report}")
    if failures:
        alert("restore-rehearsal", report)
        return 1
    return 0


# --------------------------------------------------------------------------
# baseline refresh (explicit, never automatic)
# --------------------------------------------------------------------------

def run_update_baseline():
    log("baseline ujrageneralas a JELENLEGI elo allapotbol (tudatos, kezi lepes)")
    found = discover_all()
    stats = category_stats(found)
    snap = tempfile.mktemp(suffix=".db")
    try:
        snapshot_db(snap)
        conn = sqlite3.connect(f"file:{snap}?mode=ro", uri=True)
        try:
            tables = sorted(r[0] for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"))
            counts = {t: conn.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]
                      for t in EXPORT_TABLES}
        finally:
            conn.close()
    finally:
        for suffix in ("", "-wal", "-shm"):
            if os.path.exists(snap + suffix):
                os.remove(snap + suffix)

    previous = None
    if os.path.exists(BASELINE_FILE):
        with open(BASELINE_FILE) as f:
            previous = json.load(f).get("created_at")
    baseline = {
        "version": 1,
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "created_by": "scripts/nightly-memory-backup.py --update-baseline",
        "previous_created_at": previous,
        "note": ("Kategoriankenti nem-ures assertion bazisvonala (plan C1/D4/23). "
                 "A nightly script SOHA nem irja ezt a fajlt magatol: ha hianyzik, "
                 "leall es riaszt. Csak tudatos, emberi/agent dontessel frissul. "
                 "files>0 baseline mellett a 0 fajl hard stop; bytes>0 mellett a "
                 "0 bajt hard stop; a bytes==0 kategoriak ('0 is OK' placeholderek) "
                 "novekedese figyelmeztetes, ami ezt a fajlt frissitendove teszi."),
        "categories": stats,
        "db_tables": tables,
        "db_row_counts": counts,
    }
    def write():
        with open(BASELINE_FILE, "w", encoding="utf-8") as f:
            json.dump(baseline, f, ensure_ascii=False, indent=2)
            f.write("\n")

    write()
    # The baseline file is itself an include category, so on a first run it was
    # measured as "0 files" before it existed -- which would make every later
    # night report "category grew from 0". Re-measure and rewrite once. Only the
    # zero / non-zero distinction is load-bearing, so the byte count being one
    # rewrite stale is intentional and harmless.
    stats["baseline_state"] = {"files": 1, "bytes": os.path.getsize(BASELINE_FILE)}
    baseline["categories"] = stats
    write()
    log(f"baseline kiirva: {BASELINE_FILE}")
    for name, s in stats.items():
        log(f"  {name:26} {s['files']:5} fajl  {human(s['bytes'])}"
            + ("   [0 bajt -- '0 is OK' placeholder]" if s["bytes"] == 0 else ""))
    return 0


# --------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="Marveen nightly secret-free memory backup")
    ap.add_argument("--dry-run", action="store_true",
                    help="mindent megcsinal, kiveve a Drive-feltoltest es a lokalis prune-t")
    ap.add_argument("--update-baseline", action="store_true",
                    help="bazisvonal ujrageneralasa a jelenlegi allapotbol (tudatos lepes)")
    ap.add_argument("--rehearsal", nargs="?", const="", metavar="ARCHIVE",
                    help="restore-rehearsal a megadott (vagy a legfrissebb) archivumbol")
    args = ap.parse_args()

    try:
        if args.update_baseline:
            return run_update_baseline()
        if args.rehearsal is not None:
            return run_rehearsal(args.rehearsal or None)
        run_nightly(args.dry_run)
        return 0
    except BackupError as e:
        log(f"HIBA: {e}")
        alert("nightly futas", str(e), quiet=args.dry_run)
        return 1
    except Exception:  # noqa: BLE001 -- nothing may die silently at 03:00
        tb = traceback.format_exc()
        log(tb)
        alert("nightly futas (varatlan kivetel)", tb[-1200:], quiet=args.dry_run)
        return 1


if __name__ == "__main__":
    sys.exit(main())
