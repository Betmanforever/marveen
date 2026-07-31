import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  computeCatchUpWindow,
  NORMAL_CATCH_UP_MS,
  QUIET_BAND_END_HOUR,
  QUIET_BAND_START_HOUR,
  TICK_GAP_THRESHOLD_MS,
} from '../web/cron.js'

// Tests for the tick-gap catch-up (host-suspend blindness).
//
// 2026-07-31: the WSL host slept 06:00-09:05 while the dashboard process --
// the schedule runner's host -- stayed alive the whole time. No restart, so
// the isFirstRunTick catch-up never armed, the 60s per-tick window saw nothing
// on resume, and every slot inside the sleep (07:30 reggeli-napindito, 08:00
// kanban-audit, 08:15 backup-upload, 09:00 token-health, plus 58 heartbeat
// slots) vanished with no log line. Second occurrence in a week; the operator,
// not the fleet, noticed both.
//
// Everything time-dependent is injected, so nothing here depends on the clock
// or the timezone of the machine running the suite.

const RUNNER_SRC = readFileSync(join(__dirname, '../web/schedule-runner.ts'), 'utf-8')

const TZ = 'Europe/Budapest'
const MIN = 60_000
const HOUR = 60 * MIN

// Europe/Budapest is UTC+2 in July (CEST). Local wall-clock is written in the
// helper names; the ISO strings stay UTC so the fixtures are unambiguous.
const at = (iso: string): number => Date.parse(iso)

const SUMMER_RESUME_0905 = at('2026-07-31T07:05:00.000Z') // 09:05 local
const SUMMER_LASTTICK_0600 = at('2026-07-31T04:00:00.000Z') // 06:00 local
const SUMMER_GAP_MS = SUMMER_RESUME_0905 - SUMMER_LASTTICK_0600 // 3h05m

describe('computeCatchUpWindow: gap detection', () => {
  it('(d) a sub-threshold gap keeps the normal one-tick window', () => {
    const now = at('2026-07-31T12:00:00.000Z') // 14:00 local
    const w = computeCatchUpWindow(now, now - 4 * MIN, TZ)
    expect(w.catchUpMs).toBe(NORMAL_CATCH_UP_MS)
    expect(w.gapResume).toBe(false)
    expect(w.quietSkipped).toBe(false)
    expect(w.gapMs).toBe(4 * MIN)
  })

  it('a gap of EXACTLY the threshold is still ordinary jitter, one ms more is a gap', () => {
    const now = at('2026-07-31T12:00:00.000Z') // 14:00 local
    expect(computeCatchUpWindow(now, now - TICK_GAP_THRESHOLD_MS, TZ).gapResume).toBe(false)
    expect(computeCatchUpWindow(now, now - TICK_GAP_THRESHOLD_MS - 1, TZ).gapResume).toBe(true)
  })

  it('(a) a daytime gap between two daytime ticks yields exactly the gap', () => {
    const lastTick = at('2026-07-31T11:00:00.000Z') // 13:00 local
    const now = at('2026-07-31T12:30:00.000Z') // 14:30 local
    const w = computeCatchUpWindow(now, lastTick, TZ)
    expect(w.gapResume).toBe(true)
    expect(w.quietSkipped).toBe(false)
    expect(w.gapMs).toBe(90 * MIN)
    expect(w.catchUpMs).toBe(90 * MIN)
  })

  it('reproduces the 2026-07-31 incident: 06:00 -> 09:05 resume gets a 3h05m window', () => {
    const w = computeCatchUpWindow(SUMMER_RESUME_0905, SUMMER_LASTTICK_0600, TZ)
    expect(w.gapResume).toBe(true)
    expect(w.gapMs).toBe(SUMMER_GAP_MS)
    expect(w.catchUpMs).toBe(SUMMER_GAP_MS)
  })

  it('no previous tick (first tick of the process) means no gap window', () => {
    const w = computeCatchUpWindow(SUMMER_RESUME_0905, null, TZ)
    expect(w.catchUpMs).toBe(NORMAL_CATCH_UP_MS)
    expect(w.gapResume).toBe(false)
    expect(w.gapMs).toBe(0)
  })
})

describe('computeCatchUpWindow: quiet band', () => {
  it('(b) a gap spanning the night is clipped at the local band end, not replayed whole', () => {
    const lastTick = at('2026-07-30T21:00:00.000Z') // 23:00 local, previous day
    const now = at('2026-07-31T07:00:00.000Z') // 09:00 local
    const w = computeCatchUpWindow(now, lastTick, TZ)
    expect(w.gapMs).toBe(10 * HOUR)
    // Reaches back to 06:00 local only -- the 23:00-06:00 slots stay missed.
    expect(w.catchUpMs).toBe(3 * HOUR)
    expect(w.gapResume).toBe(true)
    expect(w.quietSkipped).toBe(false)
  })

  it('(c) waking INSIDE the quiet band performs no catch-up at all', () => {
    const lastTick = at('2026-07-30T20:30:00.000Z') // 22:30 local
    const now = at('2026-07-31T01:00:00.000Z') // 03:00 local
    const w = computeCatchUpWindow(now, lastTick, TZ)
    expect(w.catchUpMs).toBe(NORMAL_CATCH_UP_MS)
    expect(w.gapResume).toBe(false)
    expect(w.quietSkipped).toBe(true)
    expect(w.gapMs).toBe(4.5 * HOUR)
  })

  it('the band closes at 22:00 local and opens at 06:00 local', () => {
    const gap = (nowIso: string) =>
      computeCatchUpWindow(at(nowIso), at(nowIso) - 2 * HOUR, TZ)
    expect(QUIET_BAND_START_HOUR).toBe(22)
    expect(QUIET_BAND_END_HOUR).toBe(6)
    // 21:59 local -- still a working hour, catch-up allowed.
    expect(gap('2026-07-31T19:59:00.000Z').quietSkipped).toBe(false)
    // 22:00 local sharp -- quiet.
    expect(gap('2026-07-31T20:00:00.000Z').quietSkipped).toBe(true)
    // 05:59 local -- quiet.
    expect(gap('2026-07-31T03:59:00.000Z').quietSkipped).toBe(true)
    // 06:00 local sharp -- open again (though the window is clipped to ~0).
    expect(gap('2026-07-31T04:00:00.000Z').quietSkipped).toBe(false)
  })

  it('waking just past 06:00 collapses back to the normal window, not a catch-up tick', () => {
    const now = at('2026-07-31T04:00:30.000Z') // 06:00:30 local
    const lastTick = at('2026-07-31T03:00:00.000Z') // 05:00 local
    const w = computeCatchUpWindow(now, lastTick, TZ)
    // Only 30s of the gap is outside the quiet band -> nothing was enlarged.
    expect(w.catchUpMs).toBe(NORMAL_CATCH_UP_MS)
    expect(w.gapResume).toBe(false)
    expect(w.quietSkipped).toBe(false)
  })

  it('the band end is derived from local wall-clock, so CET and CEST behave alike', () => {
    // Same 06:00 -> 09:05 shape in January (Europe/Budapest is UTC+1 then).
    const now = at('2026-01-15T08:05:00.000Z') // 09:05 local
    const lastTick = at('2026-01-15T05:00:00.000Z') // 06:00 local
    const w = computeCatchUpWindow(now, lastTick, TZ)
    expect(w.catchUpMs).toBe(SUMMER_GAP_MS)
    expect(w.gapResume).toBe(true)
  })

  it('an unusable timezone fails SAFE (no catch-up) instead of throwing', () => {
    const w = computeCatchUpWindow(SUMMER_RESUME_0905, SUMMER_LASTTICK_0600, 'Not/AZone')
    expect(w.catchUpMs).toBe(NORMAL_CATCH_UP_MS)
    expect(w.gapResume).toBe(false)
    expect(w.quietSkipped).toBe(true)
  })
})

// The two invariants the enlarged window rests on. Verified against the real
// cron matcher and the real fleet schedules rather than assumed, because both
// are the difference between "catch up once" and "replay three hours".
describe('an enlarged window fires ONCE and never replays', () => {
  let cron: typeof import('../web/cron.js')

  beforeAll(async () => {
    // cron.ts freezes CRON_TZ at import from SCHEDULER_TZ (or the host zone),
    // so pin the zone and re-import to keep this suite host-independent.
    vi.stubEnv('SCHEDULER_TZ', TZ)
    vi.resetModules()
    cron = await import('../web/cron.js')
  })
  afterAll(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(SUMMER_RESUME_0905))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('cronMatchesNow is a boolean "was the last occurrence inside the window", not an enumeration', () => {
    // pending-uzenet-watchdog: 37 of its slots fell inside the 3h05m sleep.
    // The matcher still answers with a single boolean, and the runner does one
    // attemptFireTask per matching task per tick -- so 37 missed slots become
    // exactly one fire, never 37 prompts dumped into the session.
    const match = cron.cronMatchesNow('*/5 6-21 * * *', SUMMER_GAP_MS)
    expect(typeof match).toBe('boolean')
    expect(match).toBe(true)
  })

  it('slots swallowed by the sleep match the enlarged window but not the normal one', () => {
    for (const schedule of [
      '*/5 6-21 * * *', // pending-uzenet-watchdog
      '*/15 6-21 * * *', // memoria-heartbeat
      '30 7 * * *', // reggeli-napindito
      '0 8 * * *', // kanban-audit (08:00 slot)
      '15 8 * * *', // backup-offsite-upload-wolfe
      '0 9 * * *', // gmail-personal-token-health
    ]) {
      expect(cron.cronMatchesNow(schedule, SUMMER_GAP_MS)).toBe(true)
      // Not matched by the normal window -> the runner stamps it 'fired_late'.
      expect(cron.cronMatchesNow(schedule, NORMAL_CATCH_UP_MS)).toBe(false)
    }
  })

  it('a slot the PREVIOUS tick already fired falls outside the new window', () => {
    // The window starts exactly at the previous tick, so any slot that tick
    // could have matched is >= catchUpMs old and cannot match again. This is
    // what makes a false gap-resume harmless: if a slow tick (rather than a
    // real suspend) trips the threshold, the enlarged window still only picks
    // up slots that genuinely went unserved.
    expect(cron.cronMatchesNow('0 6 * * *', SUMMER_GAP_MS)).toBe(false) // slot AT the last tick
    expect(cron.cronMatchesNow('59 5 * * *', SUMMER_GAP_MS)).toBe(false) // slot just before it
  })

  it('slots OUTSIDE the window are not resurrected', () => {
    // dream-engine fired at 20:15 the previous evening -- far outside a window
    // that is clipped at 06:00 local.
    expect(cron.cronMatchesNow('15 20 * * *', SUMMER_GAP_MS)).toBe(false)
    // A weekly job whose day is not today.
    expect(cron.cronMatchesNow('30 6 * * 3', SUMMER_GAP_MS)).toBe(false)
  })
})

// The runner guards a double fire with `now - lastRun < catchUp`. Widening the
// window widens that guard too, so the question Wolfe raised is whether the
// guard can now SWALLOW a legitimate catch-up. It cannot, and the boundary is
// exact -- pinned here with the same arithmetic the runner uses.
describe('the lastRun guard neither double-fires nor swallows a catch-up', () => {
  const skippedByGuard = (now: number, lastRun: number, catchUp: number): boolean =>
    now - lastRun < catchUp

  it('does not swallow a task whose last run is exactly at the start of the gap', () => {
    // Worst case: the task fired on the very last tick before the host slept.
    // now - lastRun == catchUp, and the guard is a strict `<`, so it passes.
    expect(skippedByGuard(SUMMER_RESUME_0905, SUMMER_LASTTICK_0600, SUMMER_GAP_MS)).toBe(false)
  })

  it('cannot swallow anything that last ran before the gap started', () => {
    // Nothing fires while the host is asleep, so every lastRun is at or before
    // catchUpStart -- i.e. now - lastRun >= catchUp for the whole fleet.
    for (const minutesBeforeGap of [0, 1, 30, 24 * 60]) {
      const lastRun = SUMMER_LASTTICK_0600 - minutesBeforeGap * MIN
      expect(skippedByGuard(SUMMER_RESUME_0905, lastRun, SUMMER_GAP_MS)).toBe(false)
    }
  })

  it('still blocks the very next normal tick from re-firing the catch-up', () => {
    const nextTick = SUMMER_RESUME_0905 + 30_000
    expect(skippedByGuard(nextTick, SUMMER_RESUME_0905, NORMAL_CATCH_UP_MS)).toBe(true)
  })

  it('the runner still uses that exact guard expression', () => {
    // If this drifts, the arithmetic above stops describing production.
    expect(RUNNER_SRC).toMatch(/if \(now - lastRun < catchUp\) continue/)
  })
})

describe('schedule-runner wiring', () => {
  it('keeps the previous tick time in the runner closure (in-memory by design)', () => {
    expect(RUNNER_SRC).toMatch(/let lastTickAt: number \| null = null/)
    // Stamped from the tick's own start time, immediately after the decision.
    expect(RUNNER_SRC).toMatch(/computeCatchUpWindow\(now, lastTickAt\)/)
    expect(RUNNER_SRC).toMatch(/lastTickAt = now/)
    // NOT persisted: schedule-last-run.json is the only runner state on disk.
    expect(RUNNER_SRC).not.toMatch(/lastTickAt[\s\S]{0,80}atomicWriteFileSync/)
  })

  it('takes the wider of the first-run and gap windows, preserving first-run semantics', () => {
    expect(RUNNER_SRC).toMatch(/const FIRST_RUN_CATCH_UP_MS = 30 \* 60000/)
    expect(RUNNER_SRC).toMatch(
      /Math\.max\(isFirstRunTick \? FIRST_RUN_CATCH_UP_MS : NORMAL_CATCH_UP_MS, gap\.catchUpMs\)/,
    )
  })

  it('marks gap-resume fires late too, not just first-run ones', () => {
    // The old condition was `isFirstRunTick && catchUp > 60000 && ...`, which
    // left a gap-resume fire recorded as an ordinary 'fired'.
    const idx = RUNNER_SRC.indexOf('const lateCatchUpMs =')
    expect(idx).toBeGreaterThan(0)
    const expr = RUNNER_SRC.slice(idx, idx + 200)
    expect(expr).toMatch(/catchUp > NORMAL_CATCH_UP_MS/)
    expect(expr).toMatch(/!cronMatchesNow\(task\.schedule, NORMAL_CATCH_UP_MS\)/)
    expect(expr).not.toMatch(/isFirstRunTick/)
  })

  it('logs the gap, the effective window and the catch-up fire count', () => {
    const idx = RUNNER_SRC.indexOf('if (gap.gapResume) {')
    expect(idx).toBeGreaterThan(0)
    const block = RUNNER_SRC.slice(idx, idx + 900)
    expect(block).toMatch(/logger\.info/)
    expect(block).toMatch(/gapMinutes/)
    expect(block).toMatch(/effectiveCatchUpMinutes/)
    expect(block).toMatch(/catchUpFires/)
    // The quiet-band suppression is logged too -- a silent no-op is what made
    // the original incident invisible.
    expect(block).toMatch(/gap\.quietSkipped/)
  })
})
