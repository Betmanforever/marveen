#!/usr/bin/env python3
"""Weekly OFFLINE backup leg: the newest nightly set onto the physically held E: drive.

Spec + acceptance criteria: projects/_audit/2026-07-31-backup-risk-audit.md
section 6(b) (AC-B1..AC-B8) and section (d) (AC-D1..AC-D4). The audit's finding
this answers: everything that survives the loss of this WSL host today lives in
ONE Google account, and that copy has never been read back. A drive Gabor holds
in his hand is the only control that also covers silent corruption or deletion
at the cloud destination.

Scope of THIS script -- Tier 1 only:
  a verbatim copy of the newest complete nightly set (tar.gz + MANIFEST.txt +
  SHA256SUMS), which is already secret-scrubbed, so putting it on portable media
  creates no new exposure class (audit 4.1).

  Tier 2 (the secret-BEARING set: full claudeclaw.db, vault, .env, channel
  tokens, SSH key) is GATED on Gabor's decision about off-host key custody
  (audit 9.1) and is deliberately NOT implemented here. When it lands it plugs
  in as a third payload directory next to weekly/ and monthly/ (e.g.
  DEST_ROOT/secrets/<stamp>/*.age) and reuses place_set()/sha256_readback()
  unchanged. Note that this script has no Drive code path at all, so AC-B3's
  "Tier 2 must never reach Drive" holds structurally, not by intention.

What it does, in order:
  1. presence gate: marker file WITH a matching UUID, then a real write probe
     (AC-B2 -- the one that must not be softened)                -- audit 6(b)
  2. newest COMPLETE nightly set, source digest checked against
     its own SHA256SUMS before anything is copied
  3. free-space pre-check, then copy with an fsync'd destination handle
  4. os.sync(), then sha256 by READING THE BYTES BACK from the drive and
     comparing to BOTH the source digest and the recorded one   -- AC-B5
  5. per-week verify manifest written on the drive next to the payload
  6. first successful run of a calendar month also lands in monthly/
  7. on that monthly run: nightly-memory-backup.py --rehearsal against the
     archive ON THE DRIVE                                        -- AC-B7
  8. retention: 8 weekly + 6 monthly, stamp-shaped names only, and never
     without seeing this run's own folder in the listing         -- AC-B6
  9. state file + alerting: transitions only, to mr-wolfe over /api/messages;
     a good week writes the daily log and sends nothing          -- AC-D1..D4

Alerting rules (AC-D3/D4), stated once so the code below can be read against them:
  drive absent      -> counter++, exit 0, ONE coordinator alert at 3 in a row
  verify mismatch   -> alert immediately, every occurrence, non-zero, NO prune
  other failure     -> alert on entering the state, not every week
  recovery          -> one RED->GREEN notice, only if we had actually alerted
  success           -> daily log only, silence
No direct api.telegram.org call anywhere in this file (AC-B8): every send is an
inter-agent message to the coordinator, exactly like scripts/site-monitor.py.

Usage:
  weekly-elocal-backup.py            full run (copy + verify + prune)
  weekly-elocal-backup.py --dry-run  everything except writing to the drive,
                                     pruning, alerting and state/daily-log writes

Install (operator step, NOT done by this script -- see AC-B2 rationale):
  mkdir -p /mnt/e/MarveenBackup
  printf '48a828f3-305c-4117-bf93-a3ebb59ec828' > /mnt/e/MarveenBackup/.marveen-drive-id
"""

import argparse
import glob
import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import traceback
import urllib.request
from datetime import datetime

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# The drive. DEST_ROOT is never created by this script: on WSL /mnt/e stays an
# ordinary (empty) directory when the drive is detached, so "create it if
# missing" is precisely the bug AC-B2 exists to prevent.
DEST_ROOT = "/mnt/e/MarveenBackup"
MARKER = f"{DEST_ROOT}/.marveen-drive-id"
# Generated once, 2026-07-31, and pinned here. It identifies THIS drive: a
# different WD Elements, a re-lettered volume or an empty mount point cannot
# produce it, so the gate cannot be satisfied by accident.
DRIVE_UUID = "48a828f3-305c-4117-bf93-a3ebb59ec828"

SOURCE_ROOT = f"{REPO}/backups/nightly-memory"
SOURCE_TIERS = ("daily", "monthly")
NIGHTLY_SCRIPT = f"{REPO}/scripts/nightly-memory-backup.py"

STATE_FILE = f"{REPO}/store/.weekly-elocal.state"
DASHBOARD_TOKEN_FILE = f"{REPO}/store/.dashboard-token"
MESSAGES_API = "http://localhost:3420/api/messages"
DAILY_LOG_API = "http://localhost:3420/api/daily-log"
ALERT_FROM = "neo"
ALERT_TO = "mr-wolfe"

# AC-B6. 8 weekly + 6 monthly is ~1.6 GB at the current 111 MB/archive.
KEEP_WEEKLY = 8
KEEP_MONTHLY = 6
# AC-D3: the coordinator hears about an absent drive after three weeks, not
# after one -- a drive unplugged over a holiday is not an incident.
MISS_ALERT_AT = 3
FREE_SPACE_HEADROOM = 512 * 1024 * 1024
# Rolling one-line run records kept in the state file (~3 months of weeks).
HISTORY_KEEP = 12

STAMP_RE = re.compile(r"^\d{8}-\d{6}$")
CHUNK = 4 * 1024 * 1024


class WeeklyError(Exception):
    """Controlled failure: alert, non-zero exit, and NO prune.

    kind='mismatch' is the corruption class -- two digests that must be equal
    are not. It alerts on EVERY occurrence (AC-D3), because a backup that
    silently disagrees with its own checksum is worse than no backup.
    kind='error' is everything else (no complete source set, unwritable drive,
    ...) and alerts only when the run ENTERS that state, so a standing broken
    precondition does not page the coordinator every Sunday.
    """

    def __init__(self, message, kind="error"):
        super().__init__(message)
        self.kind = kind


# --------------------------------------------------------------------------
# small helpers (same idioms as scripts/nightly-memory-backup.py)
# --------------------------------------------------------------------------

def human(n):
    if n >= 1024 ** 3:
        return f"{n / 1024 ** 3:.2f} GB"
    return f"{n / 1024 / 1024:.2f} MB" if n >= 1024 * 1024 else f"{n / 1024:.1f} kB"


def log(msg):
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def short(digest):
    return f"{digest[:16]}..." if digest else "-"


# --------------------------------------------------------------------------
# state (store/.weekly-elocal.state) -- the alerting memory AND what the
# morning checker skill reads
# --------------------------------------------------------------------------

def empty_state():
    return {
        "version": 1,
        "updated_at": None,
        "last_status": "unknown",     # ok | absent | mismatch | error
        "consecutive_misses": 0,
        "alerted": False,             # an outstanding RED the coordinator knows about
        "last_stamp": None,
        "last_sha256": None,
        "last_ok_at": None,
        "last_monthly_month": None,   # "YYYY-MM" of the last monthly promotion
        "last_rehearsal": None,
        "last_error": None,
        "history": [],
    }


def load_state():
    """A corrupt or half-written state file must not stop a backup: the run is
    the point, the state is bookkeeping. It is reported, then rebuilt."""
    if not os.path.exists(STATE_FILE):
        return empty_state()
    try:
        with open(STATE_FILE, encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            raise ValueError("nem objektum")
        state = empty_state()
        state.update(data)
        return state
    except Exception as e:  # noqa: BLE001 -- see docstring
        log(f"WARN: allapotfajl olvashatatlan ({type(e).__name__}: {e}), ujraepitem")
        return empty_state()


def save_state(state, run_line, dry_run):
    """Atomic write: a torn state file would lose the miss counter and with it
    the whole transition logic."""
    if dry_run:
        log(f"DRY-RUN, allapot NEM irodik ki: {run_line}")
        return
    state["updated_at"] = datetime.now().isoformat(timespec="seconds")
    history = list(state.get("history") or [])
    history.append(run_line)
    state["history"] = history[-HISTORY_KEEP:]
    tmp = f"{STATE_FILE}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, STATE_FILE)


# --------------------------------------------------------------------------
# notification (AC-D1/D4, AC-B8) -- coordinator only, never the Bot API
# --------------------------------------------------------------------------

def post_json(url, payload, timeout):
    with open(DASHBOARD_TOKEN_FILE) as f:
        token = f.read().strip()
    body = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=body, method="POST",
                                 headers={"Content-Type": "application/json",
                                          "Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        r.read()


def send_alert(text, quiet=False):
    """One inter-agent message to mr-wolfe (scripts/site-monitor.py precedent).

    Deliberately NOT the direct Bot API: the audit's AC-B8 forbids a fifth
    direct api.telegram.org path, and a weekly machine fact is the coordinator's
    triage, not something that should reach Gabor's phone by itself (AC-D1).
    The Sunday 19:00 slot is outside the 22:00-06:00 quiet window by
    construction, and the coordinator's own send path is quiet-hours gated.

    Returns True if the message was accepted -- the caller records that, so a
    failed send is retried next week instead of being silently swallowed.
    """
    if quiet:
        log("DRY-RUN, riasztas NEM ment el:\n" + text)
        return False
    try:
        post_json(MESSAGES_API, {"from": ALERT_FROM, "to": ALERT_TO, "content": text}, 15)
        log(f"riasztas elkuldve a koordinatornak: {text.splitlines()[0]}")
        return True
    except Exception as e:  # noqa: BLE001 -- an alert failure must not fail the run
        log(f"CRITICAL: a riasztas nem ment ki ({type(e).__name__}: {e})")
        return False


def daily_log(content, quiet=False):
    """Best effort: the dashboard may be down, that must not fail a backup that
    is already safely on the drive."""
    if quiet:
        log("DRY-RUN, napi naplo NEM irodik:\n" + content)
        return False
    try:
        post_json(DAILY_LOG_API, {"agent_id": "neo", "content": content}, 15)
        return True
    except Exception as e:  # noqa: BLE001 -- deliberately non-fatal
        log(f"WARN: napi naplo iras sikertelen ({type(e).__name__}: {e})")
        return False


def alert_footer():
    return f"Host: {socket.gethostname()}  Ido: {datetime.now():%Y-%m-%d %H:%M:%S}"


# --------------------------------------------------------------------------
# AC-B2: presence gate -- marker + write probe, never os.path.isdir('/mnt/e')
# --------------------------------------------------------------------------

def write_probe():
    """Step (ii): prove the mount takes a WRITE right now.

    A read-only remount, a full volume, a drive that vanished between the marker
    read and this moment, or a 9p transport that is up but broken all fail here
    and only here -- none of them is visible from a stat() of the path.
    """
    payload = (f"marveen weekly-elocal probe "
               f"{datetime.now().isoformat(timespec='seconds')} pid={os.getpid()}").encode()
    fd, path = tempfile.mkstemp(prefix=".marveen-probe-", dir=DEST_ROOT)
    try:
        os.write(fd, payload)
        os.fsync(fd)
    finally:
        os.close(fd)
    try:
        with open(path, "rb") as f:
            got = f.read()
        if got != payload:
            return (f"az iras-proba visszaolvasasa eltert ({len(got)} bajt, "
                    f"vart {len(payload)}) -- a meghajto nem megbizhato, nem irunk ra")
        return None
    finally:
        try:
            os.remove(path)
        except OSError as e:
            log(f"WARN: a proba-fajl nem torolheto ({path}): {e}")


def drive_gate(dry_run):
    """The load-bearing gate (AC-B2). Returns None if the drive is PROVEN
    present, otherwise a human-readable reason.

    Why not os.path.isdir('/mnt/e'): under WSL the mount point remains a
    perfectly ordinary directory when the WD Elements drive is detached. A naive
    check would pass, the run would "succeed", and ~110 MB per week would land
    on the VM's own root filesystem -- filling the WSL disk while reporting a
    healthy offline backup. The marker file lives ON the drive and the write
    probe proves the mount is live and writable at this instant; neither can be
    satisfied by an empty mount point.

    The UUID comparison is the second half: an unrelated drive that happens to
    get letter E: must not be written to either. It is a different disk, and the
    fleet's retention would start pruning folders it never created.
    """
    try:
        if not os.path.isfile(MARKER):
            return (f"nincs marker fajl ({MARKER}) -- a meghajto nincs csatlakoztatva "
                    "(vagy a telepitesi lepes maradt el)")
        with open(MARKER, "r", errors="replace") as f:
            got = f.read(4096).strip()
        if got != DRIVE_UUID:
            return (f"a marker tartalma nem egyezik (vart {DRIVE_UUID}, kapott "
                    f"'{got[:64]}') -- IDEGEN meghajto van E:-n, nem irunk ra")
        if dry_run:
            log("  DRY-RUN: az iras-proba kimarad, a marker-ellenorzes lefutott")
            return None
        return write_probe()
    except OSError as e:
        # An I/O error mid-gate is the drive going away under us, which is
        # exactly the case the gate is for -- absent, not a failed run.
        return f"a meghajto nem elerheto ({type(e).__name__}: {e})"


# --------------------------------------------------------------------------
# source selection
# --------------------------------------------------------------------------

def recorded_digest(sums_path, archive_name):
    """The archive's digest out of the sha256sum-format SHA256SUMS file."""
    with open(sums_path, encoding="utf-8") as f:
        for line in f:
            parts = line.split()
            if len(parts) == 2 and parts[1].lstrip("*") == archive_name:
                return parts[0].lower()
    raise WeeklyError(f"a SHA256SUMS nem tartalmaz sort a(z) {archive_name} archivumra "
                      f"({sums_path}) -- a forras-keszlet hianyos")


def newest_complete_set():
    """The newest nightly night folder that carries ALL THREE files.

    "Complete" is the whole point: a night that failed halfway leaves a folder
    with an archive and no SHA256SUMS, and copying that to the drive would
    produce an offline backup that can never be checked. Incomplete folders are
    skipped, never repaired -- repairing a checksum here would invent evidence.

    Folder names sort chronologically (YYYYMMDD-HHMMSS), so no mtime games; the
    9p mount's timestamps are not something to build retention on.
    """
    candidates = []
    for tier in SOURCE_TIERS:
        tier_dir = os.path.join(SOURCE_ROOT, tier)
        if not os.path.isdir(tier_dir):
            continue
        for stamp in sorted(os.listdir(tier_dir)):
            night = os.path.join(tier_dir, stamp)
            if not STAMP_RE.match(stamp) or not os.path.isdir(night):
                continue
            archives = sorted(glob.glob(os.path.join(night, "*.tar.gz")))
            manifest = os.path.join(night, "MANIFEST.txt")
            sums = os.path.join(night, "SHA256SUMS")
            # Exactly one archive: two would make "which one does SHA256SUMS
            # describe" a guess, and this script does not guess.
            if len(archives) != 1 or not os.path.isfile(manifest) or not os.path.isfile(sums):
                log(f"  kihagyva (hianyos keszlet): {tier}/{stamp}")
                continue
            candidates.append({"stamp": stamp, "tier": tier, "dir": night,
                               "archive": archives[0], "manifest": manifest, "sums": sums})
    if not candidates:
        raise WeeklyError(
            f"nincs teljes ejszakai keszlet {SOURCE_ROOT}/{{{','.join(SOURCE_TIERS)}}} alatt "
            "(tar.gz + MANIFEST.txt + SHA256SUMS egyutt) -- a heti E: lab nem tud mit menteni; "
            "eloszor az ejszakai mentest kell rendbe tenni")
    return sorted(candidates, key=lambda c: c["stamp"])[-1]


# --------------------------------------------------------------------------
# AC-B5: copy, sync, read back, compare
# --------------------------------------------------------------------------

def copy_to_drive(src, dst):
    """Chunked copy with an fsync on the DESTINATION handle.

    shutil.copyfile does the same copy but returns while the data may still be
    dirty in the page cache. On a 9p/drvfs mount that window is exactly where a
    detached drive or a full volume turns into a silent truncation, so the fsync
    is not decoration -- it is half of what makes the read-back below mean
    anything.
    """
    with open(src, "rb") as fin, open(dst, "wb") as fout:
        for chunk in iter(lambda: fin.read(CHUNK), b""):
            fout.write(chunk)
        fout.flush()
        os.fsync(fout.fileno())


def sha256_readback(path):
    """sha256 of a file read BACK from the drive (AC-B5).

    The caller runs os.sync() before this. Here we additionally ask the kernel
    to drop this file's cached pages (POSIX_FADV_DONTNEED) on a fresh
    descriptor. Stated honestly: on 9p/drvfs the hint may be a no-op, and an
    unprivileged process cannot force a cold read from the physical device.

    What the read-back proves unconditionally, cache or no cache: the
    destination path exists, has the full length, and its bytes hash to the
    expected digest -- so a truncated, partially written, wrong or missing file
    cannot pass. A size comparison proves none of that (AC-B5 spells out why
    size and a successful copyfile() return are both insufficient).
    """
    h = hashlib.sha256()
    fd = os.open(path, os.O_RDONLY)
    try:
        try:
            os.posix_fadvise(fd, 0, 0, os.POSIX_FADV_DONTNEED)
        except OSError:
            pass  # best effort, see docstring
        with os.fdopen(fd, "rb", closefd=False) as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b""):
                h.update(chunk)
    finally:
        os.close(fd)
    return h.hexdigest()


def place_set(src, dest_dir, expect):
    """Copy the three files of a nightly set into dest_dir and verify each one
    by reading it back from the drive.

    `expect` maps filename -> the digest the file must have. For the archive it
    is the digest that came out of the LOCAL file and was already proven equal
    to the one recorded in SHA256SUMS, so the final comparison below closes both
    halves of AC-B5 ("compare against BOTH the source digest and the digest
    recorded in SHA256SUMS").

    Returns {filename: verified digest}. Raises kind='mismatch' on any
    disagreement; the caller must then skip the prune.

    A copy that fails verification is left in place on purpose. The folder's
    WEEKLY-VERIFY.txt is written only after every file passed, so an unproven
    folder is visibly unproven -- deleting the evidence would make the next run
    quietly redo it and the human would never see what happened.
    """
    os.makedirs(dest_dir, exist_ok=True)
    placed = []
    for name in sorted(expect):
        source = os.path.join(src["dir"], name)
        dst = os.path.join(dest_dir, name)
        # A file already here is NEVER silently overwritten. It is either a copy
        # an earlier run verified -- re-reading it is a free scrub of last week's
        # bytes -- or the debris of an interrupted one. Overwriting would erase
        # that difference and, with it, AC-B5's own acceptance test: truncate the
        # destination and the run must FAIL, not quietly repair itself. The fix
        # for a bad folder is a human deleting it, not this script hiding it.
        if os.path.exists(dst):
            log(f"  mar a meghajton: {name} ({human(os.path.getsize(dst))}) -- "
                "nem irjuk felul, visszaolvasasos ellenorzes")
            placed.append((name, dst, True))
            continue
        log(f"  masolas: {name} ({human(os.path.getsize(source))}) -> {dst}")
        copy_to_drive(source, dst)
        placed.append((name, dst, False))

    # One sync for the whole set, before any byte is read back.
    os.sync()

    verified = {}
    for name, dst, reused in placed:
        got = sha256_readback(dst)
        want = expect[name]
        if got != want:
            cause = ("a fajl mar a meghajton volt: vagy megserult a mediumon, vagy egy "
                     "korabbi futas felbeszakadt masolata -- torold a mappat a meghajton "
                     f"({dest_dir}) es futtasd ujra"
                     if reused else
                     "a fajlt most irtuk ki, tehat az iras vagy a medium a hibas")
            raise WeeklyError(
                f"VISSZAOLVASASI ELTERES: {dst}\n"
                f"  vart sha256:    {want}\n"
                f"  kapott sha256:  {got}\n"
                f"  meret a meghajton: {human(os.path.getsize(dst))}\n"
                f"  {cause}",
                kind="mismatch")
        verified[name] = got
        log(f"  verify OK ({'ujra-ellenorizve' if reused else 'ujonnan irva'}): "
            f"{name} sha256={short(got)}")
    return verified


def write_verify_manifest(dest_dir, src, verified, tier, started, free_note):
    """The per-week record AC-B5 asks for: what was verified, how, and against
    what. Written only on success, so its presence is the proof marker of the
    folder (see place_set)."""
    lines = [
        "MARVEEN HETI OFFLINE MENTES (E:) -- VERIFY MANIFEST",
        f"keszult:   {started.isoformat(timespec='seconds')}  (host {socket.gethostname()})",
        f"forras:    {src['dir']}",
        f"cel:       {dest_dir}  (tier: {tier})",
        f"meghajto:  {DEST_ROOT}  marker-UUID {DRIVE_UUID}",
        f"hely:      {free_note}",
        "",
        "ELLENORZOTT SHA256 (a bajtokat a MEGHAJTOROL visszaolvasva, os.sync() utan):",
    ]
    lines += [f"  {digest}  {name}" for name, digest in sorted(verified.items())]
    lines += [
        "",
        "Az archivum sha256-ja egyezik a forrasfajlebol szamitottal ES a keszlet",
        "sajat SHA256SUMS-aban rogzitettel (audit AC-B5).",
        "",
        "Visszaallitas: tar -xzf <archivum> -C <temp>; repo/* a repo gyokerebe,",
        "home/* a $HOME ala. Reszletek + DB-visszatoltes: MANIFEST.txt ugyanitt.",
        "Ellenorzes ezen a gepen: python3 scripts/nightly-memory-backup.py --rehearsal "
        f"{os.path.join(dest_dir, [n for n in verified if n.endswith('.tar.gz')][0])}",
    ]
    path = os.path.join(dest_dir, "WEEKLY-VERIFY.txt")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
        f.flush()
        os.fsync(f.fileno())
    return path


# --------------------------------------------------------------------------
# AC-B6: retention on the drive
# --------------------------------------------------------------------------

def prune_drive_tier(tier, keep, expected_stamp, dry_run):
    """Retention for one tier on the drive.

    Guard for guard the shape of prune_drive_tier in
    scripts/nightly-memory-backup.py:849-899, for the same reasons:
      - runs only AFTER this run's copy is verify-passed (call site), and
        additionally refuses to prune unless expected_stamp is VISIBLE in the
        listing -- if the listing cannot see the folder we just wrote, deleting
        by that same listing is not safe;
      - tiers are pruned inside their own weekly/ and monthly/ directories, so
        the weekly rule can never touch a monthly promotion;
      - only STAMP-shaped names are candidates, so anything hand-created on the
        drive is left alone;
      - sorted newest-first, only entries beyond `keep` go, so a removed week
        always has `keep` fresher siblings.

    One difference from the Drive side, and it is the reason the guards above
    matter more here: there is no trash on a local filesystem. rmtree is final.

    Returns a human-readable line; raises nothing -- a prune failure must never
    fail a backup that is already verified on the drive.
    """
    try:
        tier_dir = os.path.join(DEST_ROOT, tier)
        if not os.path.isdir(tier_dir):
            return f"{tier}: nincs ilyen mappa a meghajton, nincs mit nyesni"
        stamps = sorted((d for d in os.listdir(tier_dir)
                         if STAMP_RE.match(d) and os.path.isdir(os.path.join(tier_dir, d))),
                        reverse=True)
        if expected_stamp not in stamps:
            return (f"{tier}: PRUNE KIHAGYVA -- a vart legfrissebb mappa ({expected_stamp}) "
                    "nem latszik a listazasban, ilyen alapon torolni nem biztonsagos")
        doomed = stamps[keep:]
        if dry_run:
            return (f"{tier}: DRY-RUN, {len(stamps)} mappa, torolne: {len(doomed)}"
                    + (f" ({', '.join(doomed)})" if doomed else ""))
        for name in doomed:
            shutil.rmtree(os.path.join(tier_dir, name))
        return (f"{tier}: {len(stamps)} mappa, torolve: {len(doomed)}"
                + (f" ({', '.join(doomed)})" if doomed else ""))
    except Exception as e:  # noqa: BLE001 -- see docstring
        return f"{tier}: PRUNE HIBA ({type(e).__name__}: {e}) -- a mentes maga sikeres"


# --------------------------------------------------------------------------
# AC-B7: restore rehearsal, read from the drive
# --------------------------------------------------------------------------

def rehearsal_from_drive(archive_on_drive):
    """Run the nightly script's own --rehearsal against the archive ON E:.

    This is the cheapest close of audit section 5 gaps 1 and 2: the rehearsal
    existed but only ever read a local archive, and nothing scheduled it. Here
    it reads the copy we just placed on the drive, so a monthly run proves the
    offline artifact is actually restorable, not merely present.

    Reusing the nightly implementation instead of writing a second one is
    deliberate: it replays the exported DDL with no hand-written fallback,
    reloads every table, rebuilds the FTS index and runs a real MATCH. A second
    copy of that would drift.

    NOTE, stated rather than hidden: on FAIL the child process also emits its
    own direct Bot API alert (its alert() path). We do not suppress it --
    disarming another control's alerting from the outside would be a worse
    precedent than one duplicate message, and 19:00 is outside quiet hours. Our
    own coordinator message is the one AC-B7 requires.
    """
    try:
        proc = subprocess.run([sys.executable, NIGHTLY_SCRIPT, "--rehearsal", archive_on_drive],
                              capture_output=True, text=True, timeout=3600)
    except subprocess.TimeoutExpired:
        return "FAIL", "a rehearsal 60 perc alatt nem fejezodott be (timeout)"
    out = (proc.stdout or "").strip()
    err = (proc.stderr or "").strip()
    log("rehearsal kimenet:\n" + "\n".join("    " + l for l in out.splitlines()[-25:]))
    if proc.returncode == 0:
        verdict_line = next((l for l in out.splitlines() if "restore-rehearsal PASS" in l), "PASS")
        return "PASS", verdict_line
    detail = "\n".join(l for l in out.splitlines() if l.strip().startswith("FAIL")) or out[-800:]
    return "FAIL", f"exit {proc.returncode}\n{detail}\n{err[-400:]}".strip()


# --------------------------------------------------------------------------
# the run
# --------------------------------------------------------------------------

def handle_absent(state, reason, started, dry_run):
    """Drive not there: log, count, exit 0 (AC-B2). Absence is the expected
    state of a drive a human unplugs, not a failure of this job."""
    misses = int(state.get("consecutive_misses") or 0) + 1
    log(f"A MEGHAJTO NEM ELERHETO ({misses}. egymast koveto kimaradas): {reason}")
    state["last_status"] = "absent"
    state["consecutive_misses"] = misses
    state["last_error"] = reason

    # AC-D3: one message at three weeks, and only if we have not already sent
    # it. `alerted` (not `misses == 3`) is the condition, so a failed send is
    # retried next week instead of being lost.
    if misses >= MISS_ALERT_AT and not state.get("alerted"):
        last_ok = state.get("last_ok_at") or "MEG SOHA"
        text = (f"[weekly-elocal-backup] A heti offline (E:) mentes {misses} egymast koveto "
                f"alkalommal kimaradt.\n"
                f"Ok: {reason}\n"
                f"Utolso sikeres offline masolat: {last_ok} "
                f"(stamp: {state.get('last_stamp') or '-'})\n"
                "Kovetkezmeny: addig a flotta egyetlen host-tullelo masolata a Drive -- "
                "az audit 4. pontja szerint pont ez az egy-pont-hiba.\n"
                "Teendo: a WD Elements (E:) meghajtot vissza kell dugni; a kovetkezo "
                "vasarnapi futas magatol utoleri, kezi lepes nem kell.\n"
                + alert_footer())
        if send_alert(text, quiet=dry_run):
            state["alerted"] = True

    save_state(state,
               f"{started.isoformat(timespec='seconds')} absent misses={misses} ({reason[:80]})",
               dry_run)
    return 0


def run_weekly(dry_run):
    started = datetime.now()
    state = load_state()
    log(f"weekly-elocal-backup  dry_run={dry_run}  cel={DEST_ROOT}")

    # 1. AC-B2 presence gate -- everything else is downstream of this
    reason = drive_gate(dry_run)
    if reason:
        return handle_absent(state, reason, started, dry_run)
    log("meghajto-ellenorzes OK (marker + iras-proba)")

    # 2. newest complete nightly set, and its OWN integrity first
    src = newest_complete_set()
    archive_name = os.path.basename(src["archive"])
    archive_size = os.path.getsize(src["archive"])
    age_days = (started - datetime.strptime(src["stamp"], "%Y%m%d-%H%M%S")).days
    log(f"forras: {src['tier']}/{src['stamp']}  {archive_name}  {human(archive_size)}  "
        f"({age_days} napos)")

    digest_sums = recorded_digest(src["sums"], archive_name)
    digest_src = sha256_file(src["archive"])
    if digest_src != digest_sums:
        # The local artifact disagrees with its own checksum file. Copying it
        # would faithfully reproduce corruption onto the drive.
        raise WeeklyError(
            f"a FORRAS archivum nem egyezik a sajat SHA256SUMS-aval ({src['dir']})\n"
            f"  SHA256SUMS: {digest_sums}\n  a fajlbol:  {digest_src}\n"
            "SEMMI nem lett a meghajtora masolva.", kind="mismatch")
    log(f"forras-integritas OK: sha256={short(digest_src)} (= SHA256SUMS)")

    expect = {
        archive_name: digest_src,
        "MANIFEST.txt": sha256_file(src["manifest"]),
        "SHA256SUMS": sha256_file(src["sums"]),
    }
    set_bytes = sum(os.path.getsize(os.path.join(src["dir"], n)) for n in expect)

    # 3. free space BEFORE writing, so a full drive is a clean refusal instead
    #    of a truncated archive (the nightly script's check_quota precedent)
    month_key = started.strftime("%Y-%m")
    do_monthly = state.get("last_monthly_month") != month_key
    needed = set_bytes * (2 if do_monthly else 1)
    total, _used, free = shutil.disk_usage(DEST_ROOT)
    free_note = f"szabad {human(free)} / {human(total)}"
    if free < needed + FREE_SPACE_HEADROOM:
        raise WeeklyError(f"nincs eleg hely a meghajton: {free_note}, kell {human(needed)} "
                          f"+ {human(FREE_SPACE_HEADROOM)} tartalek -- SEMMI nem irodott ki")
    log(f"hely: {free_note}, ehhez a futashoz {human(needed)} kell")

    # 4. weekly copy + verify (AC-B5)
    weekly_dir = os.path.join(DEST_ROOT, "weekly", src["stamp"])
    if dry_run:
        log("DRY-RUN -- a meghajtora IRAS es a PRUNE kimarad. Amit masolna:")
        for name in sorted(expect):
            log(f"    weekly/{src['stamp']}/{name}  "
                f"{human(os.path.getsize(os.path.join(src['dir'], name)))}")
        if do_monthly:
            log(f"    + monthly/{src['stamp']}/ (a honap ({month_key}) elso sikeres futasa)")
            log(f"    + rehearsal: {NIGHTLY_SCRIPT} --rehearsal "
                f"{os.path.join(DEST_ROOT, 'monthly', src['stamp'], archive_name)}")
        log(f"  megtartas: weekly {KEEP_WEEKLY}, monthly {KEEP_MONTHLY}")
        log(f"  prune (weekly): {prune_drive_tier('weekly', KEEP_WEEKLY, src['stamp'], True)}")
        save_state(state, f"{started.isoformat(timespec='seconds')} dry-run "
                          f"stamp={src['stamp']}", dry_run)
        return 0

    log(f"weekly masolas -> {weekly_dir}")
    verified = place_set(src, weekly_dir, expect)
    manifest_path = write_verify_manifest(weekly_dir, src, verified, "weekly", started, free_note)
    log(f"verify manifest: {manifest_path}")

    # 5. monthly promotion: the first SUCCESSFUL run of a calendar month
    monthly_note = f"nincs (a honap ({month_key}) mar megvolt)"
    rehearsal_verdict, rehearsal_detail = None, None
    if do_monthly:
        monthly_dir = os.path.join(DEST_ROOT, "monthly", src["stamp"])
        log(f"monthly masolas ({month_key} elso sikeres futasa) -> {monthly_dir}")
        monthly_verified = place_set(src, monthly_dir, expect)
        write_verify_manifest(monthly_dir, src, monthly_verified, "monthly", started, free_note)
        # The month is marked done by the verified COPY. A failing rehearsal
        # alerts and blocks the prune, but must not make the next weekly run
        # re-promote the same stamp.
        state["last_monthly_month"] = month_key
        monthly_note = f"monthly/{src['stamp']} kiirva es ellenorizve"

        # 6. AC-B7: rehearsal against the archive ON THE DRIVE
        rehearsal_verdict, rehearsal_detail = rehearsal_from_drive(
            os.path.join(monthly_dir, archive_name))
        state["last_rehearsal"] = {"stamp": src["stamp"], "verdict": rehearsal_verdict,
                                   "at": datetime.now().isoformat(timespec="seconds")}
        log(f"rehearsal (E:-rol): {rehearsal_verdict}")

    # 7. retention, only for the tiers this run wrote, and only now (AC-B6)
    if rehearsal_verdict == "FAIL":
        # The new copy verified, so AC-B6's precondition is satisfied -- but if
        # the restore path is broken, keeping MORE copies is strictly safer than
        # keeping fewer. Deliberately more conservative than the AC requires,
        # and checked BEFORE the prune runs, not after.
        prune_notes = ["PRUNE KIHAGYVA -- a havi restore-rehearsal FAIL lett, "
                       "amig ez nem tisztazodik egyetlen regi masolat sem torlodik"]
    else:
        prune_notes = [prune_drive_tier("weekly", KEEP_WEEKLY, src["stamp"], dry_run)]
        if do_monthly:
            prune_notes.append(prune_drive_tier("monthly", KEEP_MONTHLY, src["stamp"], dry_run))
    for note in prune_notes:
        log(f"prune: {note}")

    # 8. status, state, notification
    was_alerted = bool(state.get("alerted"))
    state.update({"last_status": "ok", "consecutive_misses": 0, "alerted": False,
                  "last_stamp": src["stamp"], "last_sha256": verified[archive_name],
                  "last_ok_at": started.isoformat(timespec="seconds"), "last_error": None})

    summary = (f"[weekly-elocal-backup] OK {started:%Y-%m-%d %H:%M}\n"
               f"Forras: {src['tier']}/{src['stamp']} ({age_days} napos), {archive_name} "
               f"{human(archive_size)}\n"
               f"Cel: {weekly_dir}\n"
               f"sha256 (a meghajtorol visszaolvasva): {verified[archive_name]}\n"
               f"Monthly: {monthly_note}\n"
               f"Rehearsal (E:-rol): {rehearsal_verdict or 'nem futott (nem havi futas)'}\n"
               f"Hely: {free_note}\n"
               f"Prune: {' | '.join(prune_notes)}")

    exit_code = 0
    if rehearsal_verdict == "FAIL":
        # AC-B7: a failed restore rehearsal routes to the coordinator. This is
        # not the corruption class (the bytes matched); it means the artifact on
        # the drive cannot be restored FROM, which is the whole point of it.
        text = (f"[weekly-elocal-backup] RESTORE-REHEARSAL FAIL az E: meghajton levo "
                f"archivumbol.\n"
                f"Archivum: monthly/{src['stamp']}/{archive_name}\n"
                f"{rehearsal_detail}\n"
                "A masolat bajtra egyezik a forrassal, tehat a masolas rendben volt -- "
                "a visszaallithatosaggal van baj.\n"
                "A prune KIMARADT, regi masolat nem torlodott.\n"
                + alert_footer())
        send_alert(text, quiet=dry_run)
        state["alerted"] = True
        exit_code = 3
    elif was_alerted:
        # AC-D3 RED -> GREEN, and only if the coordinator was actually told
        # about the RED. A recovery notice for a state nobody heard about is
        # just noise.
        text = (f"[weekly-elocal-backup] HELYREALLT: a heti offline (E:) mentes ujra fut.\n"
                f"{summary}\n" + alert_footer())
        send_alert(text, quiet=dry_run)

    daily_log(f"## {started:%H:%M} -- Heti offline mentes (E:)\n{summary}", quiet=dry_run)
    save_state(state,
               f"{started.isoformat(timespec='seconds')} ok stamp={src['stamp']} "
               f"sha256={verified[archive_name]} "
               f"{'weekly+monthly' if do_monthly else 'weekly'} "
               f"rehearsal={rehearsal_verdict or '-'}",
               dry_run)
    log("kesz")
    return exit_code


def record_failure(kind, message, dry_run):
    """Persist a failed run and decide whether it is worth a message.

    mismatch alerts every time (data corruption is never routine); anything else
    alerts when the run ENTERS the state or when the failure class changes, so a
    standing broken precondition does not page the coordinator every Sunday.
    """
    state = load_state()
    prev_status, prev_alerted = state.get("last_status"), bool(state.get("alerted"))
    should = kind == "mismatch" or not prev_alerted or prev_status != kind
    state["last_status"] = kind
    state["last_error"] = message[:2000]

    if should:
        head = ("ADATSERULES -- a heti offline (E:) mentes ellenorzese elbukott"
                if kind == "mismatch" else
                "A heti offline (E:) mentes hibaval allt le")
        tail = ("A prune NEM futott, a korabbi masolatok erintetlenek. "
                "Kezi ellenorzes kell, mielott ujra futna.\n"
                if kind == "mismatch" else
                "A kovetkezo vasarnapi futas ujraprobalja.\n")
        if send_alert(f"[weekly-elocal-backup] {head}.\n{message}\n{tail}{alert_footer()}",
                      quiet=dry_run):
            state["alerted"] = True
    else:
        log(f"riasztas kihagyva (mar {prev_status} allapotban vagyunk, es jelezve lett)")

    save_state(state,
               f"{datetime.now().isoformat(timespec='seconds')} {kind} ({message[:80]})",
               dry_run)


def main():
    ap = argparse.ArgumentParser(
        description="Marveen heti offline mentes az E: meghajtora (audit 6(b), Tier 1)")
    ap.add_argument("--dry-run", action="store_true",
                    help="mindent megcsinal, kiveve a meghajtora irast, a prune-t, "
                         "a riasztast es az allapot/napi-naplo irast")
    args = ap.parse_args()

    try:
        return run_weekly(args.dry_run)
    except WeeklyError as e:
        log(f"HIBA ({e.kind}): {e}")
        record_failure(e.kind, str(e), args.dry_run)
        return 2 if e.kind == "mismatch" else 1
    except Exception:  # noqa: BLE001 -- nothing may die silently in a timer
        tb = traceback.format_exc()
        log(tb)
        record_failure("error", tb[-1200:], args.dry_run)
        return 1


if __name__ == "__main__":
    sys.exit(main())
