// Replay evidence for kanban card 8bcbd8fe / audit AC-11.
//
// The card closes only if a replay of the 2026-07-31 16:00-16:51 sequence
// through the new pipeline produces ZERO owner-facing Telegram messages, and a
// control replay of a genuine wedge produces EXACTLY ONE. Both live here.
//
// The real facts, read from store/claudeclaw.db (agent_messages):
//   #3429  mr-wolfe -> neo  created 15:46:32, delivered 16:07:19  (20m47s pending)
//   #3458  mr-wolfe -> neo  created 16:28:54, delivered 16:44:31  (15m37s pending)
// Both were DELIVERED: neo was mid-turn, working, not wedged. Under the old
// rules each crossed PENDING_AGE_ALERT_HARD_CEILING_MS (15 min), which
// deliberately re-included healthy-busy targets, so each produced a direct
// owner alert (16:00/16:04 on #3429, 16:44 on #3458). Gabor's verdict:
// "This is non-sense."
//
// Every side effect is injected, so this exercises the real decision path.

import { describe, it, expect, beforeEach } from 'vitest'
import {
  runPendingAgeWatchdog,
  __resetPendingAgeWatchdogForTest,
  PENDING_AGE_THRESHOLD_MS,
  COORDINATOR_GRACE_MS,
  PANE_STALL_SWEEPS,
  SIGNAL_ID,
  type PendingRow,
  type WatchdogDeps,
  type DigestAppend,
} from '../web/pending-age-watchdog.js'

const MIN = 60 * 1000
const TICK_MS = 60 * 1000 // the channel-monitor sweep interval

interface Recorder {
  coordinator: string[]
  owner: string[]
  digest: DigestAppend[]
  claims: Map<string, { by: string; expiresAt: number }>
}

interface HarnessOpts {
  /** Pane text for a given sweep index; a CHANGING string means a working
   * agent, a constant one means a frozen pane. */
  paneAt(sweep: number): string | null
  procAgeMs?: number | null
  /** Pre-existing foreign claim (audit AC-4). */
  foreignClaim?: { itemKey: string; by: string }
}

function makeDeps(rec: Recorder, nowMs: number, opts: HarnessOpts, sweep: number, pending: PendingRow[]): WatchdogDeps {
  // The emit-dedup gate the real caller backs with the alert-state file; an
  // in-memory Map here keeps the test off the live store.
  const emits: Map<string, number> = (makeDeps as unknown as { _emits?: Map<string, number> })._emits ??= new Map()
  return {
    nowMs,
    pending,
    sessionFor: (agent) => `agent-${agent}`,
    probeTarget: () => ({ pane: opts.paneAt(sweep), procAgeMs: opts.procAgeMs ?? 60 * 60 * 1000 }),
    liveClaimBy: (itemKey, nowSec) => {
      if (opts.foreignClaim && opts.foreignClaim.itemKey === itemKey) return opts.foreignClaim.by
      const c = rec.claims.get(itemKey)
      return c && c.expiresAt > nowSec ? c.by : null
    },
    claimForCoordinator: (itemKey, nowSec, ttlSec) => { rec.claims.set(itemKey, { by: 'coordinator', expiresAt: nowSec + ttlSec }) },
    releaseClaim: (itemKey) => { rec.claims.delete(itemKey) },
    sendCoordinator: (text) => { rec.coordinator.push(text) },
    sendOwner: (text) => { rec.owner.push(text) },
    appendDigest: (entry) => { rec.digest.push(entry) },
    claimEmit: (kind, key, dedupMs) => {
      const k = `${kind}:${key}`
      const last = emits.get(k)
      if (last !== undefined && nowMs - last < dedupMs) return false
      emits.set(k, nowMs)
      return true
    },
  }
}

function newRecorder(): Recorder {
  return { coordinator: [], owner: [], digest: [], claims: new Map() }
}

/** Sweep the watchdog every 60s from `fromMs` to `toMs`. */
function replay(rec: Recorder, rows: (nowMs: number) => PendingRow[], fromMs: number, toMs: number, opts: HarnessOpts): void {
  let sweep = 0
  for (let t = fromMs; t <= toMs; t += TICK_MS, sweep++) {
    runPendingAgeWatchdog(makeDeps(rec, t, opts, sweep, rows(t)))
  }
}

beforeEach(() => {
  __resetPendingAgeWatchdogForTest()
  ;(makeDeps as unknown as { _emits?: Map<string, number> })._emits = new Map()
})

describe('AC-11 replay: 2026-07-31 16:00-16:51, messages 3429 + 3458', () => {
  // Epoch seconds straight from the DB rows.
  const M3429: PendingRow = { id: 3429, from_agent: 'mr-wolfe', to_agent: 'neo', created_at: 1785505592 }
  const M3458: PendingRow = { id: 3458, from_agent: 'mr-wolfe', to_agent: 'neo', created_at: 1785508134 }
  const DELIVERED_3429 = 1785506839 * 1000
  const DELIVERED_3458 = 1785509071 * 1000

  it('produces ZERO owner-facing sends: neo was working, and a moving pane is never starvation', () => {
    const rec = newRecorder()
    // A working agent redraws its pane every sweep (spinner + token counter).
    const opts: HarnessOpts = { paneAt: (s) => `esc to interrupt  (${s * 17 + 3}s - 1.${s}k tokens)` }
    replay(
      rec,
      (now) => [
        ...(now < DELIVERED_3429 && now >= M3429.created_at * 1000 ? [M3429] : []),
        ...(now < DELIVERED_3458 && now >= M3458.created_at * 1000 ? [M3458] : []),
      ],
      M3429.created_at * 1000,
      DELIVERED_3458,
      opts,
    )

    expect(rec.owner).toEqual([])
    // ... and nothing was handed to the coordinator either: there was no
    // finding, only a long turn. No claim rows were created.
    expect(rec.coordinator).toEqual([])
    expect(rec.claims.size).toBe(0)
  })

  it('would have alerted under the retired rule: both rows out-waited the old 15-min ceiling', () => {
    // Guards the fixture itself -- if these ages ever stop crossing the old
    // ceiling, the replay above stops proving anything.
    expect(DELIVERED_3429 - M3429.created_at * 1000).toBeGreaterThan(15 * MIN)
    expect(DELIVERED_3458 - M3458.created_at * 1000).toBeGreaterThan(15 * MIN)
  })
})

describe('control replay: a genuine wedge (frozen pane)', () => {
  const WEDGED: PendingRow = { id: 9001, from_agent: 'mr-wolfe', to_agent: 'neo', created_at: 1785505592 }
  const START = WEDGED.created_at * 1000

  it('flags the coordinator first, then alerts the owner EXACTLY ONCE after the grace', () => {
    const rec = newRecorder()
    // Frozen pane: identical capture on every sweep.
    const opts: HarnessOpts = { paneAt: () => 'esc to interrupt  (42s - 1.1k tokens)' }
    // Run well past the coordinator grace so the escalation has room to fire.
    replay(rec, () => [WEDGED], START, START + 40 * MIN, opts)

    // The OWNER hears about it exactly once -- that is the control assertion.
    expect(rec.owner).toHaveLength(1)
    expect(rec.owner[0]).toContain('koordinator')
    expect(rec.owner[0]).toContain('#9001')

    // The coordinator is flagged first and RE-flagged on its 30-min cadence
    // while the wedge persists (decideDialogEscalation's dedup re-flag): over a
    // 40-minute window that is two flags, and it never resets the owner gate.
    expect(rec.coordinator).toHaveLength(2)
    expect(rec.coordinator[0]).toContain('[AUTOMATIKUS RIASZTAS]')
    expect(rec.coordinator[0]).toContain('#9001')

    // Digest order mirrors the ladder: flag -> owner escalation -> re-flag.
    expect(rec.digest.map((d) => d.category)).toEqual(['coordinator', 'open', 'coordinator'])
  })

  it('waits out the full coordinator grace before escalating (AC-5)', () => {
    const rec = newRecorder()
    const opts: HarnessOpts = { paneAt: () => 'frozen pane' }
    // Stop one sweep BEFORE the grace expires.
    replay(rec, () => [WEDGED], START, START + PENDING_AGE_THRESHOLD_MS + COORDINATOR_GRACE_MS - 2 * TICK_MS, opts)
    expect(rec.coordinator).toHaveLength(1)
    expect(rec.owner).toEqual([])
  })

  it('needs a stalled pane, not just age: the stall predicate is what alerts', () => {
    const rec = newRecorder()
    // Pane changes on every sweep for the whole hour -> never stalled.
    const opts: HarnessOpts = { paneAt: (s) => `working ${s}` }
    replay(rec, () => [WEDGED], START, START + 60 * MIN, opts)
    expect(rec.owner).toEqual([])
    expect(rec.coordinator).toEqual([])
  })

  it('needs PANE_STALL_SWEEPS consecutive unchanged captures before it counts as stalled', () => {
    const rec = newRecorder()
    // One unchanged sweep is not enough: alternate every other sweep.
    const opts: HarnessOpts = { paneAt: (s) => `pane-${Math.floor(s / 2)}` }
    replay(rec, () => [WEDGED], START, START + 30 * MIN, opts)
    expect(PANE_STALL_SWEEPS).toBe(2)
    expect(rec.owner).toEqual([])
    expect(rec.coordinator).toEqual([])
  })
})

describe('AC-4: an item another emitter already owns never reaches the owner', () => {
  const ROW: PendingRow = { id: 9002, from_agent: 'mr-wolfe', to_agent: 'neo', created_at: 1785505592 }
  const START = ROW.created_at * 1000

  it('routes to the digest and stays silent while a foreign claim is live', () => {
    const rec = newRecorder()
    const opts: HarnessOpts = {
      paneAt: () => 'frozen pane',
      foreignClaim: { itemKey: `msg:${ROW.id}`, by: 'pending-uzenet-watchdog' },
    }
    replay(rec, () => [ROW], START, START + 45 * MIN, opts)

    expect(rec.owner).toEqual([])
    expect(rec.coordinator).toEqual([])
    expect(rec.digest.every((d) => d.category === 'muted')).toBe(true)
    expect(rec.digest[0].summary).toContain('pending-uzenet-watchdog')
  })

  it('once the foreign claim EXPIRES the full ladder still runs (suppression is not silence)', () => {
    // The regression this guards: while suppressed, the escalation machine must
    // not advance. If it did, the episode's single owner-fallback would be
    // spent on a message nobody received and the item would stay silent for
    // good -- the audit's section 8 failure, in miniature.
    const rec = newRecorder()
    const claimed: HarnessOpts = {
      paneAt: () => 'frozen pane',
      foreignClaim: { itemKey: `msg:${ROW.id}`, by: 'pending-uzenet-watchdog' },
    }
    replay(rec, () => [ROW], START, START + 45 * MIN, claimed)
    expect(rec.owner).toEqual([])

    // The other emitter goes away (its claim expired); the watchdog takes over.
    const free: HarnessOpts = { paneAt: () => 'frozen pane' }
    replay(rec, () => [ROW], START + 46 * MIN, START + 70 * MIN, free)
    expect(rec.coordinator).toHaveLength(1)
    expect(rec.owner).toHaveLength(1)
  })
})

describe('boot grace and self-healing', () => {
  const ROW: PendingRow = { id: 9003, from_agent: 'mr-wolfe', to_agent: 'ive', created_at: 1785505592 }
  const START = ROW.created_at * 1000

  it('suppresses a target whose claude process is still booting', () => {
    const rec = newRecorder()
    replay(rec, () => [ROW], START, START + 8 * MIN, { paneAt: () => 'booting...', procAgeMs: 60_000 })
    expect(rec.owner).toEqual([])
    expect(rec.coordinator).toEqual([])
  })

  it('releases its claims and records the self-heal when the queue drains', () => {
    const rec = newRecorder()
    const opts: HarnessOpts = { paneAt: () => 'frozen pane' }
    // Stuck long enough to flag the coordinator, then the row is delivered.
    replay(rec, () => [ROW], START, START + 6 * MIN, opts)
    expect(rec.coordinator).toHaveLength(1)
    expect(rec.claims.size).toBeGreaterThan(0)

    runPendingAgeWatchdog(makeDeps(rec, START + 7 * MIN, opts, 99, []))
    expect(rec.claims.size).toBe(0)
    expect(rec.digest.at(-1)).toMatchObject({ category: 'auto-fixed', source: SIGNAL_ID })
    expect(rec.owner).toEqual([])
  })
})
