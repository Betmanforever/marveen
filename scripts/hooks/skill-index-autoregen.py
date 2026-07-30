#!/usr/bin/env python3
# PostToolUse hook (matcher: Write|Edit): auto-regenerates the skill index
# whenever a SKILL.md file is written or edited, by any agent or subagent
# (including skill-writer, which as of 2026-07-29 has no Bash tool at all --
# see .claude/agents/skill-writer.md). Removes the "agent must remember to
# run skill-index.sh" failure mode: mr-wolfe's card 0123b6bd (2026-07-29),
# following a skill-writer Bash-scope containment near-miss.
#
# DEBOUNCED (2026-07-29, mr-wolfe/Gabor, same-day follow-up to 0123b6bd): the
# first version ran the regen SYNCHRONOUSLY on every single matching call,
# blocking the writing agent for the duration and re-injecting the full index
# into every live agent session on every fire. Measured cost on a description-
# diet editing run: 80 regens for ~50 edits, one every ~25s at peak, one
# instance correlating with a coordinator session hard-restart (keep-alive
# stale after a busy stretch). Fix: coalesce a BURST of rapid writes into ONE
# regen, run in a detached background worker so the calling agent's tool call
# is never blocked waiting for it.
#
# Debounce design (deadline file + single-owner lock, both under store/):
#   - Every matching Write/Edit pushes a shared "deadline" file forward by
#     DEBOUNCE_SECONDS from now. This is the ONLY state a hook invocation
#     writes on the hot path -- cheap, and never blocks on the regen itself.
#   - At most one background "worker" process is alive polling that deadline
#     (ownership arbitrated by an exclusive-create lock file so concurrent
#     hook invocations from parallel tool calls don't spawn N workers).
#   - The worker sleeps until the deadline is reached with no further pushes,
#     THEN runs the regen exactly once. If a new write landed during the
#     regen run itself (deadline pushed again while regen was executing), the
#     worker does NOT exit -- it loops back and waits for quiet again. This
#     is the guarantee that the LAST write in a burst is never swallowed: a
#     debounce that drops the trailing event leaves the index silently stale,
#     which is worse than the pre-hook manual-discipline failure mode this
#     hook was built to replace.
#   - Observability is unchanged: every actual regen attempt (success or
#     failure) is still appended to LOG_PATH, and failures still leave the
#     FAIL_SENTINEL for a heartbeat/weekly check to catch -- a silently-stale
#     index defeats the point of a hook-based fix (mr-wolfe's original risk
#     #2 on card 0123b6bd), debouncing must not reintroduce it.
#   - The hook path (this script with a hook JSON payload on stdin) always
#     ends in approve() -- it must never block or fail the calling agent's
#     tool call on any branch, debounce logic included.
import sys, json, subprocess, datetime, os, time


def _install_dir():
    # Same convention as scripts/hooks/ledger_lib.py: derive the project root
    # from this script's own location (two levels up from scripts/hooks/),
    # never a hardcoded absolute path -- this hook is wired identically into
    # every agent's settings.json (and ships in the distributable template),
    # so it must not leak a single install's path.
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.dirname(os.path.dirname(here))


INSTALL_DIR = _install_dir()
LOG_PATH = os.path.join(INSTALL_DIR, "store", "skill-index-autoregen.log")
FAIL_SENTINEL = os.path.join(INSTALL_DIR, "store", "skill-index-autoregen.FAILED")
INDEX_SCRIPT = os.path.join(INSTALL_DIR, "scripts", "skill-index.sh")
DEADLINE_PATH = os.path.join(INSTALL_DIR, "store", "skill-index-autoregen.deadline")
LOCK_PATH = os.path.join(INSTALL_DIR, "store", "skill-index-autoregen.worker.lock")

DEBOUNCE_SECONDS = 45   # quiet window before a coalesced regen fires -- sized
                        # from a measured description-diet burst (94 events,
                        # 88 inter-event gaps: min 9s / p25 16s / median 25s /
                        # p75 35s / max 491s). 45s coalesces 82% of gaps
                        # (covers the full typical p75 band); 60s only adds 3
                        # more points for +15s of index staleness after the
                        # last write. mr-wolfe/Gabor decision, 2026-07-29.
POLL_INTERVAL_SEC = 1   # how often the worker re-checks the deadline
STALE_LOCK_AGE_SEC = 120  # lock older than this + dead/unreadable pid -> reclaim


def log(line):
    try:
        with open(LOG_PATH, "a") as f:
            f.write(f"{datetime.datetime.now().isoformat()} {line}\n")
    except Exception:
        pass  # logging must never crash the hook or the worker


def approve():
    print(json.dumps({"decision": "approve"}))
    sys.exit(0)


def _run_regen(trigger_desc):
    try:
        result = subprocess.run(
            ["bash", INDEX_SCRIPT],
            capture_output=True, text=True, timeout=60,
        )
        if result.returncode == 0:
            log(f"OK regen triggered by {trigger_desc}")
            if os.path.exists(FAIL_SENTINEL):
                os.remove(FAIL_SENTINEL)
        else:
            log(f"FAIL regen exit={result.returncode} triggered by {trigger_desc} "
                f"stderr={result.stderr[:500]}")
            with open(FAIL_SENTINEL, "w") as f:
                f.write(f"{datetime.datetime.now().isoformat()} exit={result.returncode}\n"
                        f"{result.stderr[:2000]}\n")
    except Exception as e:
        log(f"FAIL exception triggered by {trigger_desc}: {e}")
        try:
            with open(FAIL_SENTINEL, "w") as f:
                f.write(f"{datetime.datetime.now().isoformat()} exception: {e}\n")
        except Exception:
            pass


def _push_deadline():
    deadline = time.time() + DEBOUNCE_SECONDS
    tmp = DEADLINE_PATH + ".tmp"
    try:
        with open(tmp, "w") as f:
            f.write(repr(deadline))
        os.replace(tmp, DEADLINE_PATH)
    except Exception:
        pass


def _read_deadline():
    try:
        return float(open(DEADLINE_PATH).read().strip())
    except Exception:
        return 0.0  # nothing recorded -- treat as already due


def _lock_is_stale():
    try:
        mtime = os.path.getmtime(LOCK_PATH)
    except FileNotFoundError:
        return True
    try:
        pid = int(open(LOCK_PATH).read().strip())
    except Exception:
        # Empty/placeholder content: only reclaim once it's been sitting for
        # a while. A live owner writes its real pid within milliseconds of
        # creating the file, so an unreadable lock is either a very fresh
        # in-flight claim (don't steal it) or a genuine crash (do, but only
        # after it's clearly not just in-flight).
        return (time.time() - mtime) > STALE_LOCK_AGE_SEC
    try:
        os.kill(pid, 0)
        return False  # process alive -- not stale
    except ProcessLookupError:
        return True  # pid is gone -- genuinely stale
    except PermissionError:
        return False  # exists under another uid -- treat as alive


def _maybe_spawn_worker():
    try:
        fd = os.open(LOCK_PATH, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.close(fd)
    except FileExistsError:
        if _lock_is_stale():
            try:
                os.remove(LOCK_PATH)
            except FileNotFoundError:
                pass
            _maybe_spawn_worker()  # retry now that the stale lock is cleared
        return  # a live worker already owns the lock; it'll see our deadline push
    # We won the race to create the lock -- spawn the detached worker and
    # record its real pid so later invocations can tell it's alive.
    try:
        proc = subprocess.Popen(
            [sys.executable, os.path.abspath(__file__), "--worker"],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, start_new_session=True,
        )
        with open(LOCK_PATH, "w") as f:
            f.write(str(proc.pid))
    except Exception as e:
        log(f"FAIL could not spawn debounce worker: {e}")
        try:
            os.remove(LOCK_PATH)
        except Exception:
            pass


def worker_main():
    try:
        with open(LOCK_PATH, "w") as f:
            f.write(str(os.getpid()))
    except Exception:
        pass
    while True:
        remaining = _read_deadline() - time.time()
        if remaining > 0:
            time.sleep(min(remaining, POLL_INTERVAL_SEC))
            continue
        _run_regen("debounced worker (coalesced burst)")
        # If a write landed during the regen run itself, don't exit yet --
        # the last write in a burst must never be swallowed by a debounce.
        if _read_deadline() > time.time():
            continue
        break
    try:
        pid = int(open(LOCK_PATH).read().strip())
        if pid == os.getpid():
            os.remove(LOCK_PATH)
    except Exception:
        pass


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--worker":
        worker_main()
        sys.exit(0)

    try:
        payload = json.loads(sys.stdin.read())
    except Exception:
        # Malformed/empty stdin must never block the calling agent's tool call.
        approve()

    tool_name = payload.get("tool_name", "")
    file_path = (payload.get("tool_input") or {}).get("file_path", "")

    if tool_name not in ("Write", "Edit") or not file_path.endswith("SKILL.md"):
        approve()

    # Only fire for an actual skill directory, not any coincidental SKILL.md path.
    if "/skills/" not in file_path:
        approve()

    agent_type = payload.get("agent_type", "main-session")
    log(f"QUEUE {tool_name} on {file_path} (agent_type={agent_type}) -- debounced")
    _push_deadline()
    _maybe_spawn_worker()

    approve()
