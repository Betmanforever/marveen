import { describe, it, expect } from 'vitest'
import {
  buildDrainResponse,
  parseAckIds,
  REDELIVERY_DEDUP_MARKER,
  ACK_IDS_CAP,
} from '../web/inbox-drain-response.js'
import type { AgentMessageCategory } from '../web/agent-message-wrap.js'

// Pure builders behind the drain-inbox / drain-ack routes (routes/agents.ts).
// The route is a thin wrapper: it claims rows, calls buildDrainResponse, fails
// the unframeable ids, and returns { count, ids, text }; the ack route parses
// with parseAckIds and answers 400 on { ok:false }. Testing the pure helpers
// pins that route logic without loading the route's heavy import graph (same
// approach as delivery-gate.test.ts / remote-api.test.ts).

// Injected classify/wrap stand-ins mirroring agent-message-wrap's signatures. An
// EMPTY from_agent classifies to null (un-frameable), exactly as the real
// sanitize path does; everything else is a trusted-peer for the fake.
const fakeClassify = (from: string, _to: string): { category: AgentMessageCategory; safeFrom: string } | null =>
  from ? { category: 'trusted-peer', safeFrom: from } : null
const fakeWrap = (
  _category: AgentMessageCategory,
  safeFrom: string,
  _from: string,
  content: string,
  msgId?: number,
) => ({ prefix: `PFX[${safeFrom} #${msgId}]: `, wrapped: `<w>${content}</w>` })

const row = (id: number, redeliveries: number, from = 'neo') => ({
  id, from_agent: from, to_agent: 'mr-wolfe', content: `c${id}`, redeliveries,
})

describe('buildDrainResponse', () => {
  it('returns the claimed-and-shown ids alongside count and text', () => {
    const res = buildDrainResponse([row(11, 0), row(12, 0)], fakeClassify, fakeWrap)
    expect(res.count).toBe(2)
    expect(res.ids).toEqual([11, 12]) // the hook ACKs exactly these
    expect(res.unframeableIds).toEqual([])
    expect(res.text).toContain('<w>c11</w>')
    expect(res.text).toContain('<w>c12</w>')
    expect(res.text.split('\n\n').length).toBe(2) // one block per message
  })

  it('prepends the dedup marker to a redelivered block, but NOT to a fresh one', () => {
    const fresh = buildDrainResponse([row(1, 0)], fakeClassify, fakeWrap)
    expect(fresh.text).not.toContain(REDELIVERY_DEDUP_MARKER)

    const redelivered = buildDrainResponse([row(2, 3)], fakeClassify, fakeWrap)
    expect(redelivered.text).toContain(REDELIVERY_DEDUP_MARKER)
    // The marker leads the block (sits above the security preamble the wrap adds).
    expect(redelivered.text.startsWith(REDELIVERY_DEDUP_MARKER)).toBe(true)
  })

  it('segregates an un-frameable (empty from_agent) row: not shown, not acked, listed for failing', () => {
    const res = buildDrainResponse([row(5, 0, ''), row(6, 0, 'neo')], fakeClassify, fakeWrap)
    expect(res.count).toBe(1)
    expect(res.ids).toEqual([6]) // only the frameable one is acked
    expect(res.unframeableIds).toEqual([5]) // the route markMessageFailed's this
    expect(res.text).toContain('<w>c6</w>')
    expect(res.text).not.toContain('c5')
  })

  it('an empty claim set yields an empty response', () => {
    expect(buildDrainResponse([], fakeClassify, fakeWrap)).toEqual({
      count: 0, ids: [], text: '', unframeableIds: [],
    })
  })
})

describe('parseAckIds (ack-route input validation -> 400 on { ok:false })', () => {
  it('accepts a valid integer id array', () => {
    expect(parseAckIds({ ids: [1, 2, 3] })).toEqual({ ok: true, ids: [1, 2, 3] })
  })

  it('accepts an empty array (acks nothing)', () => {
    expect(parseAckIds({ ids: [] })).toEqual({ ok: true, ids: [] })
  })

  it('rejects a non-array ids (the 400 case)', () => {
    for (const bad of [{ ids: 'nope' }, { ids: 5 }, { ids: null }, {}, null, undefined, 'x', 42, []]) {
      expect(parseAckIds(bad as unknown).ok).toBe(false)
    }
  })

  it('rejects any non-integer element', () => {
    expect(parseAckIds({ ids: [1, 2.5] }).ok).toBe(false)
    expect(parseAckIds({ ids: [1, '2'] }).ok).toBe(false)
    expect(parseAckIds({ ids: [NaN] }).ok).toBe(false)
  })

  it('rejects an over-cap id list', () => {
    const tooMany = Array.from({ length: ACK_IDS_CAP + 1 }, (_, i) => i)
    expect(parseAckIds({ ids: tooMany }).ok).toBe(false)
    // exactly at the cap is fine
    const atCap = Array.from({ length: ACK_IDS_CAP }, (_, i) => i)
    expect(parseAckIds({ ids: atCap }).ok).toBe(true)
  })
})
