// Audit AC-1: exactly ONE enabled owner per signal.
//
// The 2026-07-31 incident was not a detector bug, it was a missing declaration:
// three emitters watched one stuck message with three thresholds and three
// private dedup stores, so the owner got three messages about one fact. Nothing
// could tell a duplicate from an independent finding because nothing said who
// owned the signal. This test fails the build if that state returns.

import { describe, it, expect } from 'vitest'
import {
  ALERT_REGISTRY, findDuplicateSignalOwners, ownerFacingEmitters, type AlertEmitter,
} from '../alert-registry.js'

describe('alert registry', () => {
  it('has exactly one ENABLED owner per signal', () => {
    const conflicts = findDuplicateSignalOwners()
    expect(conflicts, `duplicate signal owners: ${JSON.stringify(conflicts)}`).toEqual([])
  })

  it('detects a duplicate when one is introduced (the guard actually guards)', () => {
    const dupe: AlertEmitter[] = [
      { ...ALERT_REGISTRY[0], id: 'a', owner: true, enabled: true },
      { ...ALERT_REGISTRY[0], id: 'b', owner: true, enabled: true },
    ]
    expect(findDuplicateSignalOwners(dupe)).toEqual([{ signalId: ALERT_REGISTRY[0].signalId, emitters: ['a', 'b'] }])
  })

  it('ignores DISABLED emitters: a retired script is not a duplicate alert', () => {
    const withDisabled: AlertEmitter[] = [
      { ...ALERT_REGISTRY[0], id: 'a', owner: true, enabled: true },
      { ...ALERT_REGISTRY[0], id: 'b', owner: true, enabled: false },
    ]
    expect(findDuplicateSignalOwners(withDisabled)).toEqual([])
  })

  it('every signal has an owner (an observer-only signal reaches nobody)', () => {
    const owned = new Set(ALERT_REGISTRY.filter((e) => e.owner).map((e) => e.signalId))
    for (const e of ALERT_REGISTRY) expect(owned.has(e.signalId), `no owner for ${e.signalId}`).toBe(true)
  })

  it('ids are unique', () => {
    const ids = ALERT_REGISTRY.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('owner-facing stays the exception, and each case is justified in notes', () => {
    const ownerFacing = ownerFacingEmitters()
    // Audit AC-2 target state is <= 14 of 40 fleet-wide; the emitters covered by
    // this pass must stay far below that.
    expect(ownerFacing.length).toBeLessThanOrEqual(3)
    for (const e of ownerFacing) {
      expect(e.notes, `${e.id} is ownerFacing without a stated reason`).toBeTruthy()
    }
  })

  it('every emitter states its quiet-hours behaviour (audit AC-9)', () => {
    for (const e of ALERT_REGISTRY) {
      expect(e.quietHours?.trim(), `${e.id} has no quiet-hours entry`).toBeTruthy()
    }
    // The one sanctioned direct-Bot-API path must carry an explicit exemption.
    const notify = ALERT_REGISTRY.find((e) => e.id === 'notify-sh')
    expect(notify?.quietHours).toContain('EXEMPT')
  })
})
