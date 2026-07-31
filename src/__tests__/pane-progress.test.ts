// Pane PROGRESS, the measurement the 2026-07-31 audit named as missing
// (predicate P3): detectPaneState answers "is it typing", not "is it moving".
// A pending-message alert now requires a pane that has stopped moving, so a
// legitimate long working turn never alerts at any age -- the 16:44 false
// alert's exact cause -- while a frozen one alerts at the threshold.

import { describe, it, expect } from 'vitest'
import { paneProgressHash, updatePaneProgress, isPaneStalled } from '../pane-state.js'

const NOW = 1_785_500_000_000
const GAP_MS = 5 * 60 * 1000

describe('paneProgressHash', () => {
  it('is stable for identical text and differs for a one-character change', () => {
    expect(paneProgressHash('esc to interrupt (12s)')).toBe(paneProgressHash('esc to interrupt (12s)'))
    expect(paneProgressHash('esc to interrupt (12s)')).not.toBe(paneProgressHash('esc to interrupt (13s)'))
  })

  it('handles empty panes and non-ASCII without throwing', () => {
    expect(paneProgressHash('')).toHaveLength(8)
    expect(paneProgressHash('✻ Gondolkodik… (7s)')).toHaveLength(8)
  })
})

describe('updatePaneProgress / isPaneStalled', () => {
  it('a WORKING pane (text changes every sweep) never counts as stalled', () => {
    let state = updatePaneProgress(undefined, 'working 1s', NOW, GAP_MS)
    for (let i = 2; i < 40; i++) {
      state = updatePaneProgress(state ?? undefined, `working ${i}s`, NOW + i * 60_000, GAP_MS)
      expect(isPaneStalled(state, 2)).toBe(false)
    }
  })

  it('a FROZEN pane counts as stalled after the required consecutive sweeps', () => {
    const frozen = 'esc to interrupt (42s)'
    let state = updatePaneProgress(undefined, frozen, NOW, GAP_MS)
    expect(isPaneStalled(state, 2)).toBe(false) // first sample: nothing to compare
    state = updatePaneProgress(state ?? undefined, frozen, NOW + 60_000, GAP_MS)
    expect(isPaneStalled(state, 2)).toBe(false) // one unchanged sweep is not enough
    state = updatePaneProgress(state ?? undefined, frozen, NOW + 120_000, GAP_MS)
    expect(isPaneStalled(state, 2)).toBe(true)  // two unchanged sweeps -> stalled
  })

  it('one changed frame resets the counter (a pane that moved is not frozen)', () => {
    const frozen = 'same'
    let state = updatePaneProgress(undefined, frozen, NOW, GAP_MS)
    state = updatePaneProgress(state ?? undefined, frozen, NOW + 60_000, GAP_MS)
    state = updatePaneProgress(state ?? undefined, frozen, NOW + 120_000, GAP_MS)
    expect(isPaneStalled(state, 2)).toBe(true)
    state = updatePaneProgress(state ?? undefined, 'moved', NOW + 180_000, GAP_MS)
    expect(isPaneStalled(state, 2)).toBe(false)
  })

  it('a long GAP between samples resets: the session was not observed in between', () => {
    const frozen = 'same'
    let state = updatePaneProgress(undefined, frozen, NOW, GAP_MS)
    state = updatePaneProgress(state ?? undefined, frozen, NOW + 60_000, GAP_MS)
    state = updatePaneProgress(state ?? undefined, frozen, NOW + 120_000, GAP_MS)
    expect(isPaneStalled(state, 2)).toBe(true)
    // Two hours later the same text proves nothing about the time in between.
    state = updatePaneProgress(state ?? undefined, frozen, NOW + 2 * 60 * 60_000, GAP_MS)
    expect(isPaneStalled(state, 2)).toBe(false)
  })

  it('backwards clock skew resets rather than inflating the counter', () => {
    const frozen = 'same'
    let state = updatePaneProgress(undefined, frozen, NOW, GAP_MS)
    state = updatePaneProgress(state ?? undefined, frozen, NOW - 60_000, GAP_MS)
    expect(state?.unchangedSweeps).toBe(0)
  })

  it('fail-OPEN: an unreadable pane is null and reads as stalled', () => {
    expect(updatePaneProgress(undefined, null, NOW, GAP_MS)).toBeNull()
    expect(isPaneStalled(null, 2)).toBe(true)
  })
})
