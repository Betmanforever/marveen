import { describe, it, expect } from 'vitest'
import { shouldNotify } from '../heartbeat.js'

// Heartbeat notification filter under the fleet-wide quiet hours
// (22:00-06:00 Europe/Budapest, Gabor's 2026-07-30 standing rule).
//
// Two holes are closed here:
//  - the window used to start at 22:00 for kanban noise only, while the
//    dbWarning branch returned true BEFORE the gate -- a 100+ MB DB paged the
//    owner at 03:00 every single hourly heartbeat;
//  - the hour came from data.timestamp.getHours() (host TZ), not from an
//    explicit Europe/Budapest conversion.
//
// dbWarning may be suppressed without losing anything because it is STATE, not
// an event: every heartbeat run recomputes it, so the first run after 06:00
// alerts again if the DB is still oversized.

function data(o: {
  timestamp: Date
  urgent?: number
  waiting?: number
  dbWarning?: boolean
}) {
  return {
    timestamp: o.timestamp,
    calendar: [],
    kanban: {
      urgent: o.urgent ?? 0,
      in_progress: 0,
      waiting: o.waiting ?? 0,
      urgentTitles: [],
      waitingTitles: [],
    },
    system: { dbSizeMB: o.dbWarning ? 120 : 12, dbWarning: o.dbWarning ?? false },
    tasks: { count: 0, nextRun: null },
  }
}

// Nyari idoszamitas (CEST = UTC+2), 2026-07-15 = szerda (nem hetvege).
const at = (budapestHour: number, minute = 0): Date =>
  new Date(Date.UTC(2026, 6, 15, budapestHour - 2, minute))

describe('heartbeat shouldNotify -- ejjeli csendes sav', () => {
  it('03:00-kor urgent kanban-kartya mellett sem ertesit', () => {
    expect(shouldNotify(data({ timestamp: at(3), urgent: 3 }))).toBe(false)
  })

  it('03:00-kor dbWarning mellett SEM ertesit (ez volt a lyuk: a dbWarning a kapu elott return-olt)', () => {
    expect(shouldNotify(data({ timestamp: at(3), dbWarning: true }))).toBe(false)
  })

  it('22:30-kor mar csend van (a sav 23:00-rol 22:00-ra kerult), dbWarninggal is', () => {
    expect(shouldNotify(data({ timestamp: at(22, 30), dbWarning: true }))).toBe(false)
  })

  it('05:59 meg csendes, 06:00-tol a dbWarning ujra ertesit', () => {
    expect(shouldNotify(data({ timestamp: at(5, 59), dbWarning: true }))).toBe(false)
    expect(shouldNotify(data({ timestamp: at(6), dbWarning: true }))).toBe(true)
    expect(shouldNotify(data({ timestamp: at(6, 30), dbWarning: true }))).toBe(true)
  })

  it('21:30-kor NEM csendes: az esti ag valtozatlanul atengedi az urgent kartyat', () => {
    expect(shouldNotify(data({ timestamp: at(21, 30), urgent: 1 }))).toBe(true)
    expect(shouldNotify(data({ timestamp: at(21, 30), waiting: 5 }))).toBe(false)
  })

  it('a savot Europe/Budapest ora zarja, nem a host TZ', () => {
    const prevTz = process.env.TZ
    process.env.TZ = 'UTC'
    try {
      // 2026-07-15T20:30:00Z = 22:30 Budapest (CEST) -> csend. Egy UTC hoston a
      // regi data.timestamp.getHours() 20-at adott volna -> ertesitett volna.
      const ts = new Date('2026-07-15T20:30:00Z')
      expect(ts.getHours()).toBe(20) // a TZ-valtas ervenyre jutott
      expect(shouldNotify(data({ timestamp: ts, urgent: 2, dbWarning: true }))).toBe(false)
    } finally {
      process.env.TZ = prevTz
    }
  })
})
