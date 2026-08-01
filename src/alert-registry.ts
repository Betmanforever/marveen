// Emitter registry: who is allowed to alert about what (audit AC-1/AC-2/AC-9).
//
// The 2026-07-31 audit counted 40 autonomous emitters that can reach the owner
// with no human in the loop, and found the same signal watched by three
// detectors with three thresholds and three private dedup stores -- so one stuck
// message produced three Telegram messages. Nothing in the system declared who
// OWNED a signal, so nothing could tell a duplicate from an independent finding.
//
// This file is that declaration. Exactly ONE enabled emitter may own a signal;
// the others are observers, which may log, append to the claim row and feed the
// digest, but must not send. `ownerFacing` marks the few emitters allowed to
// reach Gabor directly, and it is legal only when the alert names a decision
// only he can make.
//
// It lives in src/ rather than store/ on purpose: store/ is gitignored, so a
// registry there would not survive a fresh checkout and the guard test below
// would have nothing to check. It is CODE-adjacent policy, not runtime state.
//
// Coverage note: this pass populates the emitters card 8bcbd8fe touched plus
// their duplicates. The remaining ~33 of the audit's 40 are follow-up work
// (audit section 1 has the full inventory).

export type AlertRouteTarget = 'coordinator' | 'owner' | 'digest' | 'log-only'

export interface AlertEmitter {
  /** Stable id of the emitting code path. */
  id: string
  /** The SIGNAL it reports on. Exactly one enabled owner per signal. */
  signalId: string
  /** Source file (and, where it helps, the anchor within it). */
  source: string
  /** True = this emitter decides; false = it may only observe (AC-1). */
  owner: boolean
  /** Where its findings go by default. */
  route: AlertRouteTarget
  /** May it reach the owner directly? Only with a decision he alone can make. */
  ownerFacing: boolean
  /** Detection threshold, in words. */
  threshold: string
  /** What its dedup / re-arm is keyed on. */
  dedupKey: string
  /** How 22:00-06:00 is honoured (audit AC-9). */
  quietHours: string
  /** false = present but not running (systemd timer disabled, etc.). */
  enabled: boolean
  notes?: string
}

export const ALERT_REGISTRY: AlertEmitter[] = [
  // --- queue-starving: three emitters, one signal (audit RC-4) ---------------
  {
    id: 'dashboard-pending-age-watchdog',
    signalId: 'queue-starving',
    source: 'src/web/pending-age-watchdog.ts (called from channel-monitor.ts)',
    owner: true,
    route: 'coordinator',
    ownerFacing: true,
    threshold: 'pending > 3 min AND target pane unchanged across 2 sweeps (P3)',
    dedupKey: 'sorted stuck message ids; alert-state emits + alert_claims row per message',
    quietHours: 'owner leg via sendAlert -> buffered, morning summary',
    enabled: true,
    notes: 'ownerFacing only through the AC-5 coordinator-silence escalation, once per episode.',
  },
  {
    id: 'host-inbox-starvation-timer',
    signalId: 'queue-starving',
    source: 'scripts/pending-inbox-starvation-timer.sh',
    owner: false,
    route: 'coordinator',
    ownerFacing: false,
    threshold: 'pull-mode message pending > 10 min (no busy detection -- audit RC-3)',
    dedupKey: 'store/.pending-inbox-starvation.state, keyed on the starving id set',
    quietHours: 'OnCalendar 06..21 only; sends route to the coordinator',
    enabled: false,
    notes: 'systemd timer disabled 2026-07-31 16:52. Converted to a dashboard-DOWN backstop: '
      + 'while the dashboard answers, findings go to the coordinator and never to Gabor.',
  },
  {
    id: 'pending-uzenet-watchdog',
    signalId: 'queue-starving',
    source: '~/.claude/scheduled-tasks/pending-uzenet-watchdog (mr-wolfe)',
    owner: false,
    route: 'coordinator',
    ownerFacing: true,
    threshold: 'pending > 3 min AND wedge pattern (busy-but-working pane is explicitly not a finding), */5 06-21',
    dedupKey: 'agent judgement + alert_claims lookup (defers to the dashboard owner\'s live claim)',
    quietHours: 'cron 06-21 only',
    enabled: true,
    notes: 'SKILL.md reworked 2026-07-31 (neo draft, mr-wolfe applied): remediation-first '
      + '(Escape/parked-clear/nudge, continue-restart on context ceiling) under Gabor\'s blanket '
      + 'silent-fixing authorization; ownerFacing only for a NAMED decision after remediation '
      + 'failed twice, per AC-2. The coordinator RUNS this task, so its coordinator route is itself.',
  },

  // --- ritual execution ------------------------------------------------------
  {
    id: 'host-ritual-execution-timer',
    signalId: 'ritual-missed',
    source: 'scripts/ritual-execution-timer.sh',
    owner: true,
    route: 'coordinator',
    ownerFacing: false,
    threshold: 'fixed-time ritual with no dispatch/execution evidence 90 min past its slot',
    dedupKey: 'store/.ritual-execution.state, md5 of the missed-ritual name set',
    quietHours: 'OnCalendar 06..21 only',
    enabled: true,
    notes: 'Audit (b): mr-wolfe owns the schedule and can re-fire it. Owner path only when '
      + 'the dashboard is unreachable (backstop role).',
  },

  // --- model identity --------------------------------------------------------
  {
    id: 'host-model-drift-timer',
    signalId: 'model-drift',
    source: 'scripts/model-drift-timer.sh -> scripts/check-model-drift.sh',
    owner: false,
    route: 'coordinator',
    ownerFacing: false,
    threshold: 'latest interactive session boot model != configured (P1+P2 filtered)',
    dedupKey: 'store/.model-drift.state, md5 of the agent/measured/configured set',
    quietHours: 'OnCalendar 06..21 only',
    enabled: false,
    notes: 'Timer disabled 2026-07-31 16:52 (audit endorses detector A retirement). Script kept '
      + 'and P1/P2-hardened as a dashboard-down backstop; re-enabling is an operator decision.',
  },
  {
    id: 'dashboard-model-fallback-runner',
    signalId: 'model-drift',
    source: 'src/web/model-fallback-runner.ts (checkModelDrift / checkMidSessionDrift)',
    owner: true,
    route: 'coordinator',
    ownerFacing: false,
    threshold: 'boot-window drift -> auto-correct; mid-session drift -> coordinator alert',
    dedupKey: 'per-agent in-runner state + config_change_log provenance rows',
    quietHours: 'coordinator route, no owner leg',
    enabled: true,
    notes: 'Audit section 5: anchored to the live tmux session, entrypoint-filtered, '
      + 'already-recovered veto. Endorsed as the owner of this signal.',
  },
  {
    id: 'model-ledger-reconcile',
    signalId: 'model-ledger-gap',
    source: 'scripts/check-model-ledger-reconcile.sh',
    owner: true,
    route: 'coordinator',
    ownerFacing: false,
    threshold: 'session-boundary model switch with no config_change_log entry (-12h..+2h)',
    dedupKey: 'store/.model-ledger-reconcile.state, md5 of the finding set',
    quietHours: 'daily 07:47 slot, outside the band',
    enabled: false,
    notes: 'Audit AC-10: the governance half of the retired drift check, rehomed as its own '
      + 'silent daily control. Unit files installed but NOT enabled (operator decision).',
  },

  // --- backup legs -----------------------------------------------------------
  {
    id: 'weekly-elocal-backup',
    signalId: 'backup-elocal-leg',
    source: 'scripts/weekly-elocal-backup.py',
    owner: true,
    route: 'coordinator',
    ownerFacing: false,
    threshold: '3 consecutive weekly runs with the drive absent (marker-UUID + write-probe gate), '
      + 'ANY read-back digest mismatch (immediately, every occurrence), a failed monthly restore '
      + 'rehearsal, or entering any other failure state',
    dedupKey: 'store/.weekly-elocal.state: consecutive_misses plus an `alerted` flag that stays '
      + 'set until recovery, so an absent drive is reported once and not weekly',
    quietHours: 'OnCalendar Sun 19:00 (+<=5 min jitter) is outside 22:00-06:00 by construction; '
      + 'every send is an /api/messages inter-agent message to mr-wolfe, no direct Bot API path',
    enabled: true,
    notes: 'Audit 2026-07-31 section 6(b), Tier 1 only (Tier 2 gated on Gabor\'s key-custody '
      + 'decision). A successful week writes the daily log and sends nothing (AC-D4). Unit files '
      + 'are in scripts/systemd/; `enabled` records the intended landed state, and the operator '
      + 'step that makes it true is `systemctl --user enable --now marveen-weekly-elocal.timer` -- '
      + 'if that is not done, flip this to false, the field means "running", not "exists". '
      + 'One inherited leak: on a rehearsal FAIL the nightly-memory-backup.py child emits its own '
      + 'direct Bot API alert; not suppressed on purpose (disarming another control from the '
      + 'outside is worse), and 19:00 is outside the window.',
  },

  // --- host guards (audit C-1, card 5e68c5e1: coordinator-first since c6f466b)
  {
    id: 'host-worker-guard',
    signalId: 'agent-worker-failure',
    source: 'scripts/worker-guard.sh (notify)',
    owner: true,
    route: 'coordinator',
    ownerFacing: false,
    threshold: 'dashboard.log line matches "worker not ready|Failed to generate agent" '
      + '(event-driven tail -F, zero polling)',
    dedupKey: 'in-process debounce, at most one action per 120s (DEBOUNCE_SEC)',
    quietHours: 'coordinator via /api/messages while the dashboard answers; direct Bot API '
      + 'only as the dashboard-down backstop, 22-06 deferred to host-watchdog.log -- the '
      + 'guard keeps running, so a persisting failure re-alerts after 06:00',
    enabled: true,
    notes: 'Also remediates (kill + relaunch of a dirty marveen-worker pane) before alerting; '
      + 'the alert reports the self-heal, it does not ask for one.',
  },
  {
    id: 'host-stuck-modal-guard',
    signalId: 'channels-stuck-modal',
    source: 'scripts/stuck-modal-guard.sh (alert_owner)',
    owner: true,
    route: 'coordinator',
    ownerFacing: false,
    threshold: 'main channels pane classifies STUCK (no idle footer, no busy marker -- '
      + 'src/pane-state.ts contract) and persists >= 120s (2 consecutive 1-min ticks)',
    dedupKey: 'store/.stuck-modal-firstseen + .stuck-modal-backoff-alerted; respawn grace '
      + 'stamp SHARED with channel-watchdog.sh (no double-respawn storm)',
    quietHours: 'coordinator via /api/messages while the dashboard answers; direct Bot API '
      + 'only as the dashboard-down backstop, 22-06 deferred to the log -- the timer loops, '
      + 'so a persisting modal re-alerts after 06:00',
    enabled: true,
    notes: 'Remediation-first: bounded Escape, then respawn-pane; alerts only after '
      + 'MAX_CONSECUTIVE=3 respawns force backoff (self-heal failed, not on first sight).',
  },
  {
    id: 'host-disk-space-guard',
    signalId: 'host-disk-full',
    source: 'scripts/disk-space-guard.sh (alert)',
    owner: true,
    route: 'coordinator',
    ownerFacing: false,
    threshold: 'root usage >= 90% triggers allowlisted scratch reap; still >= 95% AFTER '
      + 'the reap triggers the alert',
    dedupKey: 'store/.disk-guard-alerted cooldown stamp, at most one alert per 3600s',
    quietHours: 'coordinator via /api/messages while the dashboard answers; direct Bot API '
      + 'only as the dashboard-down backstop, 22-06 deferred to the log. Under disk-FULL the '
      + 'dashboard API may itself fail -- that is the designed fall-through to the backstop.',
    enabled: true,
    notes: 'The 2026-06-03 disk-full incident guard. Reap is allowlist+age-guarded; every '
      + 'stamp write is best-effort under ENOSPC.',
  },
  {
    id: 'host-restart-watchdog',
    signalId: 'host-restart',
    source: 'scripts/host-restart-watchdog.sh',
    owner: true,
    route: 'coordinator',
    ownerFacing: false,
    threshold: '/proc/stat btime changed since the stored baseline (whole-VM/host reboot; '
      + 'app crashes never change btime and are the OnFailure= drop-ins\' job)',
    dedupKey: 'store/.last-btime baseline -- structurally at most one alert per boot',
    quietHours: 'oneshot races the dashboard at boot, so it waits up to 60s for it; then '
      + 'coordinator via /api/messages. Backstop leg 22-06 defers to the journal only (a '
      + 'oneshot has no re-run; the down dashboard is what the morning round surfaces).',
    enabled: true,
    notes: 'Informational machine fact (host/WSL-VM restart + estimated downtime), never a '
      + 'decision -- ownerFacing false by construction.',
  },

  // --- shared transports -----------------------------------------------------
  {
    id: 'notify-sh',
    signalId: 'transport-host-backstop',
    source: 'scripts/notify.sh',
    owner: true,
    route: 'owner',
    ownerFacing: true,
    threshold: 'n/a -- transport, not a detector',
    dedupKey: 'n/a (each caller dedups)',
    quietHours: 'EXEMPT: callers are OnCalendar-gated to 06..21, and its whole purpose is to '
      + 'work when the dashboard (and with it sendAlert + quiet-hours buffering) is down',
    enabled: true,
    notes: 'AC-9 exemption, stated reason above. The only sanctioned direct Bot API path for '
      + 'host scripts; a script may use it ONLY after the dashboard probe fails.',
  },
]

export interface RegistryConflict {
  signalId: string
  emitters: string[]
}

/**
 * Signals with more than one ENABLED owner (audit AC-1). Disabled emitters are
 * ignored: a retired-but-present script is not a duplicate alert.
 */
export function findDuplicateSignalOwners(registry: AlertEmitter[] = ALERT_REGISTRY): RegistryConflict[] {
  const bySignal = new Map<string, string[]>()
  for (const e of registry) {
    if (!e.enabled || !e.owner) continue
    bySignal.set(e.signalId, [...(bySignal.get(e.signalId) ?? []), e.id])
  }
  return [...bySignal.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([signalId, emitters]) => ({ signalId, emitters }))
}

/** Emitters allowed to reach the owner directly (audit AC-2 keeps this small). */
export function ownerFacingEmitters(registry: AlertEmitter[] = ALERT_REGISTRY): AlertEmitter[] {
  return registry.filter((e) => e.enabled && e.ownerFacing)
}
