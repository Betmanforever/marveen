import { describe, expect, it } from 'vitest'
import { decideStartupModelGate } from '../model-fallback.js'

// Tests for the scheduler's session-start model gate verdict (f3febf3a,
// 2026-08-01 incident): an overloaded host stretched plugin init past the old
// fixed 180s grace, the gate expired with zero rows measured, and the first
// scheduled injection confirmed a wrong-model startup dialog.

function facts(overrides: Partial<Parameters<typeof decideStartupModelGate>[0]> = {}) {
  return {
    ageSec: 60,
    graceSec: 180,
    hardCapSec: 900,
    measured: null as string | null,
    configured: 'claude-fable-5',
    coldStartHold: () => false,
    ...overrides,
  }
}

describe('decideStartupModelGate', () => {
  it('holds a rows-less session inside the base grace', () => {
    expect(decideStartupModelGate(facts({ ageSec: 60 }))).toBe('unverified')
  })

  it('verifies when boot rows match the configured model', () => {
    expect(decideStartupModelGate(facts({ measured: 'claude-fable-5' }))).toBe('verified')
  })

  it('reads drift (unverified) when boot rows show a different model', () => {
    expect(decideStartupModelGate(facts({ measured: 'claude-sonnet-5' }))).toBe('unverified')
  })

  it('THE INCIDENT: past base grace, no rows, cold-start hold active -> keeps holding', () => {
    expect(decideStartupModelGate(facts({ ageSec: 291, coldStartHold: () => true }))).toBe('unverified')
  })

  it('past base grace, no rows, no cold-start hold -> opens (legacy worst case)', () => {
    expect(decideStartupModelGate(facts({ ageSec: 291, coldStartHold: () => false }))).toBe('not-applicable')
  })

  it('hard cap opens the gate unconditionally, even mid-hold', () => {
    expect(decideStartupModelGate(facts({ ageSec: 901, coldStartHold: () => true }))).toBe('not-applicable')
  })

  it('does not invoke the cold-start probe when rows already decided the verdict', () => {
    let called = false
    const probe = () => { called = true; return true }
    decideStartupModelGate(facts({ ageSec: 291, measured: 'claude-fable-5', coldStartHold: probe }))
    expect(called).toBe(false)
  })

  it('does not invoke the cold-start probe inside the base grace', () => {
    let called = false
    const probe = () => { called = true; return true }
    decideStartupModelGate(facts({ ageSec: 60, coldStartHold: probe }))
    expect(called).toBe(false)
  })

  it('matches models through normalization (date-suffixed id vs bare id)', () => {
    expect(decideStartupModelGate(facts({
      measured: 'claude-haiku-4-5-20251001',
      configured: 'claude-haiku-4-5',
    }))).toBe('verified')
  })
})
