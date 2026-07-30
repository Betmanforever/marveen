#!/usr/bin/env bash
# zenom1 migration ROLLBACK -- rewritten for the mirror-then-swap plan (v5).
# Full spec: agents/neo/migration/mirror-then-swap-PLAN.md, section 3.
#
# ONE JOB, AND IT MUST NOT BE PREVENTABLE: get the WSL fleet running again.
#
# The old rollback.sh had TWO places where it could kill itself before ever
# reaching "[3/4] Starting WSL fleet" -- the zenom1 stop (:13-15) and the
# darkness check (:18, a bare `exit 1` under `set -euo pipefail`). Either one
# reproduced the exact 3-hour outage it existed to prevent, just with more code
# around it. The general rule that closes both, and any future sibling:
#
#   FROM ENTRY UNTIL THE UNCONDITIONAL WSL START THERE IS NO BARE REMOTE CALL
#   AND NO BARE `exit`.
#
# Concretely: `set -e` is deliberately NOT used, every ssh is wrapped in
# `timeout N ... || true`, and every check result goes into a VARIABLE that is
# logged -- never into an `&&`/`exit` chain. `ConnectTimeout` alone is not
# enough: it bounds the handshake only, and a wedged POST-authentication
# session (what actually happened) would hang forever.
#
# Runs unattended from the swap.sh dead-man timer as well as by hand, so it
# assumes nothing about the environment (explicit PATH, no tty).
#
#   ./rollback.sh            normal
#   ./rollback.sh --force    roll back even if the swap was marked successful
set -uo pipefail   # NO -e ON PURPOSE (see above)
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

M=/home/szabgabor/marveen
HOME_DIR=/home/szabgabor
KEY=$M/agents/neo/.ssh/zenom1_ed25519
ZHOST=szabgabor@192.168.1.131
STATE_DIR=$HOME_DIR/.marveen-migration
PHASE_FILE=$STATE_DIR/swap-phase
RB_LOG=$STATE_DIR/rollback.log
LOCK=$STATE_DIR/rollback.lock
FAILSAFE_UNIT=marveen-cutover-rollback-failsafe
SSH_TIMEOUT=45

FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

mkdir -p "$STATE_DIR" 2>/dev/null || true
say() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$RB_LOG"; }

# Direct Bot API, via python3 so the token never lands in an argv that `ps`
# can read (same reasoning as scripts/nightly-memory-backup.py:199).
notify() {
  local text="$1"
  python3 - "$text" <<'PY' 2>/dev/null || echo "(notify failed)"
import json, sys, urllib.request
text = sys.argv[1]
env = "/home/szabgabor/.claude/channels/telegram/.env"
tok = None
try:
    for line in open(env, errors="replace"):
        if line.strip().startswith("TELEGRAM_BOT_TOKEN="):
            tok = line.split("=", 1)[1].strip().strip('"').strip("'")
            break
except Exception:
    pass
if tok:
    body = json.dumps({"chat_id": "8765540529", "text": text[:3900]}).encode()
    req = urllib.request.Request(f"https://api.telegram.org/bot{tok}/sendMessage",
                                 data=body, method="POST",
                                 headers={"Content-Type": "application/json"})
    try:
        urllib.request.urlopen(req, timeout=30).read()
    except Exception as e:
        print("notify error:", e)
PY
}

# --- re-entrancy: an ERR and a TERM can arrive together, and the dead-man
# --- timer can fire while a manual rollback is already running.
if ! mkdir "$LOCK" 2>/dev/null; then
  say "rollback already in progress (lock $LOCK) -- this invocation exits without acting"
  exit 0
fi
cleanup_lock() { rmdir "$LOCK" 2>/dev/null || true; }
trap cleanup_lock EXIT

# Signals too, not just ERR: the Windows host has killed this VM mid-operation
# before, and the handler must still try to bring the fleet back.
on_signal() { say "!! signal received during rollback -- continuing to the WSL start"; }
trap on_signal INT TERM HUP

PHASE=$(cat "$PHASE_FILE" 2>/dev/null || echo "UNKNOWN")
say "================ ROLLBACK (phase=$PHASE force=$FORCE) ================"

# --- SAFETY INTERLOCK -----------------------------------------------------
# The dead-man timer is armed BEFORE the swap and cancelled after it. If that
# cancel ever fails, this script would otherwise tear down a fleet that just
# passed G-SMOKE. swap.sh writes SWAP_SUCCESS before attempting the cancel, so
# this check is the authoritative backstop.
if [[ "$PHASE" == "SWAP_SUCCESS" && "$FORCE" != "1" ]]; then
  say "phase=SWAP_SUCCESS -- the swap completed and was verified. NO ACTION TAKEN."
  say "(this is the expected outcome if the dead-man timer fired after a successful swap)"
  notify "[rollback] A dead-man idozito elsult egy MAR SIKERES swap utan -- nem tortent beavatkozas, a zenom1 flotta fut tovabb. Ellenorizd: systemctl --user list-timers"
  systemctl --user stop "$FAILSAFE_UNIT.timer" 2>/dev/null || true
  exit 0
fi

# --- 1. stop the zenom1 side, but ONLY where it was actually started -------
# Wrapped so it can NEVER stop this script. If zenom1 is wedged we accept a
# short dual-listener window and say so out loud: the repo's own documented
# incident (web.ts:385-397) measured a competing token claim killing the live
# session with a 409 in 33 seconds, 3 out of 3 times. That is the real,
# measured cost -- not "a few duplicate messages" -- and it is still preferable
# to a dead fleet. The WSL start below is UNCONDITIONAL either way (plan C4).
ZSTOP="skipped"
case "$PHASE" in
  POST_ZENOM1_DASHBOARD_START|POST_ZENOM1_CHANNELS_START|UNKNOWN)
    say "1. stopping the zenom1 fleet (best effort, ${SSH_TIMEOUT}s cap)"
    out=$(timeout "$SSH_TIMEOUT" ssh -i "$KEY" -o BatchMode=yes -o ConnectTimeout=10 "$ZHOST" \
      'systemctl --user stop mr-wolfe-channels.service mr-wolfe-dashboard.service 2>/dev/null;
       systemctl --user disable mr-wolfe-channels.service mr-wolfe-dashboard.service \
         marveen-site-monitor.timer marveen-telegram-progress-watchdog.timer \
         mr-wolfe-morning.timer 2>/dev/null;
       tmux kill-server 2>/dev/null; pkill -x claude 2>/dev/null; echo zenom1-stop-done' 2>&1) || true
    if grep -q "zenom1-stop-done" <<<"$out"; then ZSTOP="ok"; else ZSTOP="FAILED/TIMEOUT"; fi
    say "    zenom1 stop: $ZSTOP"
    ;;
  *)
    say "1. zenom1 was never started in this attempt (phase=$PHASE) -- nothing to stop"
    ;;
esac

# --- 2. darkness check: RESULT INTO A VARIABLE, never an exit --------------
# This is the second historical death point (old rollback.sh:18). It is now
# purely informational; it can fail, time out, or return garbage without
# affecting what happens next.
ZDARK="unknown"
if [[ "$ZSTOP" != "skipped" ]]; then
  # A PROBE-OK sentinel, exactly like the stop step's marker. Without it, "no
  # output" is ambiguous: a genuinely dark host and a probe that timed out on a
  # wedged remote session look identical, and reporting the wedge as "dark"
  # tells the operator the live bot tokens are safely down when they may not
  # be. Empty-means-good is a false green; only an explicit marker is evidence.
  out=$(timeout "$SSH_TIMEOUT" ssh -i "$KEY" -o BatchMode=yes -o ConnectTimeout=10 "$ZHOST" \
        'pgrep -a -f "dist/[i]ndex.js" || true; echo PROBE-OK' 2>&1)
  rc=$?
  if [[ $rc -ne 0 ]]; then
    ZDARK="UNKNOWN (probe rc=$rc, timeout/unreachable) -- zenom1 MAY STILL BE LIVE"
  elif grep -q "PROBE-OK" <<<"$out"; then
    body=${out//PROBE-OK/}
    if [[ -z "${body//[[:space:]]/}" ]]; then ZDARK="dark"
    else ZDARK="NOT-DARK: ${body:0:200}"; fi
  else
    ZDARK="UNKNOWN (no probe marker) -- zenom1 MAY STILL BE LIVE"
  fi
  say "2. zenom1 darkness: $ZDARK (informational only -- does not gate the WSL start)"
fi

# --- 3. START THE WSL FLEET -- UNCONDITIONALLY (plan C4) -------------------
say "3. starting the WSL fleet (unconditional)"
systemctl --user start mr-wolfe-dashboard.service 2>/dev/null || \
  say "    WARNING: dashboard start returned non-zero"
sleep 3
systemctl --user start mr-wolfe-channels.service 2>/dev/null || \
  say "    WARNING: channels start returned non-zero"
systemctl --user start marveen-site-monitor.timer \
  marveen-telegram-progress-watchdog.timer mr-wolfe-morning.timer 2>/dev/null || true

# --- 4. verify (again: report, never abort) --------------------------------
WSL_OK="no"
for _ in $(seq 1 12); do
  if curl -sf -o /dev/null http://localhost:3420/ 2>/dev/null; then WSL_OK="yes"; break; fi
  sleep 5
done
CHAN=$(systemctl --user is-active mr-wolfe-channels.service 2>/dev/null || echo unknown)
say "4. WSL dashboard responding: $WSL_OK; channels unit: $CHAN"

# --- 5. re-arm the Phase A mirror timer (plan C2) --------------------------
# A rolled-back attempt means WSL is production again, so the WSL->zenom1
# mirror should keep running and a future retry does not start from zero. This
# is the ONLY place the timer is ever re-armed; after a SUCCESSFUL swap it must
# stay off forever (swap.sh step 0b).
if [[ "$PHASE" != "SWAP_SUCCESS" ]]; then
  systemctl --user enable --now marveen-mirror.timer 2>/dev/null && \
    say "5. marveen-mirror.timer re-armed (WSL is production again)" || \
    say "5. marveen-mirror.timer could not be re-armed (not installed?) -- re-arm manually"
fi

# --- 6. cancel the dead-man timer: its job is done -------------------------
systemctl --user stop "$FAILSAFE_UNIT.timer" 2>/dev/null || true
systemctl --user reset-failed "$FAILSAFE_UNIT.service" 2>/dev/null || true

echo "ROLLED_BACK" > "$PHASE_FILE" 2>/dev/null || true

MSG="[rollback] zenom1 swap visszagorgetve.
Fazis: $PHASE
zenom1 leallitas: $ZSTOP
zenom1 sotet: $ZDARK
WSL dashboard el: $WSL_OK, channels: $CHAN
FIGYELEM: ha a zenom1 leallitas FAILED/TIMEOUT, rovid ideig KET listener lehet ugyanazon a bot-tokenen -- a repo sajat merese szerint ez 33 mp alatt 409-cel kiuti az egyik oldalt (3/3 eset). Ellenorizd kezzel a zenom1-et.
A zenom1-en a channels indulasa UTAN keletkezett irasok (bejovo uzenetek, kanban-kommentek, heartbeat) NEM allnak helyre automatikusan -- kezi, forditott iranyu rsync a dokumentalt ut."
say "$MSG"
notify "$MSG"

if [[ "$WSL_OK" != "yes" ]]; then
  say "ROLLBACK INCOMPLETE: the WSL dashboard is not responding -- MANUAL ACTION REQUIRED"
  exit 1
fi
say "ROLLBACK OK"
exit 0
