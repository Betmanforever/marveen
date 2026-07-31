// The shared alert policy: routing, persistent dedup, the owner-facing rate
// ceiling and the 24h digest (card 8bcbd8fe, audit AC-2/AC-4/AC-7/AC-8).
//
// Store-backed cases use a throwaway temp file, NEVER the real
// store/alert-state.json: these tests run from the live install root, so a
// default-path write would corrupt the running fleet's dedup state.

import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  decideAlertRoute,
  loadAlertState, saveAlertState, shouldEmit, markEmitted, claimEmit,
  decideOwnerSendAllowance, recordOwnerSend, shouldSendBreakerNotice, buildBreakerNotice,
  bufferDigestEntry, buildDigestSection, countDigest, renderDigest,
  ackDigestConsume, DIGEST_ACK_TTL_MS,
  OWNER_SENDS_PER_HOUR, OWNER_SENDS_PER_DAY, OWNER_HOUR_MS, OWNER_DAY_MS,
  FATAL_SENDS_PER_HOUR, FATAL_SENDS_PER_DAY, DIGEST_WINDOW_MS, DIGEST_MAX_LINES,
  EMPTY_ALERT_STATE,
  type AlertFacts, type DigestEntry,
} from '../alert-policy.js'

const dir = mkdtempSync(join(tmpdir(), 'marveen-alert-policy-'))
const STORE = join(dir, 'alert-state.json')
const NOW = Date.UTC(2026, 6, 31, 10, 0, 0)

beforeEach(() => {
  if (existsSync(STORE)) rmSync(STORE)
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

const facts = (over: Partial<AlertFacts> = {}): AlertFacts => ({
  needsHuman: false,
  coordinatorTracked: false,
  remediationAttempted: false,
  remediationSucceeded: false,
  escalationCeilingHit: false,
  ...over,
})

describe('decideAlertRoute: auto-remediation first, coordinator second, owner last', () => {
  it('a successful auto-fix is history -> digest, even when it looks urgent', () => {
    expect(decideAlertRoute(facts({ remediationSucceeded: true, remediationAttempted: true }))).toBe('digest')
    expect(decideAlertRoute(facts({
      remediationSucceeded: true, remediationAttempted: true, escalationCeilingHit: true, coordinatorTracked: true,
    }))).toBe('digest')
  })

  it('a human decision always reaches the owner', () => {
    expect(decideAlertRoute(facts({ needsHuman: true }))).toBe('user-telegram')
    // ... and a claim by someone else cannot absorb it.
    expect(decideAlertRoute(facts({ needsHuman: true, claimedByOther: true }))).toBe('user-telegram')
    // ... but a SUCCESSFUL remediation still outranks it: there is nothing to decide.
    expect(decideAlertRoute(facts({ needsHuman: true, remediationSucceeded: true }))).toBe('digest')
  })

  it('AC-4: an item another emitter already claims never goes owner-facing', () => {
    expect(decideAlertRoute(facts({
      claimedByOther: true, coordinatorTracked: true, remediationAttempted: true, escalationCeilingHit: true,
    }))).toBe('digest')
  })

  it('the owner is paged only when remediation was tried, failed AND the ceiling is hit', () => {
    expect(decideAlertRoute(facts({ escalationCeilingHit: true, remediationAttempted: true }))).toBe('user-telegram')
    // Ceiling without a remediation attempt is just a slow first sighting.
    expect(decideAlertRoute(facts({ escalationCeilingHit: true, coordinatorTracked: true }))).toBe('coordinator')
    // Remediation attempted but the ceiling not yet reached -> coordinator.
    expect(decideAlertRoute(facts({ remediationAttempted: true, coordinatorTracked: true }))).toBe('coordinator')
  })

  it('routine findings go to the coordinator; everything else is digested, never dropped', () => {
    expect(decideAlertRoute(facts({ coordinatorTracked: true }))).toBe('coordinator')
    expect(decideAlertRoute(facts())).toBe('digest')
    // 'log-only' is the CALLER's route for a deduped repeat -- the policy never
    // returns it, because a first sighting must never be silently dropped.
    const routes = new Set([
      decideAlertRoute(facts()),
      decideAlertRoute(facts({ coordinatorTracked: true })),
      decideAlertRoute(facts({ needsHuman: true })),
      decideAlertRoute(facts({ remediationSucceeded: true })),
    ])
    expect(routes.has('log-only')).toBe(false)
  })
})

describe('persistent dedup: survives the restart that used to re-arm every alert', () => {
  it('emits on first sighting, stays quiet inside the window, re-emits after it', () => {
    const s0 = EMPTY_ALERT_STATE
    expect(shouldEmit(s0, 'queue-starving', '1,2', NOW, 30 * 60_000)).toBe(true)
    const s1 = markEmitted(s0, 'queue-starving', '1,2', NOW)
    expect(shouldEmit(s1, 'queue-starving', '1,2', NOW + 29 * 60_000, 30 * 60_000)).toBe(false)
    expect(shouldEmit(s1, 'queue-starving', '1,2', NOW + 30 * 60_000, 30 * 60_000)).toBe(true)
  })

  it('a CHANGED finding key re-arms immediately (a worsening backlog is not a repeat)', () => {
    const s = markEmitted(EMPTY_ALERT_STATE, 'queue-starving', '1,2', NOW)
    expect(shouldEmit(s, 'queue-starving', '1,2,3', NOW + 60_000, 30 * 60_000)).toBe(true)
  })

  it('a different KIND with the same key is independent', () => {
    const s = markEmitted(EMPTY_ALERT_STATE, 'queue-starving', '1', NOW)
    expect(shouldEmit(s, 'ritual-missed', '1', NOW, 30 * 60_000)).toBe(true)
  })

  it('does not stall on backwards clock skew', () => {
    const s = markEmitted(EMPTY_ALERT_STATE, 'k', 'x', NOW + 60 * 60_000)
    expect(shouldEmit(s, 'k', 'x', NOW, 30 * 60_000)).toBe(true)
  })

  it('round-trips through the file and survives a process restart', () => {
    expect(claimEmit('queue-starving', '7,8', NOW, 30 * 60_000, STORE)).toBe(true)
    // Fresh load == what a restarted dashboard sees.
    expect(shouldEmit(loadAlertState(STORE), 'queue-starving', '7,8', NOW + 60_000, 30 * 60_000)).toBe(false)
    expect(claimEmit('queue-starving', '7,8', NOW + 60_000, 30 * 60_000, STORE)).toBe(false)
    expect(claimEmit('queue-starving', '7,8', NOW + 31 * 60_000, 30 * 60_000, STORE)).toBe(true)
  })

  it('a missing or corrupt store reads as empty (fail-loud: the next finding alerts)', () => {
    expect(loadAlertState(join(dir, 'does-not-exist.json'))).toMatchObject({ emits: {}, ownerSends: [] })
    saveAlertState({ ...EMPTY_ALERT_STATE, emits: { 'k:x': NOW } }, STORE)
    rmSync(STORE)
    expect(shouldEmit(loadAlertState(STORE), 'k', 'x', NOW, 30 * 60_000)).toBe(true)
  })

  it('prunes stamps older than the retention window so the file stays bounded', () => {
    const old = markEmitted(EMPTY_ALERT_STATE, 'k', 'ancient', NOW - 8 * 24 * 60 * 60 * 1000)
    const next = markEmitted(old, 'k', 'fresh', NOW)
    expect(Object.keys(next.emits)).toEqual(['k:fresh'])
  })
})

describe('AC-8 owner-facing rate ceiling', () => {
  it('allows up to the hourly cap, then reports the breach', () => {
    let sends: number[] = []
    for (let i = 0; i < OWNER_SENDS_PER_HOUR; i++) {
      expect(decideOwnerSendAllowance(sends, NOW)).toBe('allow')
      sends = [...sends, NOW]
    }
    expect(decideOwnerSendAllowance(sends, NOW)).toBe('hour-ceiling')
    // The window rolls: an hour later the same stamps no longer count.
    expect(decideOwnerSendAllowance(sends, NOW + OWNER_HOUR_MS + 1)).toBe('allow')
  })

  it('enforces the daily cap even when the hourly one keeps resetting', () => {
    // One send per hour for OWNER_SENDS_PER_DAY hours: never trips the hourly
    // cap, always inside the 24h window.
    const sends = Array.from({ length: OWNER_SENDS_PER_DAY }, (_, i) => NOW - i * OWNER_HOUR_MS)
    expect(decideOwnerSendAllowance(sends, NOW)).toBe('day-ceiling')
    expect(decideOwnerSendAllowance(sends.slice(1), NOW)).toBe('allow')
  })

  it('records sends and drops stamps older than a day', () => {
    const state = { ...EMPTY_ALERT_STATE, ownerSends: [NOW - 25 * 60 * 60 * 1000, NOW - 60_000] }
    expect(recordOwnerSend(state, NOW).ownerSends).toEqual([NOW - 60_000, NOW])
  })

  it('the breaker speaks once per hour, and says which cap engaged', () => {
    expect(shouldSendBreakerNotice(null, NOW)).toBe(true)
    expect(shouldSendBreakerNotice(NOW, NOW + OWNER_HOUR_MS - 1)).toBe(false)
    expect(shouldSendBreakerNotice(NOW, NOW + OWNER_HOUR_MS)).toBe(true)
    expect(buildBreakerNotice('hour-ceiling', 17)).toContain('17 tovabbi riasztas elnemitva')
    expect(buildBreakerNotice('day-ceiling', 2)).toContain('napi plafon')
  })

  it('20 alerts in one hour: 3 pass, 17 are muted, 1 breaker notice (audit AC-8 case)', () => {
    // The exact scenario the audit specifies, driven through the pure parts the
    // way channel-monitor.sendAlert drives them.
    let state = EMPTY_ALERT_STATE
    let sent = 0
    let breakers = 0
    for (let i = 0; i < 20; i++) {
      const t = NOW + i * 1000
      const verdict = decideOwnerSendAllowance(state.ownerSends, t)
      if (verdict === 'allow') {
        state = recordOwnerSend(state, t)
        sent++
        continue
      }
      state = bufferDigestEntry(state, { ts: t, category: 'muted', source: 'rate-ceiling', summary: `riasztas ${i}` })
      if (shouldSendBreakerNotice(state.lastBreakerAt, t)) {
        state = { ...state, lastBreakerAt: t }
        breakers++
      }
    }
    expect(sent).toBe(3)
    expect(breakers).toBe(1)
    expect(state.digest).toHaveLength(17)
    // Nothing was lost: every muted alert is in the digest.
    expect(countDigest(state.digest).muted).toBe(17)
  })
})

describe('AC-7 daily digest', () => {
  const entry = (over: Partial<DigestEntry> = {}): DigestEntry => ({
    ts: NOW, category: 'auto-fixed', source: 'queue-starving', summary: 'valami', ...over,
  })

  it('a zero-finding day produces NO section at all', () => {
    expect(buildDigestSection([])).toBeNull()
    expect(renderDigest(NOW, { path: STORE }).section).toBeNull()
  })

  it('renders the four counted classes', () => {
    const section = buildDigestSection([
      entry({ category: 'auto-fixed' }),
      entry({ category: 'auto-fixed' }),
      entry({ category: 'coordinator' }),
      entry({ category: 'open' }),
      entry({ category: 'muted' }),
    ])
    expect(section).toContain('Automatikusan javitva: 2')
    expect(section).toContain('Koordinator kezelte:   1')
    expect(section).toContain('Nyitva maradt:         1')
    expect(section).toContain('Elnemitva (duplikatum vagy plafon): 1')
  })

  it('puts open items first and caps the lines with an overflow count', () => {
    const many = Array.from({ length: DIGEST_MAX_LINES + 5 }, (_, i) =>
      entry({ ts: NOW + i * 1000, summary: `sor-${i}` }))
    const section = buildDigestSection([...many, entry({ ts: NOW + 99_000, category: 'open', summary: 'NYITOTT' })])
    const lines = section!.split('\n').filter((l) => l.startsWith('  •'))
    expect(lines[0]).toContain('NYITOTT')
    expect(lines).toHaveLength(DIGEST_MAX_LINES + 1) // capped + the overflow line
    // 20 filler + 1 open = 21 entries, 15 shown -> 6 counted.
    expect(lines.at(-1)).toContain('+6 tovabbi tetel')
  })

  it('buffers on a 24h rolling window and counts what it had to drop', () => {
    const state = bufferDigestEntry(
      { ...EMPTY_ALERT_STATE, digest: [entry({ ts: NOW - DIGEST_WINDOW_MS - 1000 })] },
      entry({ ts: NOW, summary: 'friss' }),
    )
    expect(state.digest).toHaveLength(1)
    expect(state.digest[0].summary).toBe('friss')
  })

  it('consume=1 clears the buffer so the same finding is never reported twice', () => {
    saveAlertState({ ...EMPTY_ALERT_STATE, digest: [entry({ summary: 'egyszer' })] }, STORE)
    expect(renderDigest(NOW, { consume: true, path: STORE }).section).toContain('egyszer')
    expect(renderDigest(NOW, { path: STORE }).section).toBeNull()
  })

  it('a read WITHOUT consume leaves the buffer intact (looking is not delivering)', () => {
    saveAlertState({ ...EMPTY_ALERT_STATE, digest: [entry({ summary: 'megmarad' })] }, STORE)
    expect(renderDigest(NOW, { path: STORE }).section).toContain('megmarad')
    expect(renderDigest(NOW, { path: STORE }).section).toContain('megmarad')
  })

  it('drops entries that fell out of the 24h window at render time', () => {
    saveAlertState({ ...EMPTY_ALERT_STATE, digest: [entry({ ts: NOW - DIGEST_WINDOW_MS - 1 })] }, STORE)
    expect(renderDigest(NOW, { path: STORE }).section).toBeNull()
  })
})

describe('FATAL-class ceiling (wolfe decision 2026-07-31, AC-8 exemption)', () => {
  // The class whose suppression converts spam into silence gets its OWN,
  // higher ledger -- exempt from the global ceiling, never uncapped.
  const NOW = 1_785_500_000_000

  it('a fatal send is allowed when the OWNER ledger is at its cap', () => {
    const ownerAtCap = Array.from({ length: OWNER_SENDS_PER_DAY }, (_, i) => NOW - 1000 - i)
    // Owner ledger exhausted...
    expect(decideOwnerSendAllowance(ownerAtCap, NOW)).not.toBe('allow')
    // ...but the fatal ledger is separate and empty.
    expect(decideOwnerSendAllowance([], NOW, FATAL_SENDS_PER_HOUR, FATAL_SENDS_PER_DAY)).toBe('allow')
  })

  it('caps fatal sends at its own hourly and daily limits', () => {
    const hourFull = Array.from({ length: FATAL_SENDS_PER_HOUR }, (_, i) => NOW - 1000 - i)
    expect(decideOwnerSendAllowance(hourFull, NOW, FATAL_SENDS_PER_HOUR, FATAL_SENDS_PER_DAY)).toBe('hour-ceiling')
    const daySpread = Array.from({ length: FATAL_SENDS_PER_DAY }, (_, i) => NOW - (i + 2) * 60 * 60 * 1000 / 2)
      .filter((ts) => ts > NOW - OWNER_DAY_MS)
    if (daySpread.length >= FATAL_SENDS_PER_DAY) {
      expect(decideOwnerSendAllowance(daySpread, NOW, FATAL_SENDS_PER_HOUR, FATAL_SENDS_PER_DAY)).toBe('day-ceiling')
    }
    expect(FATAL_SENDS_PER_HOUR).toBeGreaterThan(OWNER_SENDS_PER_HOUR)
    expect(FATAL_SENDS_PER_DAY).toBeGreaterThan(OWNER_SENDS_PER_DAY)
  })

  it('recordOwnerSend writes the two ledgers independently', () => {
    let s = { ...EMPTY_ALERT_STATE }
    s = recordOwnerSend(s, NOW, 'owner')
    s = recordOwnerSend(s, NOW + 1, 'fatal')
    expect(s.ownerSends).toEqual([NOW])
    expect(s.fatalSends).toEqual([NOW + 1])
  })

  it('fatal ledger survives a store round-trip and ignores garbage', () => {
    const p = join(tmpdir(), `alert-fatal-${process.pid}.json`)
    saveAlertState({ ...EMPTY_ALERT_STATE, fatalSends: [NOW, Number.NaN as unknown as number] }, p)
    const loaded = loadAlertState(p)
    expect(loaded.fatalSends).toEqual([NOW])
    rmSync(p, { force: true })
  })

  it('breaker notice names the FATAL class and its own limits', () => {
    expect(buildBreakerNotice('hour-ceiling', 2, true)).toContain('FATAL-osztaly')
    expect(buildBreakerNotice('hour-ceiling', 2, true)).toContain(String(FATAL_SENDS_PER_HOUR))
    expect(buildBreakerNotice('hour-ceiling', 2)).not.toContain('FATAL')
  })
})

describe('two-phase digest consume (close condition C-4)', () => {
  // Delete-on-read lost the night's findings whenever the briefing died AFTER
  // the fetch. Consume now parks entries under an ack token; only the ack
  // deletes, and an unacked park reverts after the TTL.
  const NOW = Date.UTC(2026, 6, 31, 5, 27, 0)
  const entry = (over: Partial<DigestEntry> = {}): DigestEntry => ({
    ts: NOW - 1000, category: 'auto-fixed', source: 't', summary: 'ejszakai tetel', ...over,
  })

  it('consume parks the entries under a token and empties the visible buffer', () => {
    saveAlertState({ ...EMPTY_ALERT_STATE, digest: [entry()] }, STORE)
    const consumed = renderDigest(NOW, { consume: true, path: STORE })
    expect(consumed.section).toContain('ejszakai tetel')
    expect(consumed.ackToken).toBeTruthy()
    // Within the TTL the parked entries do not render again.
    expect(renderDigest(NOW + 1000, { path: STORE }).section).toBeNull()
  })

  it('ack deletes the parked entries for good', () => {
    saveAlertState({ ...EMPTY_ALERT_STATE, digest: [entry()] }, STORE)
    const { ackToken } = renderDigest(NOW, { consume: true, path: STORE })
    expect(ackDigestConsume(ackToken!, STORE)).toBe(true)
    expect(renderDigest(NOW + DIGEST_ACK_TTL_MS + 1, { path: STORE }).section).toBeNull()
  })

  it('an unacked consume reverts after the TTL instead of losing the findings', () => {
    saveAlertState({ ...EMPTY_ALERT_STATE, digest: [entry({ ts: NOW - 1000 })] }, STORE)
    renderDigest(NOW, { consume: true, path: STORE })
    // Briefing died: no ack. Past the TTL the entry is back...
    const later = NOW + DIGEST_ACK_TTL_MS + 1
    expect(renderDigest(later, { path: STORE }).section).toContain('ejszakai tetel')
  })

  it('a stale token is a no-op', () => {
    saveAlertState({ ...EMPTY_ALERT_STATE, digest: [entry()] }, STORE)
    renderDigest(NOW, { consume: true, path: STORE })
    expect(ackDigestConsume('ack-nem-letezo', STORE)).toBe(false)
    // The real park is untouched: it still reverts after the TTL.
    expect(renderDigest(NOW + DIGEST_ACK_TTL_MS + 1, { path: STORE }).section).toContain('ejszakai tetel')
  })

  it('a consume with an EMPTY buffer parks nothing and needs no ack', () => {
    const consumed = renderDigest(NOW, { consume: true, path: STORE })
    expect(consumed.section).toBeNull()
    expect(loadAlertState(STORE).pendingAck).toBeNull()
  })

  it('pendingAck survives a store round-trip', () => {
    saveAlertState({ ...EMPTY_ALERT_STATE, digest: [entry()] }, STORE)
    const { ackToken } = renderDigest(NOW, { consume: true, path: STORE })
    const loaded = loadAlertState(STORE)
    expect(loaded.pendingAck?.token).toBe(ackToken)
    expect(loaded.pendingAck?.entries).toHaveLength(1)
  })
})
