// Contract tests for the pull-model backstops around the inter-agent queue.
//
// History: after the 2026-07-12 wedge (a sub-agent at 97% context stalled; four
// inter-agent messages sat pending 10+ min in BOTH directions -- including a
// coordinator-bound pull-model message -- with nothing alarming, because the
// escalation path is the same agent_messages queue that had starved) this file
// covered three age-based decisions.
//
// The 2026-07-31 alerting audit retired all three of those (RC-3 / predicate
// P3): decidePendingAgeAlert, decidePendingAgeRealert and shouldAlertStuckTarget
// keyed on AGE and pane STATE, which cannot tell a 20-minute working turn from a
// wedge -- and did not, at 16:44 that day. Their replacements are pane PROGRESS
// (pane-state.ts updatePaneProgress/isPaneStalled, covered in
// pane-progress.test.ts) and the escalation machine in pending-age-watchdog.ts
// (covered in pending-age-watchdog.test.ts).
//
// What remains here is what the audit did NOT touch: the coordinator inbox
// self-poll and the boot-grace suppression, both still pure and both still in
// the delivery path.

import { describe, it, expect } from 'vitest'
import { decideCoordinatorNudge, isTargetInBootGrace } from '../web/message-router.js'

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

describe('isTargetInBootGrace: boot-window suppression (2026-07-22 14:59 false alarm)', () => {
  const GRACE_MS = 5 * 60 * 1000

  it('claims the grace for a freshly started target process', () => {
    expect(isTargetInBootGrace(60_000, GRACE_MS)).toBe(true)
    expect(isTargetInBootGrace(0, GRACE_MS)).toBe(true)
  })

  it('boundary-strict: exactly at the grace edge is out of grace', () => {
    expect(isTargetInBootGrace(GRACE_MS, GRACE_MS)).toBe(false)
    expect(isTargetInBootGrace(GRACE_MS - 1, GRACE_MS)).toBe(true)
  })

  it('an old process never claims the grace', () => {
    expect(isTargetInBootGrace(60 * 60 * 1000, GRACE_MS)).toBe(false)
  })

  it('fail-open: unknown or negative process age never claims the grace', () => {
    expect(isTargetInBootGrace(null, GRACE_MS)).toBe(false)
    expect(isTargetInBootGrace(-1, GRACE_MS)).toBe(false)
  })
})
