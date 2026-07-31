#!/usr/bin/env bash
# Silent-if-clean watchdog for the DAILY RITUALS (card 1945ac7b): did each
# fixed-time scheduled task actually happen today? Three failure modes drove
# this, each observed live:
#   (A) 2026-07-29 dream-engine: the runner NEVER dispatched the slot (no
#       schedule-last-run.json entry) -- dispatch-side loss.
#   (B) 2026-07-29 reggeli-napindito: dispatched, prompt delivered, but the
#       assistant turn ended with zero tool calls -- execution-side loss,
#       invisible to any dispatch-side record.
#   (C) 2026-07-31 host sleep 06:00-09:05: the in-process cron missed every
#       slot. The runner now has Persistent-style gap catch-up (99b6fc9), but
#       a net outside the runner must not trust the runner it watches.
# Both times GABOR noticed first. This timer exists so the fleet notices.
#
# Agent-independent host (same rationale as pending-inbox-starvation-timer.sh):
# a control living inside an agent's turn cycle is unreachable exactly when
# that agent is the fault.
#
# Evidence model, two layers per ritual:
#   1. DISPATCH evidence (modes A+C), generic: every enabled task-config.json
#      whose cron is a FIXED daily/weekly time ("M H * * *" or "M H * * D")
#      must have a schedule-last-run.json entry at/after today's slot, once
#      the slot is GRACE_MIN past. Interval crons (*/N) are heartbeats with
#      their own inbox-starvation net -- skipped here.
#   2. EXECUTION evidence (mode B), opt-in registry: rituals whose PROMPT ends
#      by writing store/<name>-state.json (after the real deliverable, e.g.
#      the Telegram send) are also checked for that file being fresh today.
#      Registration is the EVIDENCE_FILES map below; a ritual not listed is
#      only covered at layer 1. The prompt-side append is the task owner's
#      (mr-wolfe's) edit, not this script's.
#
# Output contract: silent + exit 0 when clean; findings on stdout + exit 1.
# The caller (ritual-execution-timer.sh) dedups and alerts via notify.sh.
set -euo pipefail

REPO="/home/szabgabor/marveen"
TASKS_DIR="$HOME/.claude/scheduled-tasks"
LAST_RUN="$REPO/store/schedule-last-run.json"
GRACE_MIN="${GRACE_MIN:-90}"

python3 - "$REPO" "$TASKS_DIR" "$LAST_RUN" "$GRACE_MIN" <<'PYEOF'
import json
import os
import re
import sys
import time

repo, tasks_dir, last_run_path, grace_min = sys.argv[1:5]
grace_s = int(grace_min) * 60
now = time.time()
lt = time.localtime(now)
today_start = time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, 0, 0, 0, 0, 0, -1))

# Mode-B execution-evidence registry: ritual name -> state file the task's own
# prompt writes AFTER its deliverable. Empty entries are added as mr-wolfe
# appends the state-write line to each ritual's prompt.
EVIDENCE_FILES = {
    "dream-engine": "store/dream-engine-state.json",
    "reggeli-napindito": "store/napindito-state.json",
}

try:
    with open(last_run_path) as f:
        last_run = json.load(f)
except Exception:
    last_run = {}

def last_run_s(name):
    v = last_run.get(name, 0)
    return v / 1000 if v > 1e12 else v  # ms or s, both seen in the wild

problems = []
for name in sorted(os.listdir(tasks_dir)):
    cfg_path = os.path.join(tasks_dir, name, "task-config.json")
    if not os.path.isfile(cfg_path):
        continue
    try:
        with open(cfg_path) as f:
            cfg = json.load(f)
    except Exception:
        problems.append(f"  - {name}: task-config.json nem parse-olhato")
        continue
    if cfg.get("enabled") is False:
        continue
    sched = str(cfg.get("schedule", "")).strip()
    # Fixed-time crons only: "M H * * *" (daily) or "M H * * D[-D|,D...]".
    m = re.match(r"^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+([\d,\-]+|\*)$", sched)
    if not m:
        continue  # interval/heartbeat or exotic -- not this net's job
    minute, hour, dow = int(m.group(1)), int(m.group(2)), m.group(3)
    if dow != "*":
        allowed = set()
        for part in dow.split(","):
            if "-" in part:
                a, b = part.split("-")
                allowed.update(range(int(a), int(b) + 1))
            else:
                allowed.add(int(part))
        # cron dow: 0/7=Sunday; python tm_wday: 0=Monday
        cron_today = (lt.tm_wday + 1) % 7
        if cron_today not in allowed and not (cron_today == 0 and 7 in allowed):
            continue  # not scheduled today
    slot = today_start + hour * 3600 + minute * 60
    if now < slot + grace_s:
        continue  # not yet due (or within grace)
    if last_run_s(name) < slot:
        problems.append(
            f"  - {name}: a mai {hour:02d}:{minute:02d} slot ota nincs diszpecseles-nyom "
            f"(schedule-last-run: {time.strftime('%m-%d %H:%M', time.localtime(last_run_s(name))) if last_run_s(name) else 'soha'})")
        continue
    # Layer 2: execution evidence, where registered. Self-activating: checked
    # only once the file EXISTS at all -- i.e. the ritual's prompt has started
    # writing it. Until mr-wolfe appends the state-write line to a ritual's
    # prompt, that ritual is covered at layer 1 only, with no false alarms.
    # (Trade-off: deleting the file silently drops layer-2 coverage; accepted
    # for the bootstrap, the file has no other reason to disappear.)
    ev = EVIDENCE_FILES.get(name)
    if ev:
        ev_path = os.path.join(repo, ev)
        if os.path.isfile(ev_path) and os.path.getmtime(ev_path) < slot:
            problems.append(
                f"  - {name}: diszpecselve, de a vegrehajtas-bizonyitek ({ev}) "
                f"nem frissult a mai {hour:02d}:{minute:02d} slot ota -- nema no-op gyanu")

if problems:
    print(f"RITUALE-KIMARADAS ({time.strftime('%Y-%m-%d %H:%M')}, grace {grace_min} perc):")
    for p in problems:
        print(p)
    sys.exit(1)
sys.exit(0)
PYEOF
