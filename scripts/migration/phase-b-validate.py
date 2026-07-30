#!/usr/bin/env python3
"""Phase B of the zenom1 mirror-then-swap migration: dark-boot validation.

Full spec + audit trail: agents/neo/migration/mirror-then-swap-PLAN.md (v5,
PASS). Section references below point there. Runs ON WSL, drives zenom1 over
SSH, after every Phase A sync.

The single most important property: booting the zenom1 dashboard must NOT put
a live Telegram bot token on the wire. That is NOT achieved by "we don't start
the channels unit" -- the dashboard process itself respawns every sub-agent's
channel process 30s after boot (channel-monitor.ts:2083 -> reconcileDesiredAgents),
each with its own live token. Two independent layers stop it, and this script
asserts the EFFECTIVE form of both BEFORE anything starts:

  layer 1  WEB_ONLY=true, read from process.env (web.ts:310) -> a systemd
           drop-in works. Asserted via `systemctl show -p Environment`, never
           by looking at the drop-in FILE: systemd serves a cached config until
           `daemon-reload`, so a present file proves nothing (plan D2).
  layer 2  RESPAWN_ENABLED=0 in the HOST-LOCAL .env. config.ts reads config
           only from the .env FILE (env.ts:8-35 readEnvFile, readFileSync);
           process.env is never consulted -- so for THIS key a systemd drop-in
           is worthless and the .env file is the only effective layer (plan B1).

Steps (the numbering follows the plan's Phase B list):
  0  baseline pgrep/tmux snapshot -- only NEW processes count as a violation,
     so the legitimate `claude-auth` session never cries wolf     -- plan B4
  1  pre-assertions on the EFFECTIVE layer (WEB_ONLY, LOG_LEVEL,
     RESPAWN_ENABLED)                                             -- plan M1/N2
  2  pre-boot transfer fidelity: db sha256 == the sync's own
     manifest, integrity_check, strict row counts, store/ file
     inventory, the four sub-agent .env files                     -- plan B7/D3
  3  npm run build
  4  record store/dashboard.log SIZE (the log-read offset)        -- plan M2
  5  start the dashboard
  6  health check FIRST, so the log lines are flushed             -- plan M2
  7  log assertion from the recorded offset -- NOT journalctl: the
     unit uses StandardOutput=append:.../store/dashboard.log, so
     journalctl holds ZERO application lines                      -- plan M2
  8  continuous spawn watch (baseline diff) for the dashboard's
     whole lifetime, not a fixed window                           -- plan B5
  9  post-boot integrity + row counts (boot-mutable tables are
     informational: runDecaySweep runs on every boot)             -- plan D4
 10  agent count + scheduled-task count
 11  credential drift on all five .env files, root narrowed to the
     credential keys; getMe per bot token (collision-safe)        -- plan N1
 12  back to dark; FULL kill chain if a spawn was detected        -- plan B3
 13  daily log on success, Telegram alert on failure

Usage:
  phase-b-validate.py               full validation round
  phase-b-validate.py --setup-dark  (one-off / repair) install the WEB_ONLY
                                    drop-in + daemon-reload and set
                                    RESPAWN_ENABLED=0 / WEB_HOST=0.0.0.0 in the
                                    host-local .env, then re-assert. The normal
                                    run NEVER writes config -- it only asserts,
                                    so the gate stays independent of the thing
                                    it is gating.
  phase-b-validate.py --teardown-only   stop the dashboard + return to dark
  phase-b-validate.py --no-alert    never send Telegram (test runs)

Exit codes: 0 green, 1 red (alerted), 2 refused before touching anything.
"""

import argparse
import hashlib
import json
import os
import re
import shlex
import socket
import subprocess
import sys
import threading
import time
import traceback
import urllib.request
from datetime import datetime

REPO = "/home/szabgabor/marveen"
HOME = "/home/szabgabor"
ZENOM = "szabgabor@192.168.1.131"
SSH_KEY = f"{REPO}/agents/neo/.ssh/zenom1_ed25519"

STATE_DIR = f"{HOME}/.marveen-migration"
MANIFEST = f"{STATE_DIR}/last-sync-manifest.json"
VALIDATE_LOG = f"{STATE_DIR}/phase-b-validate.log"

DROPIN_DIR = f"{HOME}/.config/systemd/user/mr-wolfe-dashboard.service.d"
DROPIN = f"{DROPIN_DIR}/override.conf"
DROPIN_BODY = "[Service]\nEnvironment=WEB_ONLY=true\n"

TELEGRAM_ENV = f"{HOME}/.claude/channels/telegram/.env"
TELEGRAM_CHAT_ID = "8765540529"
DASHBOARD_TOKEN_FILE = f"{REPO}/store/.dashboard-token"
DAILY_LOG_API = "http://localhost:3420/api/daily-log"

SSH_TIMEOUT = 120
BUILD_TIMEOUT = 900
HEALTH_TRIES = 24
HEALTH_SLEEP = 5
WATCH_SECONDS_DEFAULT = 150   # 30s first respawn tick + 15s stagger + margin
WATCH_SAMPLE_S = 10

# web.ts:312 -- the ONE line that only WEB_ONLY mode prints.
WEB_ONLY_MARKER = "[staging] WEB_ONLY mode: background services disabled"
# index.ts:409 -- boot evidence, informational.
BOOT_MARKER = "Adatbazis inicializalva"

# Lines that are printed ONLY when webOnly is false (web.ts:316..382). Any of
# them in the slice means the dark gate did not hold -> critical.
FORBIDDEN_MARKERS = [
    "Agent message router started",              # web.ts:316
    "Schedule runner started",                   # web.ts:319
    "Interactive agent worker pre-started",      # web.ts:327
    "Channel plugin health monitor started",     # web.ts:332
    "Channel MCP health monitor started",        # web.ts:346
    "CostOps fixed-cost sync started",           # web.ts:352
    "Stuck-input watcher started",               # web.ts:355
    "Stuck-tool-call watcher started",           # web.ts:358
    "Reauth healer started",                     # web.ts:361 (conditional)
    "Auto-restart runner started",               # web.ts:364
    "Model-fallback runner started",             # web.ts:367
    "Context-guard runner started",              # web.ts:370
    "Update checker started",                    # web.ts:373
    "Token usage auto-collect started",          # web.ts:382
    # channel-monitor.ts:1440. Under WEB_ONLY, startChannelPluginMonitor is
    # never CALLED (web.ts:331), so this line cannot appear. Its presence would
    # mean webOnly was false and only the RESPAWN_ENABLED=0 second layer saved
    # us -- still a red. An earlier plan revision REQUIRED this line, which
    # would have fired a critical + full kill chain on every single run.
    "Channel plugin monitor disabled (respawn is production-only)",
]

ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")

# The five .env files that carry live credentials (plan D3/N1).
SUBAGENT_ENVS = [f"{REPO}/agents/{a}/.claude/channels/telegram/.env"
                 for a in ("alex", "charlie", "ive", "neo")]
ROOT_ENV = f"{REPO}/.env"
# The root .env is deliberately host-local (WEB_HOST / RESPAWN_ENABLED exist
# only on zenom1), so a full key-set diff would report two expected phantom
# differences on EVERY run. Narrow it to the credential-bearing keys.
ROOT_ENV_CREDENTIAL_KEYS = ["TELEGRAM_BOT_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ALLOWED_CHAT_ID"]

LOG_LEVEL_OK = ("info", "debug", "trace")

# store/ files present in the manifest but absent on zenom1. Below this, treat
# as live-source churn (warning); at or above it, the transfer itself is broken.
STORE_MISSING_HARD = 10


class Red(Exception):
    """Validation failure. Carries `critical` when a live spawn was detected."""

    def __init__(self, message, critical=False):
        super().__init__(message)
        self.critical = critical


def log(msg):
    line = f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {msg}"
    print(line, flush=True)
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        with open(VALIDATE_LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:  # noqa: BLE001
        pass


def env_value(path, key):
    if not os.path.exists(path):
        return None
    with open(path, "r", errors="replace") as f:
        for line in f:
            line = line.strip()
            if line.startswith(f"{key}="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return None


def run(cmd, timeout, check=True, ok_codes=(0,)):
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if check and p.returncode not in ok_codes:
        raise Red(f"parancs hibaval tert vissza (rc={p.returncode}): "
                  f"{' '.join(shlex.quote(c) for c in cmd)[:300]}\n"
                  f"stderr: {p.stderr.strip()[:800]}")
    return p


def ssh(remote_cmd, timeout=SSH_TIMEOUT, check=True, ok_codes=(0,)):
    return run(["ssh", "-i", SSH_KEY, "-o", "BatchMode=yes",
                "-o", "ConnectTimeout=10", ZENOM, remote_cmd],
               timeout=timeout, check=check, ok_codes=ok_codes)


def ssh_python(script, timeout=SSH_TIMEOUT):
    """python3 on zenom1, source over STDIN so secrets never reach argv.

    STDIN carries the PROGRAM (`python3 -`), so no data may be appended after
    it -- anything extra would be parsed as source. Parameters are substituted
    into the script text instead.
    """
    p = subprocess.run(["ssh", "-i", SSH_KEY, "-o", "BatchMode=yes",
                        "-o", "ConnectTimeout=10", ZENOM, "python3 -"],
                       input=script, capture_output=True,
                       text=True, timeout=timeout)
    if p.returncode != 0:
        raise Red(f"tavoli python3 hiba (rc={p.returncode}): {p.stderr.strip()[:800]}")
    return p.stdout


# --------------------------------------------------------------------------
# notification
# --------------------------------------------------------------------------

def telegram_send(text):
    token = env_value(TELEGRAM_ENV, "TELEGRAM_BOT_TOKEN")
    if not token:
        raise Red(f"nincs TELEGRAM_BOT_TOKEN itt: {TELEGRAM_ENV}")
    body = json.dumps({"chat_id": TELEGRAM_CHAT_ID, "text": text[:3900]}).encode()
    req = urllib.request.Request(f"https://api.telegram.org/bot{token}/sendMessage",
                                 data=body, method="POST",
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        payload = json.load(r)
    if not payload.get("ok"):
        raise Red(f"Telegram API elutasitotta: {str(payload)[:200]}")


def alert(stage, message, critical=False, enabled=True):
    """Phase B failures are never left to a pull channel (kanban/daily log):
    the incident this whole plan exists to prevent stayed silent for 3 hours
    exactly because nobody was obliged to read one (plan 4)."""
    head = "KRITIKUS -- ELO SPAWN GYANU" if critical else "HIBA"
    text = (f"[phase-b-validate] {head} -- {stage}\n"
            f"{message}\n"
            f"Host: {socket.gethostname()}  Ido: {datetime.now():%Y-%m-%d %H:%M:%S}")
    if not enabled:
        log("ALERT (nem kuldve, --no-alert):\n" + text)
        return
    try:
        telegram_send(text)
        log("riasztas elkuldve Telegramra")
    except Exception as e:  # noqa: BLE001
        log(f"CRITICAL: az alert sem ment ki ({e}) -- eredeti hiba: {message}")


def daily_log(content):
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
    except Exception as e:  # noqa: BLE001 -- never fails a green run
        log(f"WARN: napi naplo iras nem sikerult ({e})")
        return False


# --------------------------------------------------------------------------
# 0. baseline + continuous spawn watch (plan B4/B5)
# --------------------------------------------------------------------------

SAMPLE_CMD = ('pgrep -a -x claude || true; echo "---TMUX---"; '
              'tmux ls -F "#{session_name}" 2>/dev/null || true')


def sample_state():
    out = ssh(SAMPLE_CMD, timeout=40).stdout
    procs_raw, _, tmux_raw = out.partition("---TMUX---")
    procs = {l.strip() for l in procs_raw.splitlines() if l.strip()}
    sessions = {l.strip() for l in tmux_raw.splitlines() if l.strip()}
    return procs, sessions


class SpawnWatcher(threading.Thread):
    """Samples zenom1 for NEW claude processes / tmux sessions.

    Diff against a baseline, never an absolute "any claude process is a
    violation" rule: the legitimate `claude-auth` session would make that rule
    fire on every single run, and a permanently red check gets allowlisted --
    which is exactly how a real intrusion would end up hidden (plan B4).
    """

    def __init__(self, base_procs, base_sessions):
        super().__init__(daemon=True)
        self.base_procs = base_procs
        self.base_sessions = base_sessions
        self.violations = []
        self.sample_errors = 0
        self.samples = 0
        self._stop = threading.Event()

    def run(self):
        while not self._stop.is_set():
            try:
                procs, sessions = sample_state()
                self.samples += 1
                new_p = procs - self.base_procs
                new_s = sessions - self.base_sessions
                if new_p or new_s:
                    v = {"at": datetime.now().isoformat(timespec="seconds"),
                         "new_procs": sorted(new_p), "new_sessions": sorted(new_s)}
                    self.violations.append(v)
                    log(f"  !! SPAWN ESZLELVE: {v}")
            except Exception as e:  # noqa: BLE001 -- a flaky sample must not abort the watch
                self.sample_errors += 1
                log(f"  (spawn-minta hiba: {str(e)[:160]})")
            self._stop.wait(WATCH_SAMPLE_S)

    def stop(self):
        self._stop.set()


# --------------------------------------------------------------------------
# 1. effective-layer pre-assertions (plan M1/N2/D2/B1)
# --------------------------------------------------------------------------

def systemd_environment():
    """`systemctl show -p Environment` = the EFFECTIVE, loaded config.

    Checking the drop-in FILE instead would be the exact D2 mistake: systemd
    keeps serving its cached configuration until daemon-reload, so a correct
    file with a stale cache boots the dashboard fully live while a file check
    shows green.
    """
    out = ssh("systemctl --user show mr-wolfe-dashboard.service -p Environment",
              timeout=40).stdout.strip()
    _, _, raw = out.partition("=")
    env = {}
    for token in shlex.split(raw):
        if "=" in token:
            k, _, v = token.partition("=")
            env[k] = v
    return env, out


def pre_assertions():
    env, raw = systemd_environment()
    problems = []
    if env.get("WEB_ONLY") != "true":
        problems.append(
            "WEB_ONLY!=true az EFFEKTIV systemd kornyezetben "
            f"(latott: {env.get('WEB_ONLY')!r}). A dashboard ELO tokenekkel bootolna: "
            "30 mp mulva reconcileDesiredAgents mind a 4 sub-agent csatornajat elinditja. "
            "Javitas: phase-b-validate.py --setup-dark (drop-in + daemon-reload).")
    lvl = env.get("LOG_LEVEL")
    if lvl is not None and lvl.lower() not in LOG_LEVEL_OK:
        problems.append(
            f"LOG_LEVEL={lvl!r} -- a 7. lepes info-szintu sorokat vizsgal, egy 'warn' "
            "csendben eltuntetne oket es hamis pirosat adna (plan N2).")

    respawn = ssh(f"grep -E '^RESPAWN_ENABLED=' {shlex.quote(REPO)}/.env || true",
                  timeout=40).stdout.strip()
    if respawn.split("=", 1)[-1].strip().strip('"').strip("'") != "0":
        problems.append(
            f"RESPAWN_ENABLED nem 0 a host-lokalis .env-ben (latott sor: {respawn!r}). "
            "config.ts KIZAROLAG a .env FAJLBOL olvas (env.ts:8-35), systemd drop-in "
            "erre a kulcsra hatastalan. Javitas: --setup-dark.")

    # Secondary, informational only -- the effective layer above is the gate.
    dropin_present = ssh(f"test -f {shlex.quote(DROPIN)} && echo yes || echo no",
                         timeout=40).stdout.strip()
    log(f"1. elozetes assertion -- systemd Environment: {raw[:200]}")
    log(f"   drop-in fajl jelen: {dropin_present} (masodlagos jel, NEM a kapu)")
    if problems:
        raise Red("ELOZETES ASSERTION BUKOTT, a dashboard EL SEM INDULT:\n- "
                  + "\n- ".join(problems))
    log("   WEB_ONLY=true, LOG_LEVEL ok, RESPAWN_ENABLED=0 -- sotet-boot engedelyezve")


def setup_dark():
    """Explicit, idempotent installation/repair of the dark posture.

    Deliberately NOT part of the normal validation run and NOT part of
    mirror-sync (the plan forbids the mirror from touching any .env): a gate
    that repairs what it checks proves nothing.
    """
    script = r"""
import os, subprocess, sys
HOME = os.path.expanduser("~")
REPO = "/home/szabgabor/marveen"
DROPIN_DIR = f"{HOME}/.config/systemd/user/mr-wolfe-dashboard.service.d"
DROPIN = f"{DROPIN_DIR}/override.conf"
BODY = "[Service]\nEnvironment=WEB_ONLY=true\n"
changed = []

os.makedirs(DROPIN_DIR, exist_ok=True)
old = None
if os.path.exists(DROPIN):
    with open(DROPIN) as f:
        old = f.read()
if old != BODY:
    with open(DROPIN, "w") as f:
        f.write(BODY)
    changed.append("drop-in irva")

# daemon-reload runs UNCONDITIONALLY: the file may already be correct while the
# loaded configuration is stale (that is precisely the D2 failure mode).
subprocess.run(["systemctl", "--user", "daemon-reload"], check=True, timeout=60)
changed.append("daemon-reload")

envp = f"{REPO}/.env"
with open(envp) as f:
    lines = f.read().splitlines()
def upsert(key, value):
    global lines
    hit = False
    for i, l in enumerate(lines):
        if l.strip().startswith(key + "="):
            if l.strip() != f"{key}={value}":
                lines[i] = f"{key}={value}"
                changed.append(f"{key} atallitva")
            hit = True
    if not hit:
        lines.append(f"{key}={value}")
        changed.append(f"{key} hozzaadva")
upsert("RESPAWN_ENABLED", "0")
upsert("WEB_HOST", "0.0.0.0")
with open(envp, "w") as f:
    f.write("\n".join(lines).rstrip("\n") + "\n")
os.chmod(envp, 0o600)
print("VALTOZAS: " + (", ".join(changed) if changed else "nincs"))
"""
    out = ssh_python(script, timeout=120)
    log(f"--setup-dark: {out.strip()}")
    pre_assertions()
    log("--setup-dark KESZ, az effektiv reteg zold")


# --------------------------------------------------------------------------
# 2. pre-boot transfer fidelity (plan B7/D3/6)
# --------------------------------------------------------------------------

# __MODE__ is substituted with "preboot" or "postboot".
#
# preboot opens the DB with `immutable=1`: the file is static (zenom1 is dark),
# and immutable mode reads WITHOUT creating -wal/-shm and WITHOUT touching a
# byte of the .db (measured 2026-07-25). A plain `mode=ro` connection on a
# WAL-mode database DOES create both sidecars and cannot remove them on close,
# so the fidelity check would itself manufacture the inconsistent db+wal+shm
# triple it exists to rule out -- and it would invalidate the sha256 on the
# next run. immutable also proves the point being asserted: the .db alone is
# complete, because any WAL content would be ignored.
#
# postboot uses mode=ro: the dashboard holds the DB, the WAL is live and its
# contents MUST be read, and sidecars are expected to exist.
DB_INSPECT_SCRIPT = r"""
import hashlib, json, os, re, sqlite3
MODE = "__MODE__"
REPO = "/home/szabgabor/marveen"
DB = f"{REPO}/store/claudeclaw.db"
out = {"mode_used": MODE,
       "wal": os.path.exists(DB + "-wal"), "shm": os.path.exists(DB + "-shm")}
h = hashlib.sha256()
with open(DB, "rb") as f:
    for chunk in iter(lambda: f.read(1024 * 1024), b""):
        h.update(chunk)
out["sha256"] = h.hexdigest()
out["bytes"] = os.path.getsize(DB)
out["perm"] = oct(os.stat(DB).st_mode & 0o777)
uri = f"file:{DB}?immutable=1" if MODE == "preboot" else f"file:{DB}?mode=ro"
conn = sqlite3.connect(uri, uri=True)
try:
    out["integrity"] = conn.execute("PRAGMA integrity_check").fetchone()[0]
    rows = conn.execute("SELECT type, name, sql FROM sqlite_master").fetchall()
    # Same derivation as mirror-sync.row_counts: FTS5 shadow tables are
    # internal, derived storage. Counting them here while the manifest side
    # skips them reports four phantom "extra tables" on every run.
    fts = {n for t, n, s in rows
           if t == "table" and s and re.match(r"\s*CREATE\s+VIRTUAL\s+TABLE", s, re.I)
           and "fts5" in s.lower()}
    shadow = tuple(f"{n}_" for n in fts)
    counts = {}
    for (t,) in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' "
            "AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name"):
        if t not in fts and t.startswith(shadow):
            continue
        try:
            counts[t] = conn.execute('SELECT COUNT(*) FROM "%s"' % t).fetchone()[0]
        except sqlite3.Error as e:
            counts[t] = "ERR:" + str(e)
    out["counts"] = counts
    out["fts_tables"] = sorted(fts)
finally:
    conn.close()
out["wal_after"] = os.path.exists(DB + "-wal")
out["shm_after"] = os.path.exists(DB + "-shm")
store = []
for dirpath, dirnames, filenames in os.walk(f"{REPO}/store"):
    dirnames[:] = sorted(dirnames)
    for n in sorted(filenames):
        store.append(os.path.relpath(os.path.join(dirpath, n), f"{REPO}/store"))
out["store_files"] = store
out["subagent_envs"] = {
    a: os.path.exists(f"{REPO}/agents/{a}/.claude/channels/telegram/.env")
    for a in ("alex", "charlie", "ive", "neo")}
print(json.dumps(out))
"""


def compare_counts(remote, manifest_counts, exempt=()):
    diffs = []
    for t, expected in sorted(manifest_counts.items()):
        got = remote.get(t)
        if t in exempt:
            if got != expected:
                log(f"   (info) {t}: manifest={expected} zenom1={got} -- boot-mutable, nem piros")
            continue
        if got is None:
            diffs.append(f"{t}: hianyzik a zenom1 DB-bol (manifest: {expected})")
        elif got != expected:
            diffs.append(f"{t}: manifest={expected} zenom1={got}")
    extra = sorted(set(remote) - set(manifest_counts))
    if extra:
        diffs.append(f"csak zenom1-en levo tabla(k): {extra}")
    return diffs


def inspect_db(mode):
    return json.loads(ssh_python(DB_INSPECT_SCRIPT.replace("__MODE__", mode), timeout=300))


def preboot_checks(manifest):
    log("2. boot ELOTTI atviteli hitelesseg (a szinkron SAJAT manifestje ellen)")
    data = inspect_db("preboot")
    problems = []
    if data["wal"] or data["shm"]:
        problems.append(
            "stale -wal/-shm a zenom1 store/-ban MAR A BOOT ELOTT -- inkonzisztens "
            "db+wal+shm harmas (plan D7). Tipikus ok: ez a validacio egy KORABBI "
            "sotet-boot utan fut, ujabb szinkron NELKUL. A validacio szinkron-parban "
            "ertelmezett: futtass eloszor mirror-sync.py-t (az torli a stale "
            "sidecar-okat, mielott a friss pillanatkepet lerakja).")
    if data["sha256"] != manifest["db_sha256"]:
        problems.append(
            f"a zenom1 DB sha256-ja nem a manifest pillanatkepe "
            f"(zenom1={data['sha256'][:16]}... manifest={manifest['db_sha256'][:16]}...). "
            "Leggyakoribb ok: egy KORABBI sotet-boot mar irt ebbe a DB-be (a "
            "validacio szinkron-parban ertelmezett, nem ismetelheto ujabb szinkron "
            "nelkul). Egyeb ok: kozben ujabb szinkron futott, vagy a masolas serult. "
            "Teendo: futtass mirror-sync.py-t, majd ujra ezt.")
    if data["integrity"] != "ok":
        problems.append(f"PRAGMA integrity_check = {str(data['integrity'])[:200]}")
    if data["perm"] != "0o600":
        problems.append(f"a zenom1 DB jogosultsaga {data['perm']}, vart 0o600")
    diffs = compare_counts(data["counts"], manifest["db_row_counts"])
    if diffs:
        problems.append("sorszam-elteresek (boot ELOTT, versenyhelyzet nelkul):\n  "
                        + "\n  ".join(diffs[:20]))

    # B7: the store/ leg must deliver the whole directory, not just the DB.
    # The WSL source is LIVE, so a handful of store/ files legitimately appear
    # or vanish between the rsync and this check (agent-taskstate flags, for
    # one). Treating any difference as red would paint the check permanently
    # red on a 15-minute timer, and a permanently red check gets ignored. So:
    # the credential-bearing files are absolute, a large shortfall means the
    # transfer really is broken, and a small delta is live churn -> warning.
    missing = sorted(set(manifest["store_files"]) - set(data["store_files"]))
    for key in (".vault-key", "vault.json", ".dashboard-token", ".claude-oauth-token",
                "agents-desired.json"):
        if key not in data["store_files"]:
            problems.append(f"KRITIKUS store/ fajl hianyzik: {key}")
    if len(missing) > STORE_MISSING_HARD:
        problems.append(f"a store/-bol {len(missing)} fajl hianyzik zenom1-en (kuszob "
                        f"{STORE_MISSING_HARD}) -- ez mar nem elo-churn, pl.: {missing[:12]}")
    elif missing:
        log(f"   (info) {len(missing)} store/ fajl elteres elo forras miatt: {missing[:6]}")

    # D3 live proof: the anchored /.env exclusion must leave the four sub-agent
    # bot-token files in the transfer.
    absent = [a for a, ok in data["subagent_envs"].items() if not ok]
    if absent:
        problems.append(f"sub-agent .env hianyzik zenom1-en: {absent} -- a /.env "
                        "lehorgonyzas nem mukodik (plan D3)")
    # Only a sidecar the inspection INTRODUCED is a regression. Pre-existing
    # ones are already reported above; conflating the two blamed immutable mode
    # for files it had not created.
    introduced = [s for s in ("wal", "shm") if data[f"{s}_after"] and not data[s]]
    if introduced:
        problems.append(f"az ellenorzes MAGA hozott letre -{'/-'.join(introduced)} fajlt "
                        "a DB mellett -- immutable modban ez nem tortenhet, a nyitasi "
                        "mod regresszalt")
    if problems:
        raise Red("BOOT ELOTTI ELLENORZES BUKOTT:\n- " + "\n- ".join(problems))
    log(f"   db sha256 egyezik, integrity ok, {len(data['counts'])} tabla sorszama egyezik, "
        f"store/ {len(data['store_files'])} fajl, 4/4 sub-agent .env jelen")
    return data


# --------------------------------------------------------------------------
# 10. agent + scheduled-task inventory
# --------------------------------------------------------------------------

AGENT_COUNT_SCRIPT = r"""
import json, os, urllib.request
REPO = "/home/szabgabor/marveen"
out = {"agents": -1, "tasks": -1, "error": None}
try:
    out["tasks"] = len(os.listdir(os.path.expanduser("~/.claude/scheduled-tasks")))
    with open(f"{REPO}/store/.dashboard-token") as f:
        tok = f.read().strip()
    req = urllib.request.Request("http://localhost:3420/api/agents",
                                 headers={"Authorization": "Bearer " + tok})
    with urllib.request.urlopen(req, timeout=20) as r:
        out["agents"] = len(json.load(r))
except Exception as e:
    out["error"] = str(e)[:300]
print(json.dumps(out))
"""


def local_agent_count():
    """WSL-side /api/agents count -- a plain read-only GET on localhost."""
    try:
        with open(DASHBOARD_TOKEN_FILE) as f:
            tok = f.read().strip()
        req = urllib.request.Request("http://localhost:3420/api/agents",
                                     headers={"Authorization": f"Bearer {tok}"})
        with urllib.request.urlopen(req, timeout=20) as r:
            return len(json.load(r))
    except Exception as e:  # noqa: BLE001 -- absence of a WSL reference is not a zenom1 fault
        log(f"   WARN: a WSL oldali /api/agents nem elerheto ({str(e)[:120]}), "
            "az agent-szam osszevetes kimarad")
        return -1


# --------------------------------------------------------------------------
# 11. credential drift (plan C1/D3/N1)
# --------------------------------------------------------------------------

REMOTE_CRED_SCRIPT = r"""
import hashlib, json, os, urllib.request
salt = "__SALT__"
REPO = "/home/szabgabor/marveen"
def read_env(path):
    d = {}
    if not os.path.exists(path):
        return None
    with open(path, errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            d[k.strip()] = v.strip().strip('"').strip("'")
    return d
def hashes(d):
    # Salted per run: ALLOWED_CHAT_ID is low-entropy and a bare sha256 of it
    # would be trivially brute-forceable. Values themselves never leave.
    return {k: hashlib.sha256((salt + v).encode()).hexdigest()[:16] for k, v in d.items()}
out = {"files": {}, "getme": {}}
paths = {"root": f"{REPO}/.env"}
for a in ("alex", "charlie", "ive", "neo"):
    paths[a] = f"{REPO}/agents/{a}/.claude/channels/telegram/.env"
for name, p in paths.items():
    d = read_env(p)
    out["files"][name] = None if d is None else {"keys": sorted(d), "hashes": hashes(d)}
    tok = (d or {}).get("TELEGRAM_BOT_TOKEN")
    if not tok:
        out["getme"][name] = "nincs TELEGRAM_BOT_TOKEN"
        continue
    try:
        # getMe / sendMessage do NOT contend for the getUpdates poller slot
        # (web.ts:385-397); this is the collision-safe probe.
        req = urllib.request.Request("https://api.telegram.org/bot%s/getMe" % tok)
        with urllib.request.urlopen(req, timeout=20) as r:
            j = json.load(r)
        out["getme"][name] = ("ok:@" + j["result"]["username"]) if j.get("ok") else "nem-ok"
    except Exception as e:
        out["getme"][name] = "HIBA: " + str(e)[:120]
print(json.dumps(out))
"""


def local_env_map(path):
    if not os.path.exists(path):
        return None
    d = {}
    with open(path, errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            d[k.strip()] = v.strip().strip('"').strip("'")
    return d


def credential_drift():
    log("11. hitelesito-drift (5 .env, gyoker szukitve; getMe minden bot-tokenre)")
    # Fresh salt per run: ALLOWED_CHAT_ID is low-entropy, so an unsalted digest
    # of it would be brute-forceable. Only hashes are ever compared or logged.
    salt = os.urandom(16).hex()
    remote = json.loads(ssh_python(REMOTE_CRED_SCRIPT.replace("__SALT__", salt), timeout=180))
    local_paths = {"root": ROOT_ENV}
    for a in ("alex", "charlie", "ive", "neo"):
        local_paths[a] = f"{REPO}/agents/{a}/.claude/channels/telegram/.env"

    problems, notes = [], []
    for name, path in local_paths.items():
        loc = local_env_map(path)
        rem = remote["files"].get(name)
        if loc is None:
            problems.append(f"{name}: a WSL oldali .env hianyzik ({path})")
            continue
        if rem is None:
            problems.append(f"{name}: a zenom1 oldali .env hianyzik")
            continue
        if name == "root":
            keys = ROOT_ENV_CREDENTIAL_KEYS
            lk = {k for k in keys if k in loc}
            rk = {k for k in keys if k in rem["keys"]}
        else:
            keys = sorted(set(loc) | set(rem["keys"]))
            lk, rk = set(loc), set(rem["keys"])
        if lk != rk:
            problems.append(f"{name}: kulcs-halmaz elteres csak-WSL={sorted(lk - rk)} "
                            f"csak-zenom1={sorted(rk - lk)}")
        for k in sorted(lk & rk):
            lh = hashlib.sha256((salt + loc[k]).encode()).hexdigest()[:16]
            if lh != rem["hashes"].get(k):
                problems.append(f"{name}: '{k}' ERTEK-elteres (hash diff, ertek nem naplozva)")
        notes.append(f"{name}: {len(lk & rk)} kulcs osszevetve, getMe={remote['getme'].get(name)}")
    bad_getme = [f"{n}: {v}" for n, v in remote["getme"].items() if not str(v).startswith("ok:")]
    if bad_getme:
        problems.append("getMe sikertelen: " + "; ".join(bad_getme))
    for n in notes:
        log("   " + n)
    if problems:
        raise Red("HITELESITO-DRIFT:\n- " + "\n- ".join(problems))


# --------------------------------------------------------------------------
# 12. teardown (plan B3)
# --------------------------------------------------------------------------

WAL_CHECKPOINT_SCRIPT = r"""
import os, sqlite3
DB = "/home/szabgabor/marveen/store/claudeclaw.db"
if not (os.path.exists(DB + "-wal") or os.path.exists(DB + "-shm")):
    print("sidecar: nincs")
else:
    try:
        c = sqlite3.connect(DB)
        c.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        c.close()
        left = [s for s in ("-wal", "-shm") if os.path.exists(DB + s)]
        print("sidecar: checkpointelve, maradt=%s" % (left or "nincs"))
    except Exception as e:
        print("sidecar: checkpoint HIBA %s" % str(e)[:120])
"""

def teardown(base_sessions, full_kill):
    """Back to dark.

    KillMode=process (mr-wolfe-dashboard.service:13) means `systemctl stop`
    kills the node process ONLY -- any sub-agent tmux session the dashboard
    already started keeps running with a live bot poller. On a critical finding
    the remediation is therefore the FULL chain, the cutover.sh:27-30 pattern,
    followed by re-verification. A bare `systemctl stop` would be a half-done
    remediation.
    """
    if full_kill:
        log("12. KRITIKUS remediacio: TELJES kill-lanc")
        ssh("systemctl --user stop mr-wolfe-dashboard.service mr-wolfe-channels.service "
            "2>/dev/null; tmux kill-server 2>/dev/null; pkill -x claude 2>/dev/null; true",
            timeout=120, check=False)
        time.sleep(5)
        procs, sessions = sample_state()
        if procs or sessions:
            log(f"   !! a kill-lanc UTAN is maradt: procs={sorted(procs)} tmux={sorted(sessions)}")
            return False
        log("   ujra-verifikacio: zenom1 sotet (0 claude, 0 tmux session)")
        return True

    log("12. vissza sotetbe (dashboard stop + csak az UJ tmux sessionok)")
    ssh("systemctl --user stop mr-wolfe-dashboard.service 2>/dev/null; true",
        timeout=120, check=False)
    time.sleep(3)
    _, sessions = sample_state()
    new = sorted(sessions - base_sessions)
    for s in new:
        ssh(f"tmux kill-session -t {shlex.quote(s)} 2>/dev/null; true", timeout=60, check=False)
    if new:
        log(f"   uj tmux session(ok) lelove: {new}")
    procs, sessions = sample_state()
    # Fold the dark boot's WAL back into the .db and drop the sidecars, so the
    # standby is a single consistent file (plan D7) instead of a triple that
    # looks like the "stale sidecar" fault to the next inspection. A checkpoint
    # is the safe way to do this -- deleting a -wal that holds committed frames
    # would discard them.
    ck = ssh_python(WAL_CHECKPOINT_SCRIPT, timeout=120)
    log(f"   allapot: claude-procs={len(procs)} tmux={sorted(sessions)}; {ck.strip()}")
    return True


# --------------------------------------------------------------------------
# main validation
# --------------------------------------------------------------------------

def validate(args):
    if not os.path.exists(MANIFEST):
        raise Red(f"nincs szinkron-manifest ({MANIFEST}) -- futtasd eloszor a "
                  "mirror-sync.py-t. A validacio SOHA nem talalgat elvart sorszamokat.")
    with open(MANIFEST) as f:
        manifest = json.load(f)
    log("=" * 72)
    log(f"phase-b-validate indul (manifest: {manifest['created_at']}, "
        f"db {manifest['db_sha256'][:12]}...)")

    # 0. baseline
    base_procs, base_sessions = sample_state()
    log(f"0. bazisvonal: claude-procs={sorted(base_procs) or '[]'} "
        f"tmux={sorted(base_sessions) or '[]'}")

    # 1. effective-layer gate -- nothing has been started yet at this point
    pre_assertions()

    # 2. transfer fidelity BEFORE the boot can mutate anything
    preboot_checks(manifest)

    # 3. build
    log("3. npm run build zenom1-en")
    p = ssh(f"cd {shlex.quote(REPO)} && npm run build 2>&1 | tail -20",
            timeout=BUILD_TIMEOUT, check=False)
    if p.returncode != 0:
        raise Red(f"npm run build bukott (rc={p.returncode}):\n{p.stdout.strip()[-1500:]}")
    log("   build ok")

    watcher = SpawnWatcher(base_procs, base_sessions)
    started_dashboard = False
    # A critical finding (dark gate breached) must reach the teardown even when
    # it is raised from the log assertion and the watcher itself saw nothing --
    # otherwise the remediation would be a bare `systemctl stop`, which under
    # KillMode=process leaves any spawned agent running with a live poller.
    critical_seen = {"flag": False}
    try:
        # 4. log offset IMMEDIATELY before start
        off = ssh(f"wc -c < {shlex.quote(REPO)}/store/dashboard.log 2>/dev/null || echo 0",
                  timeout=40).stdout.strip()
        offset = int(off or 0)
        log(f"4. log-offszet rogzitve: {offset} bajt (store/dashboard.log)")

        # 5. start
        watcher.start()
        log("5. dashboard inditasa (WEB_ONLY sotet mod)")
        ssh("systemctl --user start mr-wolfe-dashboard.service", timeout=120)
        started_dashboard = True

        # 6. health check FIRST (M2: guarantees the log lines are flushed)
        log("6. egeszseg-ellenorzes")
        healthy = False
        for _ in range(HEALTH_TRIES):
            hp = ssh("curl -sf -o /dev/null http://localhost:3420/ && echo up || echo down",
                     timeout=40, check=False)
            if "up" in hp.stdout:
                healthy = True
                break
            time.sleep(HEALTH_SLEEP)
        if not healthy:
            st = ssh("systemctl --user status mr-wolfe-dashboard.service --no-pager | tail -20",
                     timeout=60, check=False).stdout
            raise Red(f"a dashboard nem valaszol a 3420-on:\n{st[-1200:]}")
        log("   dashboard el (HTTP 2xx a gyokeren)")

        # 7. log assertion from the recorded offset. NOT journalctl: the unit
        # writes StandardOutput=append:.../store/dashboard.log, so the journal
        # holds zero application lines and a --since query would return an
        # empty slice on every run (plan M2).
        slice_txt = ssh(
            f"tail -c +{offset + 1} {shlex.quote(REPO)}/store/dashboard.log | head -c 400000",
            timeout=120).stdout
        clean = ANSI.sub("", slice_txt)
        log(f"7. log-szelet {len(clean)} karakter az offszettol")
        problems = []
        if WEB_ONLY_MARKER not in clean:
            problems.append(f"HIANYZIK a WEB_ONLY jelzosor: {WEB_ONLY_MARKER!r} "
                            "-- vagy nem indult el a boot, vagy NEM WEB_ONLY modban indult")
        found_forbidden = [m for m in FORBIDDEN_MARKERS if m in clean]
        if found_forbidden:
            problems.append("NEM-WEB_ONLY sor(ok) megjelentek: " + "; ".join(found_forbidden))
        log(f"   WEB_ONLY jelzosor: {'megvan' if WEB_ONLY_MARKER in clean else 'HIANYZIK'}; "
            f"boot-jelzo: {'megvan' if BOOT_MARKER in clean else 'nincs'}; "
            f"tiltott sorok: {found_forbidden or 'nincs'}")
        if problems:
            raise Red("LOG-ALAPU SOTET-ELLENORZES BUKOTT:\n- " + "\n- ".join(problems),
                      critical=True)

        # 8. continuous watch across the respawn window (first tick 30s,
        #    stagger 15s, plus margin for a grace-delayed spawn)
        log(f"8. folyamatos spawn-figyeles {args.watch_seconds}s "
            f"({WATCH_SAMPLE_S}s mintavetel)")
        deadline = time.time() + args.watch_seconds
        while time.time() < deadline:
            if watcher.violations:
                break
            time.sleep(2)
        if watcher.violations:
            raise Red("UJ claude processz / tmux session jelent meg a sotet boot alatt:\n"
                      + json.dumps(watcher.violations, ensure_ascii=False)[:1500],
                      critical=True)
        log(f"   {watcher.samples} minta, 0 uj processz/session "
            f"({watcher.sample_errors} mintavetel-hiba)")

        # 9. post-boot DB state
        log("9. boot UTANI DB allapot")
        post = inspect_db("postboot")
        if post["integrity"] != "ok":
            raise Red(f"boot utani integrity_check = {str(post['integrity'])[:200]}")
        exempt = set(manifest.get("db_boot_mutable_tables", []))
        diffs = compare_counts(post["counts"], manifest["db_row_counts"], exempt=exempt)
        if diffs:
            raise Red("boot utani sorszam-elteres a boot-mutable tablakon KIVUL:\n  "
                      + "\n  ".join(diffs[:20]))
        log("   integrity ok, sorszamok stabilak (boot-mutable tablak informaciosak)")

        # 10. agent + scheduled-task counts. Compared against the LIVE WSL side
        #     rather than a hardcoded number: /api/agents lists the four
        #     sub-agents (mr-wolfe is the main agent and not in that list), so
        #     "expect 5" would be wrong -- verified live 2026-07-25.
        log("10. agent-szam es scheduled-task szam")
        z = json.loads(ssh_python(AGENT_COUNT_SCRIPT, timeout=90))
        if z.get("error"):
            raise Red(f"a zenom1 /api/agents lekerdezes hibazott: {z['error']}")
        z_agents, z_tasks = z["agents"], z["tasks"]
        w_agents = local_agent_count()
        w_tasks = len(os.listdir(f"{HOME}/.claude/scheduled-tasks"))
        log(f"   agentek: zenom1={z_agents} WSL={w_agents}; "
            f"scheduled-taskok: zenom1={z_tasks} WSL={w_tasks}")
        if w_agents >= 0 and z_agents != w_agents:
            raise Red(f"agent-szam elteres: zenom1={z_agents} WSL={w_agents}")
        if z_tasks != w_tasks:
            raise Red(f"scheduled-task szam elteres: zenom1={z_tasks} WSL={w_tasks}")

        # 11. credential drift
        credential_drift()

    except Red as e:
        critical_seen["flag"] = e.critical
        raise
    finally:
        watcher.stop()
        crit = critical_seen["flag"] or bool(watcher.violations)
        if started_dashboard or crit:
            try:
                teardown(base_sessions, full_kill=crit)
            except Exception as e:  # noqa: BLE001 -- teardown failure must be visible
                log(f"TEARDOWN HIBA: {e}")
                alert("teardown", f"a zenom1 visszasotetitese nem sikerult: {e}",
                      critical=True, enabled=not args.no_alert)

    log("phase-b-validate ZOLD")
    daily_log(f"## {datetime.now():%H:%M} -- Phase B dark-boot validacio (zenom1)\n"
              f"Zold. Manifest {manifest['created_at']}, db {manifest['db_sha256'][:12]}, "
              f"{len(manifest['db_row_counts'])} tabla sorszam egyezik, WEB_ONLY sotet boot "
              f"igazolva, 0 uj processz/tmux session.")
    return 0


def main():
    ap = argparse.ArgumentParser(description="zenom1 mirror-then-swap, B fazis (sotet-boot validacio)")
    ap.add_argument("--setup-dark", action="store_true",
                    help="egyszeri/javito lepes: WEB_ONLY drop-in + daemon-reload + "
                         "RESPAWN_ENABLED=0/WEB_HOST a host-lokalis .env-ben")
    ap.add_argument("--teardown-only", action="store_true",
                    help="csak allitsa le a dashboardot es terjen vissza sotetbe")
    ap.add_argument("--watch-seconds", type=int, default=WATCH_SECONDS_DEFAULT)
    ap.add_argument("--no-alert", action="store_true")
    args = ap.parse_args()
    try:
        if args.setup_dark:
            setup_dark()
            return 0
        if args.teardown_only:
            # No baseline exists in this mode, so fall back to rehearsal.sh:39's
            # explicit exception: everything except the legitimate claude-auth
            # session is treated as dashboard-spawned.
            teardown({"claude-auth"}, full_kill=False)
            return 0
        return validate(args)
    except Red as e:
        log(f"PIROS: {e}")
        alert("phase-b", str(e), critical=e.critical, enabled=not args.no_alert)
        return 1
    except subprocess.TimeoutExpired as e:
        msg = f"idotullepes: {str(e)[:400]}"
        log(f"PIROS: {msg}")
        alert("phase-b-timeout", msg, enabled=not args.no_alert)
        return 1
    except Exception as e:  # noqa: BLE001
        msg = f"varatlan kivetel: {e}\n{traceback.format_exc()[-1200:]}"
        log(f"PIROS: {msg}")
        alert("phase-b-unexpected", msg, enabled=not args.no_alert)
        return 1


if __name__ == "__main__":
    sys.exit(main())
