// Contract tests for the two pull-model backstops added after the 2026-07-12
// wedge (a sub-agent at 97% context stalled; four inter-agent messages sat
// pending 10+ min in BOTH directions -- including a coordinator-bound pull-model
// message -- with nothing alarming, because the escalation path is the same
// agent_messages queue that had starved):
//
//   - decidePendingAgeAlert  : the in-process pending-age watchdog's decision.
//     ANY pending row older than the threshold -> one DIRECT owner alert
//     (sendAlert, NOT agent_messages), deduped, re-armed by the caller when the
//     backlog clears.
//   - decideCoordinatorNudge : the coordinator inbox self-poll decision. The
//     oldest main-bound pending message older than the threshold -> a nudge that
//     starts a coordinator turn (its inbox drains on any turn), deduped globally.
//
// Both are pure, so unit-test them directly -- no tmux/db mocking needed.

import { describe, it, expect } from 'vitest'
import { decidePendingAgeAlert, decideCoordinatorNudge, shouldAlertStuckTarget } from '../web/message-router.js'

const THRESHOLD_MS = 3 * 60 * 1000 // 3 min
const DEDUP_MS = 15 * 60 * 1000 // 15 min

describe('decidePendingAgeAlert: one owner alert per stuck queue episode', () => {
  it('is false when no message is past the threshold', () => {
    expect(decidePendingAgeAlert([], null, 0, THRESHOLD_MS, DEDUP_MS)).toBe(false)
    expect(decidePendingAgeAlert([0, 1000, THRESHOLD_MS], null, 0, THRESHOLD_MS, DEDUP_MS)).toBe(false)
  })

  it('alerts on the first sighting of ANY over-threshold message', () => {
    // Only the oldest needs to be over threshold; a mix still fires.
    expect(decidePendingAgeAlert([0, THRESHOLD_MS + 1], null, 10_000, THRESHOLD_MS, DEDUP_MS)).toBe(true)
  })

  it('is boundary-strict (age === threshold is NOT yet an alert)', () => {
    expect(decidePendingAgeAlert([THRESHOLD_MS], null, 0, THRESHOLD_MS, DEDUP_MS)).toBe(false)
    expect(decidePendingAgeAlert([THRESHOLD_MS + 1], null, 0, THRESHOLD_MS, DEDUP_MS)).toBe(true)
  })

  it('dedups within the window and re-alerts once it elapses', () => {
    const lastAlert = 1_000_000
    // Still over threshold, but inside the dedup window -> stay quiet.
    expect(decidePendingAgeAlert([THRESHOLD_MS + 1], lastAlert, lastAlert + DEDUP_MS - 1, THRESHOLD_MS, DEDUP_MS)).toBe(false)
    // Dedup window elapsed (inclusive) -> alert again for the still-stuck queue.
    expect(decidePendingAgeAlert([THRESHOLD_MS + 1], lastAlert, lastAlert + DEDUP_MS, THRESHOLD_MS, DEDUP_MS)).toBe(true)
  })

  it('does not stall on backwards clock skew (alerts now)', () => {
    // A future lastAlertAt (NTP correction) would drive the delta negative; the
    // guard treats it as "alert now" instead of silently never alerting again.
    expect(decidePendingAgeAlert([THRESHOLD_MS + 1], 2_000_000, 1_000_000, THRESHOLD_MS, DEDUP_MS)).toBe(true)
  })
})

describe('decideCoordinatorNudge: idle-coordinator inbox self-poll', () => {
  const NUDGE_THRESHOLD_MS = 3 * 60 * 1000
  const NUDGE_DEDUP_MS = 10 * 60 * 1000

  it('is false when there is no main-bound pending message', () => {
    expect(decideCoordinatorNudge(null, null, 0, NUDGE_THRESHOLD_MS, NUDGE_DEDUP_MS)).toBe(false)
  })

  it('is false while the oldest main-bound message is within the threshold', () => {
    expect(decideCoordinatorNudge(NUDGE_THRESHOLD_MS - 1, null, 0, NUDGE_THRESHOLD_MS, NUDGE_DEDUP_MS)).toBe(false)
    // Boundary-strict: exactly at threshold is not yet a nudge.
    expect(decideCoordinatorNudge(NUDGE_THRESHOLD_MS, null, 0, NUDGE_THRESHOLD_MS, NUDGE_DEDUP_MS)).toBe(false)
  })

  it('nudges once the oldest main-bound message passes the threshold', () => {
    expect(decideCoordinatorNudge(NUDGE_THRESHOLD_MS + 1, null, 10_000, NUDGE_THRESHOLD_MS, NUDGE_DEDUP_MS)).toBe(true)
  })

  it('dedups within the window and nudges again once it elapses', () => {
    const lastNudge = 1_000_000
    expect(decideCoordinatorNudge(NUDGE_THRESHOLD_MS + 1, lastNudge, lastNudge + NUDGE_DEDUP_MS - 1, NUDGE_THRESHOLD_MS, NUDGE_DEDUP_MS)).toBe(false)
    expect(decideCoordinatorNudge(NUDGE_THRESHOLD_MS + 1, lastNudge, lastNudge + NUDGE_DEDUP_MS, NUDGE_THRESHOLD_MS, NUDGE_DEDUP_MS)).toBe(true)
  })

  it('does not stall on backwards clock skew (nudges now)', () => {
    expect(decideCoordinatorNudge(NUDGE_THRESHOLD_MS + 1, 2_000_000, 1_000_000, NUDGE_THRESHOLD_MS, NUDGE_DEDUP_MS)).toBe(true)
  })
})

describe('shouldAlertStuckTarget: busy-vs-wedged discrimination', () => {
  const CEILING_MS = 15 * 60 * 1000
  const AGE_MS = 4 * 60 * 1000 // past the 3-min threshold, well under the ceiling

  it('suppresses a healthy-busy target (working turn = latency, not starvation)', () => {
    // The 2026-07-13 09:00 false alarm: coordinator mid-turn, no wedge signal.
    expect(shouldAlertStuckTarget('busy', false, AGE_MS, CEILING_MS)).toBe(false)
  })

  it('alerts on a non-busy target regardless of wedge signal', () => {
    expect(shouldAlertStuckTarget('idle', false, AGE_MS, CEILING_MS)).toBe(true)
    expect(shouldAlertStuckTarget('typing', false, AGE_MS, CEILING_MS)).toBe(true)
  })

  it('alerts on a busy target that shows a wedge signal (parked input / context ceiling)', () => {
    expect(shouldAlertStuckTarget('busy', true, AGE_MS, CEILING_MS)).toBe(true)
  })

  it('fail-open: an unreadable pane always alerts', () => {
    expect(shouldAlertStuckTarget(null, false, AGE_MS, CEILING_MS)).toBe(true)
    expect(shouldAlertStuckTarget('unknown', false, AGE_MS, CEILING_MS)).toBe(true)
    expect(shouldAlertStuckTarget('error', false, AGE_MS, CEILING_MS)).toBe(true)
  })

  it('hard ceiling re-includes even a healthy-busy target (endless turn = starvation)', () => {
    // Boundary-strict: exactly at the ceiling is still suppressed for busy.
    expect(shouldAlertStuckTarget('busy', false, CEILING_MS, CEILING_MS)).toBe(false)
    expect(shouldAlertStuckTarget('busy', false, CEILING_MS + 1, CEILING_MS)).toBe(true)
  })
})
