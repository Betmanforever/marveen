// Contract tests for the "delivered != landed" fix in the message router.
//
// Root cause (2026-07-08 incident): the router called markMessageDelivered
// UNCONDITIONALLY after sendPromptToSession returned. But sendPromptToSession's
// post-send retry loop has a 'give-up' branch that only logs.warn + breaks when
// the budget is spent and the text is STILL parked in the input box -- it does
// NOT throw. So delivered=true meant "the submit loop ran", not "the text was
// submitted". A message read delivered while it sat parked-unsubmitted in the
// pane.
//
// Fix: sendPromptToSession now returns a SendResult ('landed' | 'gave-up').
//   - decideDeliveryOutcome maps that to 'delivered' (mark delivered) vs
//     'retry' (leave pending for the next tick).
//   - shouldAbandonGaveUp bounds the retry so a gave-up message to a
//     PRESENT-but-stuck session cannot re-send forever: past the window it is
//     abandoned regardless of session presence (shouldAbandon only handles the
//     ABSENT case). Without this the fix would trade a false-delivered for an
//     eternal-retry regression.
//
// Both are pure, so unit-test them directly -- no tmux/db mocking needed.

import { describe, it, expect } from 'vitest'
import { decideDeliveryOutcome, shouldAbandonGaveUp } from '../web/message-router.js'

const WINDOW_MS = 60 * 60 * 1000 // 1 hour, same as MESSAGE_ABANDON_WINDOW_MS

describe('decideDeliveryOutcome: only a landed send is a real delivery', () => {
  it("maps 'landed' to 'delivered'", () => {
    // The pane was clean OR busy-processing (decideSubmitFollowup 'done'): the
    // text was conservatively submitted/accepted -> mark it delivered.
    expect(decideDeliveryOutcome('landed')).toBe('delivered')
  })

  it("maps 'gave-up' to 'retry' (NOT delivered)", () => {
    // The submit-retry budget was spent with the text still parked in the box.
    // This is the delivered!=landed bug: must NOT be marked delivered.
    expect(decideDeliveryOutcome('gave-up')).toBe('retry')
  })
})

describe('shouldAbandonGaveUp: a gave-up message cannot stay pending forever', () => {
  it('returns false within the window (keep retrying)', () => {
    // Not yet out-waited the retry window -> leave pending, the next tick re-sends.
    expect(shouldAbandonGaveUp(0, WINDOW_MS)).toBe(false)
    expect(shouldAbandonGaveUp(WINDOW_MS - 1, WINDOW_MS)).toBe(false)
  })

  it('returns true once past the window (abandon)', () => {
    // Out-waited the full window with the send still giving up -> abandon. This
    // bounds the oscillating clear->resend->gave-up loop against a PRESENT
    // session (shouldAbandon only bounds an ABSENT one), so the delivered!=landed
    // fix cannot introduce an unbounded re-send regression.
    expect(shouldAbandonGaveUp(WINDOW_MS + 1, WINDOW_MS)).toBe(true)
    expect(shouldAbandonGaveUp(WINDOW_MS * 2, WINDOW_MS)).toBe(true)
  })

  it('returns false at the exact window boundary (strict greater-than)', () => {
    // Boundary parity with shouldAbandon: ageMs === windowMs is NOT yet abandoned.
    expect(shouldAbandonGaveUp(WINDOW_MS, WINDOW_MS)).toBe(false)
  })

  it('is independent of session presence by design', () => {
    // The whole point: unlike shouldAbandon (which never abandons a PRESENT
    // session), the gave-up abandon does not consult session existence -- a
    // present-but-stuck session is exactly the case shouldAbandon cannot bound.
    // The function takes no sessionExists argument at all, so a stuck present
    // session past the window still abandons.
    expect(shouldAbandonGaveUp.length).toBe(2) // (ageMs, windowMs) -- no sessionExists
    expect(shouldAbandonGaveUp(WINDOW_MS + 1, WINDOW_MS)).toBe(true)
  })
})
