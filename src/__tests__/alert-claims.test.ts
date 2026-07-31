// The shared claim ledger behind audit AC-4: "no path may alert the owner about
// an item that the coordinator's own watchdog is already tracking". Independent
// dedup stores cannot dedupe each other, so the count of owner messages equals
// the count of detectors -- this table is the state they all read.

import { describe, it, expect, beforeAll } from 'vitest'
import {
  initDatabase, claimAlertItem, getLiveAlertClaim, appendAlertClaimNote,
  releaseAlertClaim, expireAlertClaims, listLiveAlertClaims,
} from '../db.js'

beforeAll(() => { initDatabase(':memory:') }) // fresh, isolated schema'd DB

const SIG = 'queue-starving'
const NOW = 1_785_500_000 // epoch seconds

describe('alert_claims', () => {
  it('claims a free item and reads back as live until it expires', () => {
    const { claim, mine } = claimAlertItem(SIG, 'msg:1', 'coordinator', NOW, 600)
    expect(mine).toBe(true)
    expect(claim.expires_at).toBe(NOW + 600)
    expect(getLiveAlertClaim(SIG, 'msg:1', NOW + 599)?.claimed_by).toBe('coordinator')
    // Boundary: expires_at is exclusive -- at the stamp itself it is gone.
    expect(getLiveAlertClaim(SIG, 'msg:1', NOW + 600)).toBeNull()
  })

  it('does NOT steal a live claim from another emitter -- it reports the holder', () => {
    claimAlertItem(SIG, 'msg:2', 'pending-uzenet-watchdog', NOW, 600)
    const res = claimAlertItem(SIG, 'msg:2', 'coordinator', NOW + 60, 600)
    expect(res.mine).toBe(false)
    expect(res.claim.claimed_by).toBe('pending-uzenet-watchdog')
    // The original expiry is untouched: a foreign claim cannot be extended.
    expect(res.claim.expires_at).toBe(NOW + 600)
  })

  it('the SAME claimer renews the expiry but keeps the original claimed_at', () => {
    claimAlertItem(SIG, 'msg:3', 'coordinator', NOW, 600)
    const renewed = claimAlertItem(SIG, 'msg:3', 'coordinator', NOW + 300, 600)
    expect(renewed.mine).toBe(true)
    expect(renewed.claim.claimed_at).toBe(NOW)
    expect(renewed.claim.expires_at).toBe(NOW + 900)
  })

  it('takes over an EXPIRED claim: a silent claimer must not hold an item hostage', () => {
    claimAlertItem(SIG, 'msg:4', 'dead-watchdog', NOW, 60)
    const res = claimAlertItem(SIG, 'msg:4', 'coordinator', NOW + 120, 600)
    expect(res.mine).toBe(true)
    expect(getLiveAlertClaim(SIG, 'msg:4', NOW + 130)?.claimed_by).toBe('coordinator')
  })

  it('appends observations (all a non-owning emitter may do) and caps the list', () => {
    claimAlertItem(SIG, 'msg:5', 'coordinator', NOW, 600)
    for (let i = 0; i < 25; i++) expect(appendAlertClaimNote(SIG, 'msg:5', `sighting ${i}`)).toBe(true)
    const notes = getLiveAlertClaim(SIG, 'msg:5', NOW + 1)?.notes ?? ''
    expect(notes.split('\n')).toHaveLength(20)
    expect(notes).toContain('sighting 24')
    expect(notes).not.toContain('sighting 0\n')
    // Appending to a non-existent claim is a no-op, not a throw.
    expect(appendAlertClaimNote(SIG, 'msg:nope', 'x')).toBe(false)
  })

  it('releases and expires', () => {
    claimAlertItem(SIG, 'msg:6', 'coordinator', NOW, 600)
    expect(releaseAlertClaim(SIG, 'msg:6')).toBe(true)
    expect(getLiveAlertClaim(SIG, 'msg:6', NOW)).toBeNull()
    expect(releaseAlertClaim(SIG, 'msg:6')).toBe(false) // idempotent

    claimAlertItem(SIG, 'msg:7', 'coordinator', NOW, 60)
    expect(expireAlertClaims(NOW + 61)).toBeGreaterThanOrEqual(1)
    expect(getLiveAlertClaim(SIG, 'msg:7', NOW + 61)).toBeNull()
  })

  it('keeps signals separate and lists only live claims', () => {
    claimAlertItem(SIG, 'msg:8', 'coordinator', NOW, 600)
    claimAlertItem('ritual-missed', 'msg:8', 'host-timer', NOW, 600)
    expect(getLiveAlertClaim('ritual-missed', 'msg:8', NOW)?.claimed_by).toBe('host-timer')
    const live = listLiveAlertClaims(SIG, NOW + 1).map((c) => c.item_key)
    expect(live).toContain('msg:8')
    expect(live).not.toContain('msg:6') // released above
  })
})
