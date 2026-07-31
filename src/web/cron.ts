import { CronExpressionParser } from 'cron-parser'
import { QUIET_START_HOUR, QUIET_END_HOUR } from '../quiet-hours.js'

// All scheduled-task cron expressions (SKILL.md/task-config.json, the
// dashboard schedule editor) are authored in the operator's own wall-clock
// time -- "30 7 * * *" means 7:30 for the operator, not 7:30 on whatever
// timezone the host happens to boot in. cron-parser defaults to the PROCESS
// timezone when no `tz` is given, which silently diverges from the
// operator's zone whenever the host runs in a different one (e.g. a UTC
// server for a Budapest operator misfires cron by 1-2h). SCHEDULER_TZ lets
// each install pin its own IANA zone; unset falls back to the host's zone
// (Intl reflects the OS/TZ env at process start), matching the pre-fix
// behaviour for installs where host tz already equals the operator's.
const CRON_TZ = process.env.SCHEDULER_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone

export function computeNextRun(cronExpression: string): number {
  const expr = CronExpressionParser.parse(cronExpression, { tz: CRON_TZ })
  return Math.floor(expr.next().getTime() / 1000)
}

// Accept 5-field (standard) and 6-field (with seconds) cron expressions;
// cron-parser supports both. Anything else -- oversized strings, random
// punctuation, empty fields -- gets rejected at the API boundary instead
// of reaching the parser deep inside the scheduler loop.
export const CRON_SHAPE_RX = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+(\S+))?$/

export function isValidCronShape(cron: unknown): cron is string {
  if (typeof cron !== 'string') return false
  const trimmed = cron.trim()
  if (!trimmed || trimmed.length > 100) return false
  if (!CRON_SHAPE_RX.test(trimmed)) return false
  try {
    const expr = CronExpressionParser.parse(trimmed, { tz: CRON_TZ })
    expr.next()
    return true
  } catch {
    return false
  }
}

// The runner's normal per-tick window: one 60s tick of tolerance around a
// slot. Exported so the runner and this module cannot drift apart on what
// "not enlarged" means.
export const NORMAL_CATCH_UP_MS = 60_000

export function cronMatchesNow(cron: string, catchUpMs: number = NORMAL_CATCH_UP_MS): boolean {
  try {
    const expr = CronExpressionParser.parse(cron, { tz: CRON_TZ })
    const prev = expr.prev()
    const prevTime = prev.getTime()
    const now = Date.now()
    return (now - prevTime) < catchUpMs
  } catch {
    return false
  }
}

// --- Tick-gap catch-up window ------------------------------------------------
//
// The runner ticks every 60s and asks cronMatchesNow(schedule, catchUpMs)
// whether a slot fell inside the window since it last looked. A 60s window is
// only correct while the ticks actually keep coming -- and they do NOT survive
// a host SUSPEND. On 2026-07-31 the WSL host slept 06:00-09:05 while the
// dashboard process (the runner's host) stayed up the whole time: no restart,
// so the isFirstRunTick catch-up never armed, and every slot inside the sleep
// (07:30 reggeli-napindito, 08:00 kanban-audit, 08:15 backup-upload, 09:00
// token-health plus 58 heartbeat slots) was lost without a single log line.
// The systemd timers rearmed themselves at 08:59 because they are
// Persistent=true; an in-process cron has no such mechanism. Second occurrence
// inside a week, and both times the operator -- not the fleet -- noticed.
//
// Fix: measure the wall-clock distance between consecutive ticks. A tick that
// lands more than TICK_GAP_THRESHOLD_MS after the previous one is a
// "gap-resume" tick and gets an enlarged window reaching back to the start of
// the gap, so slots missed while the host slept are seen -- exactly once.
//
// Deliberate properties, in the order they matter:
//
//   * ONE fire per schedule, never a replay. cronMatchesNow() answers a
//     BOOLEAN question ("was the most recent occurrence inside the window?"),
//     it does not enumerate occurrences -- so 38 missed `*/5` slots collapse
//     into a single fire. The runner's own `now - lastRun < catchUp` guard
//     then keeps the following normal tick from re-firing the same task.
//   * That same lastRun guard cannot swallow a LEGITIMATE catch-up: nothing
//     fires during the gap, so every task's lastRun is at or before
//     catchUpStart, hence `now - lastRun >= catchUpMs` and the guard passes.
//   * The catch-up NEVER reaches into the quiet band (QUIET_BAND_START_HOUR ->
//     QUIET_BAND_END_HOUR, operator-local). Waking at 03:00 must not dump the
//     evening's heartbeats into a sleeping operator's chat, and a daytime
//     resume must not resurrect last night's slots -- those were night slots
//     and staying missed IS the correct outcome.
//   * In-memory only, by design (the caller holds lastTickMs): a process
//     restart is already covered by the isFirstRunTick window, and a suspend
//     keeps the process -- and therefore the variable -- alive.

// A tick this much later than the previous one is treated as a host-sleep gap
// rather than ordinary scheduler jitter. Well above the 60s cadence plus the
// worst realistic tick duration (blocking tmux captures + idle waits), well
// below any schedule cadence we run.
export const TICK_GAP_THRESHOLD_MS = 5 * 60_000
// Quiet band in operator-local wall-clock time: no catch-up fires inside it,
// and no catch-up window may reach back into it. The 22/6 boundary is defined
// once in src/quiet-hours.ts (card 093ee62a) and aliased here, so the scheduler
// cannot drift from the notification paths that also gate on quiet hours.
export const QUIET_BAND_START_HOUR = QUIET_START_HOUR
export const QUIET_BAND_END_HOUR = QUIET_END_HOUR

export interface CatchUpWindow {
  /** Window to hand cronMatchesNow() on this tick. Never below NORMAL_CATCH_UP_MS. */
  catchUpMs: number
  /** Wall-clock distance from the previous tick (0 when there was none). */
  gapMs: number
  /** True when the window was enlarged because of a tick gap. */
  gapResume: boolean
  /** True when a real gap was detected but suppressed by the quiet band. */
  quietSkipped: boolean
}

// Local wall-clock hour/minute/second in `timeZone`. Returns null if the zone
// is unusable (a typo'd SCHEDULER_TZ makes Intl throw) so the caller can fall
// back to the conservative no-catch-up answer instead of killing the tick.
function localWallClock(
  ms: number,
  timeZone: string,
): { hour: number; minute: number; second: number } | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(ms))
    const get = (type: string): number => Number(parts.find(p => p.type === type)?.value ?? NaN)
    const hour = get('hour')
    const minute = get('minute')
    const second = get('second')
    if (!Number.isFinite(hour) || !Number.isFinite(minute) || !Number.isFinite(second)) return null
    return { hour, minute, second }
  } catch {
    return null
  }
}

// Decide the catch-up window for a tick. Pure: everything time-dependent is a
// parameter, so the quiet-band and gap edges are unit-tested without waiting
// for a real 06:00.
//
// lastTickMs is null on the very first tick of a process; the caller keeps its
// own (larger) first-run window for that case, so we return the normal one.
export function computeCatchUpWindow(
  nowMs: number,
  lastTickMs: number | null,
  timeZone: string = CRON_TZ,
): CatchUpWindow {
  const normal: CatchUpWindow = {
    catchUpMs: NORMAL_CATCH_UP_MS,
    gapMs: 0,
    gapResume: false,
    quietSkipped: false,
  }
  if (lastTickMs == null || !Number.isFinite(lastTickMs)) return normal

  const gapMs = nowMs - lastTickMs
  if (gapMs <= TICK_GAP_THRESHOLD_MS) return { ...normal, gapMs: Math.max(gapMs, 0) }

  const local = localWallClock(nowMs, timeZone)
  // Unusable zone -> we cannot prove we are outside the quiet band, so we do
  // not catch up. Losing a catch-up is recoverable; firing the night's
  // backlog into the operator's chat is not.
  if (!local) return { ...normal, gapMs, quietSkipped: true }

  if (local.hour >= QUIET_BAND_START_HOUR || local.hour < QUIET_BAND_END_HOUR) {
    // The gap-resume tick itself landed in the quiet band (the host woke at
    // 03:00). No catch-up at all: the missed slots were night slots.
    return { ...normal, gapMs, quietSkipped: true }
  }

  // Most recent local QUIET_BAND_END_HOUR:00:00 at or before now. We are
  // provably outside the quiet band here, so that boundary is today's. Derived
  // by subtracting the elapsed local time-of-day rather than by inverting the
  // zone offset: exact for every zone whose UTC offset does not change between
  // 06:00 and 22:00 local (i.e. all of them in practice -- DST transitions run
  // at night), and a 1h window-size error, not a wrong decision, if one ever did.
  const sinceBandEndMs =
    ((local.hour - QUIET_BAND_END_HOUR) * 3600 + local.minute * 60 + local.second) * 1000
    + (nowMs % 1000)
  const bandEndMs = nowMs - sinceBandEndMs
  const catchUpStart = Math.max(lastTickMs, bandEndMs)
  const catchUpMs = Math.max(NORMAL_CATCH_UP_MS, nowMs - catchUpStart)
  return {
    catchUpMs,
    gapMs,
    // A gap whose window collapses back to the normal one (the host woke a few
    // seconds past 06:00) is not a catch-up tick -- nothing was enlarged.
    gapResume: catchUpMs > NORMAL_CATCH_UP_MS,
    quietSkipped: false,
  }
}
