import type { AgentMessage } from '../db.js'
import type { AgentMessageCategory } from './agent-message-wrap.js'

// Pure builders for the inbox-drain PULL path (routes/agents.ts). Kept out of
// the route handler -- which is not loadable in a unit test (heavy import graph)
// -- so the response shaping and the ack-input validation are trivially
// testable, mirroring delivery-config.ts / delivery-metrics.ts. No DB, no fs,
// no clock.

// Prepended to a redelivered message's block so the receiving agent can no-op a
// double-process (a prior claim's lease expired unacked, so the content may
// already be in its context). ASCII-only, like the router's wake-nudge prompts,
// and a self-contained line ABOVE the security preamble. Injected here on the
// caller side -- NOT inside agent-message-wrap, which is the single source of
// the trust framing and stays untouched.
export const REDELIVERY_DEDUP_MARKER =
  '[ismetelt kezbesites lehetseges -- ha mar feldolgoztad, hagyd figyelmen kivul]\n'

// Max ids a single ack call may carry. A legitimate ack is <= INBOX_DRAIN_CAP
// (10) ids; this bound rejects an abusive/buggy oversized body well under
// SQLite's bound-parameter limit.
export const ACK_IDS_CAP = 100

// The subset of an agent_messages row the drain response reads.
type ClaimedRow = Pick<AgentMessage, 'id' | 'from_agent' | 'to_agent' | 'content' | 'redeliveries'>

// Injected (not imported directly) so the builder stays pure and the route
// passes the real classify/wrap from agent-message-wrap.ts. Signatures mirror
// classifyAgentMessage / wrapAgentMessageForDelivery.
type ClassifyFn = (fromAgent: string, toAgent: string) => { category: AgentMessageCategory; safeFrom: string } | null
type WrapFn = (
  category: AgentMessageCategory,
  safeFrom: string,
  fromAgent: string,
  content: string,
  msgId?: number,
) => { prefix: string; wrapped: string }

export interface DrainResponse {
  count: number
  // ids of the framed (shown) messages -- what the hook ACKs to clear their lease.
  ids: number[]
  text: string
  // ids whose from_agent could not be safely framed (empty after sanitize). The
  // route FAILS these so a claim lease cannot later expire and redeliver an
  // un-frameable row forever (the router fails these the same way).
  unframeableIds: number[]
}

// Build the drain response from the claimed rows: wrap each safely-frameable
// message (prepending the dedup marker on a redelivery) and collect its id for
// acking; segregate un-frameable rows for the route to fail. `count` and `ids`
// track only the framed blocks, so text/ids/count stay consistent.
export function buildDrainResponse(claimed: ClaimedRow[], classify: ClassifyFn, wrap: WrapFn): DrainResponse {
  const blocks: string[] = []
  const ids: number[] = []
  const unframeableIds: number[] = []
  for (const msg of claimed) {
    const cls = classify(msg.from_agent, msg.to_agent)
    if (!cls) { unframeableIds.push(msg.id); continue } // empty from_agent -> cannot frame safely
    const { prefix, wrapped } = wrap(cls.category, cls.safeFrom, msg.from_agent, msg.content, msg.id)
    const marker = msg.redeliveries > 0 ? REDELIVERY_DEDUP_MARKER : ''
    blocks.push(marker + prefix + wrapped)
    ids.push(msg.id)
  }
  return { count: blocks.length, ids, text: blocks.join('\n\n'), unframeableIds }
}

// Validate an ack request body ({ ids: number[] }). Non-object, missing/non-array
// ids, an over-cap length, or any non-integer element -> { ok:false } (the route
// answers 400). An empty array is valid (acks nothing).
export function parseAckIds(raw: unknown): { ok: true; ids: number[] } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'body must be a JSON object with an ids array' }
  const ids = (raw as Record<string, unknown>).ids
  if (!Array.isArray(ids)) return { ok: false, error: 'ids must be an array' }
  if (ids.length > ACK_IDS_CAP) return { ok: false, error: `ids exceeds the ${ACK_IDS_CAP} cap` }
  if (!ids.every((v) => Number.isInteger(v))) return { ok: false, error: 'ids must all be integers' }
  return { ok: true, ids: ids as number[] }
}
