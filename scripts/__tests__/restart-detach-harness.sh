#!/bin/bash
# Isolated verification harness for the update.sh "restart detach" fix.
# Run: bash scripts/__tests__/restart-detach-harness.sh
#
# Proves that the restart mechanism update.sh now uses -- a fire-and-forget
# transient systemd USER SERVICE -- survives the exact failure mode that took the
# fleet down: the caller's cgroup being torn down mid-restart (stop.sh running
# `systemctl --user stop marveen-channels` + `tmux kill-session` while update.sh
# itself lives in that cgroup / on that pty).
#
# It uses ONLY throwaway DUMMY stop/start scripts and DUMMY transient units named
# `marveen-harness-*`. It NEVER references marveen-dashboard / marveen-channels or
# the real scripts/stop.sh / scripts/start.sh, and never touches a live service.
#
#   POSITIVE (the fix): the restart runs as a detached service. A dummy stop.sh
#     tears down the invoker's scope (the marveen-channels stand-in); the detached
#     service is in its OWN cgroup under the user manager, so dummy start.sh still
#     runs and writes START_DONE. -> marker MUST appear.
#   NEGATIVE (the bug): the same stop;start runs as a DIRECT in-cgroup child of
#     the invoker. When stop.sh tears the invoker's scope down it kills the whole
#     group before start.sh runs. -> marker MUST NOT appear.
#
# The contrast isolates the one thing the fix changes: detached service vs.
# in-cgroup call. Safe to run repeatedly; all temp files + transient units are
# cleaned up on exit.

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

echo "restart-detach harness"
echo "======================"

# ---------------------------------------------------------------------------
# Preflight: this harness needs a reachable user systemd manager. On macOS /
# WSL-without-systemd / CI there is none -- SKIP cleanly (the fix's else branch
# is the direct call there, which has no cgroup self-kill to test).
# ---------------------------------------------------------------------------
if ! command -v systemd-run >/dev/null 2>&1 \
   || [ -z "${XDG_RUNTIME_DIR:-}" ] \
   || ! systemctl --user is-system-running >/dev/null 2>&1; then
  echo "SKIP: no reachable user systemd manager (systemd-run / XDG_RUNTIME_DIR / --user)."
  echo "      Nothing to verify on this platform; the fix's macOS/direct path is unaffected."
  exit 0
fi

EPOCH="$(date +%s)"
TMP="$(mktemp -d)"
INV_POS="marveen-harness-inv-pos-$$-$EPOCH-$RANDOM"
INV_NEG="marveen-harness-inv-neg-$$-$EPOCH-$RANDOM"
RESTART_UNIT="marveen-harness-restart-$$-$EPOCH-$RANDOM"

cleanup() {
  # Stop + forget any transient unit we may have left behind, then the temp dir.
  for u in "$INV_POS" "$INV_NEG" "$RESTART_UNIT"; do
    systemctl --user stop "$u" >/dev/null 2>&1 || true
    systemctl --user stop "${u}.scope" >/dev/null 2>&1 || true
    systemctl --user stop "${u}.service" >/dev/null 2>&1 || true
    systemctl --user reset-failed "$u" "${u}.scope" "${u}.service" >/dev/null 2>&1 || true
  done
  rm -rf "$TMP"
}
trap cleanup EXIT

# Wait (bounded) for a marker string to appear in a file. Ticks are 0.2s.
wait_for() { # marker file max_ticks
  local marker="$1" file="$2" max="${3:-100}" i=0
  while [ "$i" -lt "$max" ]; do
    [ -f "$file" ] && grep -q "$marker" "$file" && return 0
    sleep 0.2; i=$((i + 1))
  done
  return 1
}

# Create dummy stop.sh + start.sh in <dir>. stop.sh stands in for the real
# stop.sh: it tears down <scope_to_kill> (the caller's cgroup) exactly the way
# `systemctl --user stop marveen-channels` reaps update.sh's cgroup in prod.
# start.sh sleeps briefly (real start latency) then writes START_DONE.
make_dummies() { # dir scope_to_kill
  local dir="$1" scope="$2"
  mkdir -p "$dir"
  cat > "$dir/stop.sh" <<EOF
#!/bin/bash
echo "STOP_RAN \$(date -u +%H:%M:%S)"
# Stand-in for stop.sh's lethal step (systemctl stop marveen-channels +
# tmux kill-session): tear down the invoker's cgroup.
systemctl --user stop "$scope.scope" >/dev/null 2>&1 || true
EOF
  cat > "$dir/start.sh" <<EOF
#!/bin/bash
sleep 2
echo "START_DONE \$(date -u +%H:%M:%S)"
EOF
  chmod +x "$dir/stop.sh" "$dir/start.sh"
}

# ---------------------------------------------------------------------------
# (1) POSITIVE -- detached transient SERVICE survives the invoker teardown.
# ---------------------------------------------------------------------------
echo ""
echo "(1) POSITIVE: detached service (the fix)"
make_dummies "$TMP/pos" "$INV_POS"
cat > "$TMP/invoker_pos.sh" <<EOF
#!/bin/bash
echo "INVOKER_LAUNCHED" >> "$TMP/invoker_pos.log"
# THE FIX: fire-and-forget detached transient user SERVICE (no --scope, no --wait),
# same shape as update.sh -- INSTALL_DIR passed positionally, output to a log file.
systemd-run --user --collect --quiet --unit="$RESTART_UNIT" \\
  bash -c '{ "\$1/stop.sh"; "\$1/start.sh"; } >> "\$1/restart.log" 2>&1' _ "$TMP/pos"
echo "INVOKER_SERVICE_LAUNCHED rc=\$?" >> "$TMP/invoker_pos.log"
# Stay alive so the detached stop.sh tears our scope down while we are mid-restart.
# If we are killed (expected), INVOKER_EXITED_NORMALLY is never written.
sleep 20
echo "INVOKER_EXITED_NORMALLY" >> "$TMP/invoker_pos.log"
EOF
chmod +x "$TMP/invoker_pos.sh"

# Run the invoker INSIDE its own transient scope = the doomed marveen-channels
# cgroup stand-in. --scope is synchronous: this returns once the scope is reaped
# (i.e. once the detached stop.sh has killed the invoker).
systemd-run --user --scope --collect --quiet --unit="$INV_POS" \
  bash "$TMP/invoker_pos.sh" >/dev/null 2>&1 || true

if wait_for "START_DONE" "$TMP/pos/restart.log" 100; then
  pass "detached restart completed START_DONE despite invoker teardown"
else
  fail "START_DONE never written -- detached restart did NOT survive"
fi
# The detached service's output landed in a file under the passed dir (this is
# exactly how the fix preserves restart evidence in store/restart.log).
if [ -s "$TMP/pos/restart.log" ] && grep -q "STOP_RAN" "$TMP/pos/restart.log"; then
  pass "restart evidence captured to the redirected log file"
else
  fail "redirected restart log is empty / missing STOP_RAN"
fi
# Confirm the failure mode was actually exercised: the invoker was killed, not
# allowed to exit on its own.
if [ -f "$TMP/invoker_pos.log" ] && ! grep -q "INVOKER_EXITED_NORMALLY" "$TMP/invoker_pos.log"; then
  pass "invoker was killed mid-restart (teardown genuinely fired)"
else
  fail "invoker exited normally -- teardown did not fire, positive case is not meaningful"
fi

# ---------------------------------------------------------------------------
# (2) NEGATIVE control -- a DIRECT in-cgroup stop;start does NOT survive.
#     Same teardown, only the launch shape differs -> isolates the fix.
# ---------------------------------------------------------------------------
echo ""
echo "(2) NEGATIVE control: direct in-cgroup call (the bug)"
make_dummies "$TMP/neg" "$INV_NEG"
cat > "$TMP/invoker_neg.sh" <<EOF
#!/bin/bash
echo "INVOKER_LAUNCHED" >> "$TMP/invoker_neg.log"
# BROKEN shape: direct stop;start as children of THIS invoker, inside the doomed
# scope. When stop.sh tears the scope down, start.sh never gets to run.
{ "$TMP/neg/stop.sh"; "$TMP/neg/start.sh"; } >> "$TMP/neg/restart.log" 2>&1
echo "INVOKER_EXITED_NORMALLY" >> "$TMP/invoker_neg.log"
EOF
chmod +x "$TMP/invoker_neg.sh"

systemd-run --user --scope --collect --quiet --unit="$INV_NEG" \
  bash "$TMP/invoker_neg.sh" >/dev/null 2>&1 || true

# Give start.sh well past its 2s window to (fail to) write, then assert absence.
sleep 4
if [ -f "$TMP/neg/restart.log" ] && grep -q "START_DONE" "$TMP/neg/restart.log"; then
  fail "direct in-cgroup restart wrote START_DONE -- negative control did NOT reproduce the self-kill"
else
  pass "direct in-cgroup restart did NOT complete START_DONE (self-kill reproduced)"
fi
# The invoker must have been killed here too (else the contrast is meaningless).
if [ -f "$TMP/invoker_neg.log" ] && ! grep -q "INVOKER_EXITED_NORMALLY" "$TMP/invoker_neg.log"; then
  pass "invoker was killed by its own stop.sh (in-cgroup teardown fired)"
else
  fail "invoker exited normally -- in-cgroup teardown did not fire"
fi

# ---------------------------------------------------------------------------
echo ""
echo "======================"
TOTAL=$((PASS + FAIL))
echo "Results: $PASS/$TOTAL passed"
if [ "$FAIL" -gt 0 ]; then echo "FAILED: $FAIL checks"; exit 1; fi
echo "All checks passed: the detached service survives the teardown that kills the in-cgroup call."
