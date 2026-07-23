import { describe, it, expect, beforeAll } from 'vitest'
import {
  initDatabase,
  createAgentMessage,
  claimPendingForAgent,
  ackClaimedMessages,
  expireStaleClaims,
  markMessageDelivered,
  getAgentConversation,
  LEASE_SEC,
} from '../db.js'

beforeAll(() => { initDatabase(':memory:') }) // fresh, isolated schema'd DB

// Claim-lease + ack (silent-loss fix, 2026-07-19 incident msg#1791). Contract:
//   - claimPendingForAgent stamps claim_lease_until = now + LEASE_SEC on claim;
//   - ackClaimedMessages clears the lease (delivery FINAL), scoped to to_agent
//     and idempotent;
//   - expireStaleClaims returns an unacked, past-deadline claim to 'pending'
//     (delivered_at NULL, redeliveries++) so a lost drain redelivers -- and
//     touches NOTHING else (acked rows, legacy markMessageDelivered rows, and
//     still-pending rows all carry a NULL lease and are invisible to it).
// The DB is shared across the file (one in-memory init), so each test uses a
// unique to_agent id to stay independent.

const uniqAgent = (tag: string) => `lease-${tag}-${Date.now()}-${Math.floor(performance.now())}`
const nowSec = () => Math.floor(Date.now() / 1000)
// A deadline safely past any lease a claim in this test could have stamped.
const afterLease = () => nowSec() + LEASE_SEC + 5

// Re-read one row by id (no getById accessor; the conversation view is SELECT *).
function readRow(agent: string, id: number) {
  return getAgentConversation(agent, 200).find((m) => m.id === id)
}

describe('claimPendingForAgent sets a lease; ackClaimedMessages clears it', () => {
  it('claim stamps claim_lease_until ~now+LEASE_SEC; ack nulls it and returns the changed count', () => {
    const to = uniqAgent('claim-ack')
    const m = createAgentMessage('sub', to, 'hello')

    const t0 = nowSec()
    const [claimed] = claimPendingForAgent(to, 10)
    expect(claimed.id).toBe(m.id)
    expect(claimed.status).toBe('delivered')
    expect(claimed.redeliveries).toBe(0)
    // Lease is roughly now + LEASE_SEC (allow a 2s slack for a second tick-over).
    expect(claimed.claim_lease_until).not.toBeNull()
    expect(claimed.claim_lease_until!).toBeGreaterThanOrEqual(t0 + LEASE_SEC)
    expect(claimed.claim_lease_until!).toBeLessThanOrEqual(nowSec() + LEASE_SEC + 2)

    expect(ackClaimedMessages(to, [m.id])).toBe(1)
    const acked = readRow(to, m.id)
    expect(acked?.claim_lease_until).toBeNull() // delivery now FINAL
    expect(acked?.status).toBe('delivered') // ack clears only the lease, not the status
  })
})

describe('ackClaimedMessages is scoped to to_agent and idempotent', () => {
  it('cannot ack another agent\'s row, and re-acking leaves the lease cleared', () => {
    const to = uniqAgent('scope')
    const m = createAgentMessage('sub', to, 'scoped')
    claimPendingForAgent(to, 10)

    // Wrong to_agent -> 0 rows, and the real row's lease is untouched.
    expect(ackClaimedMessages('someone-else', [m.id])).toBe(0)
    expect(readRow(to, m.id)?.claim_lease_until).not.toBeNull()

    // Unknown id -> 0 rows (true no-op).
    expect(ackClaimedMessages(to, [999_999_999])).toBe(0)

    // Correct agent -> cleared; re-ack keeps the lease NULL (idempotent state).
    expect(ackClaimedMessages(to, [m.id])).toBe(1)
    expect(readRow(to, m.id)?.claim_lease_until).toBeNull()
    ackClaimedMessages(to, [m.id])
    expect(readRow(to, m.id)?.claim_lease_until).toBeNull()

    // Empty id list -> 0, no query run.
    expect(ackClaimedMessages(to, [])).toBe(0)
  })
})

describe('expireStaleClaims resets ONLY expired-leased claims', () => {
  it('a not-yet-expired lease is left alone', () => {
    const to = uniqAgent('fresh-lease')
    createAgentMessage('sub', to, 'x')
    claimPendingForAgent(to, 10)
    // Deadline = claim time + LEASE_SEC; expiring "as of now" must not fire.
    expect(expireStaleClaims(nowSec())).toEqual([])
  })

  it('expires the leased claim (pending, delivered_at NULL, redeliveries+1) and touches nothing else', () => {
    const claimAgent = uniqAgent('exp-claim')
    const ackAgent = uniqAgent('exp-ack')
    const legacyAgent = uniqAgent('exp-legacy')
    const pendingAgent = uniqAgent('exp-pending')

    const claimedMsg = createAgentMessage('sub', claimAgent, 'claimed')
    claimPendingForAgent(claimAgent, 10) // leased

    const ackedMsg = createAgentMessage('sub', ackAgent, 'acked')
    claimPendingForAgent(ackAgent, 10)
    ackClaimedMessages(ackAgent, [ackedMsg.id]) // lease NULL

    const legacyMsg = createAgentMessage('sub', legacyAgent, 'legacy')
    markMessageDelivered(legacyMsg.id) // delivered, lease NULL (router path)

    const pendingMsg = createAgentMessage('sub', pendingAgent, 'pending') // untouched pending

    const reset = expireStaleClaims(afterLease())
    const resetIds = reset.map((m) => m.id)

    // ONLY the leased 'delivered' claim is reset -- the acked, legacy, and still
    // -pending rows all carry a NULL lease and are skipped. expireStaleClaims is
    // GLOBAL and the in-memory DB is shared, so assert on THIS test's ids by
    // membership rather than exact-equality (another test's leased row may co-reset).
    expect(resetIds).toContain(claimedMsg.id)
    expect(resetIds).not.toContain(ackedMsg.id)
    expect(resetIds).not.toContain(legacyMsg.id)
    expect(resetIds).not.toContain(pendingMsg.id)
    const r = reset.find((m) => m.id === claimedMsg.id)!
    expect(r.status).toBe('pending')
    expect(r.delivered_at).toBeNull() // honest latency: the failed attempt is erased
    expect(r.claim_lease_until).toBeNull()
    expect(r.redeliveries).toBe(1)

    // Everything else is invisible to the expiry.
    expect(readRow(ackAgent, ackedMsg.id)?.status).toBe('delivered')
    expect(readRow(ackAgent, ackedMsg.id)?.redeliveries).toBe(0)
    expect(readRow(legacyAgent, legacyMsg.id)?.status).toBe('delivered')
    expect(readRow(legacyAgent, legacyMsg.id)?.redeliveries).toBe(0)
    expect(readRow(pendingAgent, pendingMsg.id)?.status).toBe('pending')
    expect(readRow(pendingAgent, pendingMsg.id)?.redeliveries).toBe(0)
  })
})

describe('re-claim after expiry redelivers with redeliveries=1', () => {
  it('the expired message is claimable again and its RETURNING shows redeliveries=1', () => {
    const to = uniqAgent('reclaim')
    const m = createAgentMessage('sub', to, 'redeliver-me')

    const [first] = claimPendingForAgent(to, 10)
    expect(first.redeliveries).toBe(0)

    // Global expiry: assert our message is among the reset ids (see the note above).
    expect(expireStaleClaims(afterLease()).map((x) => x.id)).toContain(m.id)

    // Back to pending -> claimable again, now counted as a redelivery, and with a
    // fresh lease so a second lost drain would expire it once more.
    const [second] = claimPendingForAgent(to, 10)
    expect(second.id).toBe(m.id)
    expect(second.content).toBe('redeliver-me')
    expect(second.redeliveries).toBe(1)
    expect(second.status).toBe('delivered')
    expect(second.claim_lease_until).not.toBeNull()
  })
})
