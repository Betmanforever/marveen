#!/usr/bin/env bash
# Phase C of the zenom1 mirror-then-swap migration: the SHORT swap window.
#
# Full spec + audit trail: agents/neo/migration/mirror-then-swap-PLAN.md (v5,
# PASS). Section references below point there.
#
# THE ORDER IS THE POINT (plan F2). The old cutover.sh synced state and THEN
# stopped the fleet; everything written between the sync and the stop (a
# message, a memory, a kanban comment) was silently lost. Here it is:
#     stop WSL  ->  verify darkness  ->  FINAL delta sync  ->  start zenom1
# Never the other way round.
#
# WHO MAY RUN THIS (plan F8, non-negotiable): Gabor's own terminal, or a fully
# DETACHED process (systemd-run) that is not an agent session. NEVER a
# sub-agent's live claude session -- the darkness gate below cannot distinguish
# "the claude process running this very script" from a genuinely stuck one, so
# an agent would either flag itself or, worse, allowlist itself and hide a real
# violation. The guard is enforced, not merely documented.
#
#   ABORT_AT=HH:MM SWAP_CONFIRM=YES-SWAP-NOW ./swap.sh
#
# Optional env:
#   ROLLBACK_FAILSAFE_MIN=N  override the dead-man timer (default: derived from
#                            ABORT_AT + 15 min buffer, clamped to 15..120)
set -euo pipefail

M=/home/szabgabor/marveen
HOME_DIR=/home/szabgabor
KEY=$M/agents/neo/.ssh/zenom1_ed25519
ZHOST=szabgabor@192.168.1.131
SSH_OPTS=(-i "$KEY" -o BatchMode=yes -o ConnectTimeout=10)
STATE_DIR=$HOME_DIR/.marveen-migration
PHASE_FILE=$STATE_DIR/swap-phase
SWAP_LOG=$STATE_DIR/swap.log
ROLLBACK=$M/scripts/migration/rollback.sh
MIRROR_SYNC=$M/scripts/migration/mirror-sync.py
FAILSAFE_UNIT=marveen-cutover-rollback-failsafe

WSL_UNITS=(mr-wolfe-channels.service mr-wolfe-dashboard.service
           marveen-site-monitor.timer marveen-telegram-progress-watchdog.timer
           mr-wolfe-morning.timer)

mkdir -p "$STATE_DIR"

say() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$SWAP_LOG"; }

set_phase() {
  echo "$1" > "$PHASE_FILE"
  say "PHASE -> $1"
}

# --------------------------------------------------------------------------
# guards
# --------------------------------------------------------------------------

refuse() { echo "REFUSED: $*" >&2; exit 2; }

# plan F8. Structural, not advisory.
assert_not_agent_session() {
  [[ -n "${CLAUDECODE:-}" ]] && refuse "running inside a Claude Code session (CLAUDECODE set). Phase C must run from Gabor's own terminal or a detached systemd-run process."
  [[ -n "${CLAUDE_CODE_ENTRYPOINT:-}" ]] && refuse "running inside a Claude Code session (CLAUDE_CODE_ENTRYPOINT set)."
  local pid comm
  pid=$$
  while [[ -n "$pid" && "$pid" != "0" && "$pid" != "1" ]]; do
    comm=$(ps -o comm= -p "$pid" 2>/dev/null | tr -d ' ' || true)
    [[ "$comm" == "claude" ]] && refuse "a 'claude' process is an ancestor of this script (pid $pid). Phase C may not run from an agent session."
    pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ' || true)
  done
  if [[ -n "${TMUX:-}" ]]; then
    local sess
    sess=$(tmux display-message -p '#S' 2>/dev/null || true)
    case "$sess" in
      agent-*|marveen-worker) refuse "running inside tmux session '$sess' (an agent session)." ;;
    esac
  fi
}

# Deliberately the VERY FIRST thing this script evaluates: the most dangerous
# way to misuse swap.sh is to run it from an agent session, so that check must
# not sit behind an argument check that a caller could satisfy by accident.
assert_not_agent_session

: "${ABORT_AT:?Set ABORT_AT=HH:MM (hard abort time) before running swap.sh}"
[[ "${SWAP_CONFIRM:-}" == "YES-SWAP-NOW" ]] || \
  refuse "set SWAP_CONFIRM=YES-SWAP-NOW to confirm you are opening the swap window."

# plan open-question 3 (F-AMBER): once the fleet is live and G-SMOKE is green,
# the deadline must NOT roll back a healthy migration just because an optional
# tail check is still running. past_no_return flips off the deadline.
PAST_NO_RETURN=0
check_deadline() {
  [[ "$PAST_NO_RETURN" == "1" ]] && return 0
  if [[ "$(date +%H:%M)" > "$ABORT_AT" ]]; then
    say "ABORT DEADLINE $ABORT_AT PASSED"
    return 1
  fi
  return 0
}

# --------------------------------------------------------------------------
# error path
# --------------------------------------------------------------------------

on_error() {
  local rc=$? line=${1:-?}
  set +e
  say "!! FAILURE at line $line (rc=$rc) -- handing over to rollback.sh"
  trap - ERR INT TERM HUP
  exec "$ROLLBACK"
}
trap 'on_error $LINENO' ERR INT TERM HUP

zssh() { timeout 120 ssh "${SSH_OPTS[@]}" "$ZHOST" "$@"; }

# --------------------------------------------------------------------------
# 0a. LIVE-ARMED, MACHINE-INDEPENDENT DEAD-MAN TIMER (Gabor, 2026-07-25)
#
# Lives on the KNOWN-GOOD side (WSL) and survives this script dying: a crash,
# an SSH partition or the WSL VM being killed by the Windows host have ALL
# happened here before, and in each case the trap-based rollback above would
# never run. systemd fires rollback.sh regardless.
#
# It COMPLEMENTS the traps, it does not replace them. It is cancelled
# explicitly on success -- and rollback.sh independently refuses to act once
# the phase file says SWAP_SUCCESS, so a failed cancel cannot tear down a
# healthy fleet.
# --------------------------------------------------------------------------

failsafe_minutes() {
  if [[ -n "${ROLLBACK_FAILSAFE_MIN:-}" ]]; then echo "$ROLLBACK_FAILSAFE_MIN"; return; fi
  local now_e abort_e mins
  now_e=$(date +%s)
  abort_e=$(date -d "today $ABORT_AT" +%s 2>/dev/null || echo 0)
  if [[ "$abort_e" -le "$now_e" ]]; then echo 15; return; fi
  mins=$(( (abort_e - now_e) / 60 + 15 ))
  (( mins < 15 )) && mins=15
  (( mins > 120 )) && mins=120
  echo "$mins"
}

arm_failsafe() {
  local mins; mins=$(failsafe_minutes)
  # A leftover unit from an earlier attempt would make systemd-run fail.
  systemctl --user stop "$FAILSAFE_UNIT.timer" 2>/dev/null || true
  systemctl --user stop "$FAILSAFE_UNIT.service" 2>/dev/null || true
  systemctl --user reset-failed "$FAILSAFE_UNIT.service" 2>/dev/null || true
  systemd-run --user --on-active="${mins}m" --unit="$FAILSAFE_UNIT" \
    --description="Marveen cutover dead-man rollback" \
    "$ROLLBACK" >/dev/null
  say "0a. DEAD-MAN TIMER ARMED: $FAILSAFE_UNIT fires rollback.sh in ${mins} min"
  systemctl --user list-timers "$FAILSAFE_UNIT.timer" --no-pager 2>/dev/null | sed -n 2p || true
}

cancel_failsafe() {
  systemctl --user stop "$FAILSAFE_UNIT.timer" 2>/dev/null || true
  systemctl --user stop "$FAILSAFE_UNIT.service" 2>/dev/null || true
  systemctl --user reset-failed "$FAILSAFE_UNIT.service" 2>/dev/null || true
  if systemctl --user list-units --all "$FAILSAFE_UNIT.timer" --no-pager 2>/dev/null | grep -q "$FAILSAFE_UNIT"; then
    say "WARNING: the dead-man timer may still be loaded -- verify manually: systemctl --user list-timers"
  else
    say "dead-man timer cancelled"
  fi
}

# ==========================================================================
say "================ zenom1 SWAP WINDOW OPENING (ABORT_AT=$ABORT_AT) ================"
say "guard ok: not an agent session (pid $$, tty ${TTY:-n/a})"
set_phase ARMED
arm_failsafe

# --------------------------------------------------------------------------
# 0b. MIRROR TIMER TEARDOWN -- FIRST (plan F3)
# A tick landing mid-swap, or after a SUCCESSFUL swap, would rsync --delete the
# old WSL state over the new production. The timer is never re-armed in the
# WSL->zenom1 direction after a success; only rollback.sh re-arms it, and only
# because a rollback means WSL is production again (plan C2).
# --------------------------------------------------------------------------
say "0b. mirror timer teardown"
systemctl --user stop marveen-mirror.timer 2>/dev/null || true
systemctl --user disable marveen-mirror.timer 2>/dev/null || true
say "    marveen-mirror.timer stopped+disabled (no-op if never installed)"

check_deadline || on_error $LINENO

# --------------------------------------------------------------------------
# 1. zenom1 must still be dark before we take the live side down
# --------------------------------------------------------------------------
say "1. GATE0: zenom1 dark check"
zdark=$(zssh 'pgrep -a -f "dist/[i]ndex.js" || true' | tr -d '\n')
[[ -z "$zdark" ]] || { say "zenom1 NOT dark: $zdark"; on_error $LINENO; }
say "    zenom1 dark"

# --------------------------------------------------------------------------
# 2. STOP THE WSL FLEET (plan C2) + GATE1 fix: the stopping STEP itself kills
#    stuck claude processes, with an explicit allowlist. Today's incident stalled
#    exactly here (6 stuck processes) and the old script just gave up with the
#    fleet already down.
# --------------------------------------------------------------------------
say "2. stopping WSL fleet"
systemctl --user stop mr-wolfe-channels.service 2>/dev/null || true
systemctl --user stop mr-wolfe-dashboard.service 2>/dev/null || true
systemctl --user stop marveen-site-monitor.timer marveen-telegram-progress-watchdog.timer \
                     mr-wolfe-morning.timer 2>/dev/null || true
set_phase WSL_STOPPED
sleep 3

# Allowlist: the legitimate auth session, plus whatever the operator names.
# Because Phase C never runs from an agent session (guard above), there is no
# "this script's own claude" case to except -- which is precisely why that
# guard exists rather than an allowlist entry for ourselves.
ALLOW_SESSIONS_RE='^(claude-auth)$'
say "2b. killing leftover claude processes (allowlist: $ALLOW_SESSIONS_RE)"
for s in $(tmux ls -F '#{session_name}' 2>/dev/null || true); do
  if [[ "$s" =~ $ALLOW_SESSIONS_RE ]]; then
    say "    keeping tmux session $s (allowlisted)"
  else
    tmux kill-session -t "$s" 2>/dev/null || true
    say "    killed tmux session $s"
  fi
done
# Bounded wait, then a hard pass. NEVER touches mr-wolfe-channels.service's
# KillMode=process setting (plan C2).
for _ in $(seq 1 10); do
  pgrep -x claude >/dev/null 2>&1 || break
  sleep 2
done
if pgrep -x claude >/dev/null 2>&1; then
  say "    claude still alive after bounded wait -- SIGTERM then SIGKILL"
  pkill -x claude 2>/dev/null || true
  sleep 5
  pkill -9 -x claude 2>/dev/null || true
  sleep 2
fi

# --------------------------------------------------------------------------
# 3. VERIFY WSL IS FULLY DARK (plan C3)
# --------------------------------------------------------------------------
say "3. GATE1: WSL darkness verification"
wsl_nodes=$(pgrep -a -f "dist/[i]ndex.js" || true)
wsl_claude=$(pgrep -a -x claude || true)
[[ -z "$wsl_nodes" ]]  || { say "WSL dashboard still running: $wsl_nodes"; on_error $LINENO; }
[[ -z "$wsl_claude" ]] || { say "claude processes survived: $wsl_claude"; on_error $LINENO; }
say "    WSL fully dark"

check_deadline || on_error $LINENO
set_phase PRE_ZENOM1_START

# --------------------------------------------------------------------------
# 4. THE FINAL DELTA SYNC -- now, with the source frozen (plan F2)
#    Reuses mirror-sync.py verbatim: one implementation of the store/ rules,
#    the consistent snapshot, the -wal/-shm ordering (plan D7) and the git push.
#    The delta is small because Phase A already moved the bulk.
# --------------------------------------------------------------------------
say "4. FINAL delta sync (WSL frozen)"
python3 "$MIRROR_SYNC" --no-alert 2>&1 | tee -a "$SWAP_LOG"

# --------------------------------------------------------------------------
# 5. GATE2: the tree must be identical (old cutover.sh:53 pattern). Failing
#    here is cheap: zenom1 has not started, so rollback is trivial.
# --------------------------------------------------------------------------
say "5. GATE2: transfer verification"
diffs=$(rsync -a -ni --delete -e "ssh ${SSH_OPTS[*]}" \
        --exclude node_modules --exclude '/dist/' --exclude '/.git/' \
        --exclude '/store/' --exclude '/.env' \
        "$M/" "$ZHOST:$M/" | grep -v '^$' || true)
if [[ -n "$diffs" ]]; then
  say "GATE2 FAILED, residual diffs:"; echo "$diffs" | head -30 | tee -a "$SWAP_LOG"
  on_error $LINENO
fi
say "    tree identical"

# --------------------------------------------------------------------------
# 6. RE-ARM THE KEEP-ALIVE LAYER BEFORE ANY LIVE BOT STARTS (plan B2)
#    This step was missing entirely from an earlier plan revision. Without it
#    the NEW production would boot with no respawn, no sub-agent reconcile, no
#    reauth healer -- a silent re-creation of today's incident on the new host.
#    Assert the EFFECTIVE layer, not the files (plan D2).
# --------------------------------------------------------------------------
say "6. removing the dark-mode gates on zenom1"
zssh "rm -f $HOME_DIR/.config/systemd/user/mr-wolfe-dashboard.service.d/override.conf; \
      rmdir $HOME_DIR/.config/systemd/user/mr-wolfe-dashboard.service.d 2>/dev/null || true; \
      systemctl --user daemon-reload; \
      sed -i '/^RESPAWN_ENABLED=/d' $M/.env"
eff_env=$(zssh "systemctl --user show mr-wolfe-dashboard.service -p Environment" || true)
respawn_line=$(zssh "grep -E '^RESPAWN_ENABLED=' $M/.env || true" | tr -d '\n')
say "    effective env: $eff_env"
say "    RESPAWN_ENABLED line: '${respawn_line:-<absent, defaults to enabled>}'"
if grep -q "WEB_ONLY" <<<"$eff_env"; then
  say "WEB_ONLY STILL EFFECTIVE after drop-in removal + daemon-reload"; on_error $LINENO
fi
if [[ "$respawn_line" == "RESPAWN_ENABLED=0" ]]; then
  say "RESPAWN_ENABLED=0 still present -- the new fleet would run with no keep-alive"; on_error $LINENO
fi
say "    keep-alive layer re-armed"

# --------------------------------------------------------------------------
# 7. BUILD FRESHNESS AFTER the final sync (plan open question 6, F-AMBER).
#    Phase B's build validated the PREVIOUS sync's tree, not this one.
# --------------------------------------------------------------------------
say "7. rebuilding on zenom1 (post-final-sync freshness)"
zssh "cd $M && npm run build 2>&1 | tail -5" | tee -a "$SWAP_LOG"

check_deadline || on_error $LINENO

# --------------------------------------------------------------------------
# 8. START THE zenom1 FLEET -- enable --now, not just start (plan F6), so a
#    reboot brings it back.
# --------------------------------------------------------------------------
say "8. starting zenom1 fleet"
zssh "systemctl --user enable --now mr-wolfe-dashboard.service"
set_phase POST_ZENOM1_DASHBOARD_START
for _ in $(seq 1 24); do
  if zssh 'curl -sf -o /dev/null http://localhost:3420/' 2>/dev/null; then break; fi
  sleep 5
done
zssh 'curl -sf -o /dev/null http://localhost:3420/' || { say "zenom1 dashboard dead"; on_error $LINENO; }
say "    dashboard live"

zssh "systemctl --user enable --now mr-wolfe-channels.service"
set_phase POST_ZENOM1_CHANNELS_START
sleep 5
zssh "systemctl --user enable --now marveen-site-monitor.timer \
      marveen-telegram-progress-watchdog.timer mr-wolfe-morning.timer"
say "    channels + timers enabled -- LIVE BOT TOKENS ARE NOW ON THE NEW HOST"

# --------------------------------------------------------------------------
# 9. G-SMOKE (plan C8). The rehearsal proves nothing about this layer.
# --------------------------------------------------------------------------
cat <<'GSMOKE' | tee -a "$SWAP_LOG"
=== G-SMOKE (channels ON) -- MANUAL/ASSISTED, ALL THREE REQUIRED ===
  [ ] Telegram round trip on ALL FIVE bots (mr-wolfe, neo, alex, charlie, ive):
      inbound message -> that agent's reply arrives back in the chat.
  [ ] Inter-agent message: insert via API, verify delivered + ACK in drain log.
  [ ] One scheduled heartbeat actually fires on the new host.
RED-GATE: any red -> ./rollback.sh.
NOTE (plan C3): writes made on zenom1 from this point on (inbound Telegram
messages, kanban comments, heartbeat fires) are NOT restored automatically by a
rollback. The documented recovery is a manual reverse rsync.
GSMOKE

read -r -p "G-SMOKE all three green? [yes/NO] " ans
if [[ "$ans" != "yes" ]]; then
  say "G-SMOKE not confirmed green -> rollback"
  on_error $LINENO
fi

# --------------------------------------------------------------------------
# 10. SUCCESS. Order matters: mark the phase FIRST, so that even if the
#     cancel below fails, the dead-man timer's rollback.sh reads SWAP_SUCCESS
#     and refuses to tear down a healthy fleet.
# --------------------------------------------------------------------------
PAST_NO_RETURN=1
set_phase SWAP_SUCCESS
cancel_failsafe

# --------------------------------------------------------------------------
# 11. PERMANENTLY DARKEN THE OLD WSL SIDE (plan F6): disable, not just stop,
#     so a WSL restart cannot resurrect the old fleet with all five live tokens.
# --------------------------------------------------------------------------
say "11. disabling WSL units permanently"
for u in "${WSL_UNITS[@]}"; do
  systemctl --user disable "$u" 2>/dev/null || true
  say "    disabled $u"
done

trap - ERR INT TERM HUP
cat <<'DONE' | tee -a "$SWAP_LOG"

================ SWAP COMPLETE ================
zenom1 is production. WSL units are stopped AND disabled.

"swap done" is NOT "migration closed" (plan F6) -- one item remains and it
CANNOT be done from Linux:

  [ ] Disable/remove marveen-wsl-start.vbs from the Windows Startup folder
      (or turn off linger/autostart inside the WSL distro).
      Until then, a Windows login restarts the WSL VM and could bring the old
      fleet back with all five live bot tokens, unattended.

Only after that box is ticked may the migration be declared closed.
DONE
say "swap.sh finished successfully"
