import { renderDigest, ackDigestConsume } from '../../alert-policy.js'
import { listLiveAlertClaims } from '../../db.js'
import { json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

// Alert-policy read surface (audit AC-7/AC-4).
//
// The digest is delivered INSIDE the morning briefing rather than as its own
// message: one more scheduled message would be one more interruption, which is
// the problem this whole card is about. scripts/morning-briefing.sh fetches the
// rendered section with consume=1 right before it composes the briefing.
export async function tryHandleAlerts(ctx: RouteContext): Promise<boolean> {
  const { res, path, method, url } = ctx

  // Read-only: look at the pending digest without touching it.
  if (path === '/api/alerts/digest' && method === 'GET') {
    json(res, renderDigest(Date.now()))
    return true
  }

  // Consuming read: returns the section and PARKS the rendered entries under
  // an ack token (close condition C-4) -- the delete happens only at the ack
  // below, sent after the briefing actually went out, so a briefing that dies
  // after this fetch costs a delay, not the night's findings. POST, not a GET
  // flag: it mutates state, and only non-safe methods pass through this
  // server's cross-origin write guard (isBlockedCrossOriginWrite treats every
  // GET as safe by definition).
  if (path === '/api/alerts/digest/consume' && method === 'POST') {
    json(res, renderDigest(Date.now(), { consume: true }))
    return true
  }

  // Second phase: the briefing was delivered, drop the parked entries. A
  // stale/unknown token answers ok:false and changes nothing.
  if (path === '/api/alerts/digest/ack' && method === 'POST') {
    const token = url.searchParams.get('token') || ''
    if (!token) { json(res, { error: 'token is required' }, 400); return true }
    json(res, { ok: ackDigestConsume(token) })
    return true
  }

  if (path === '/api/alerts/claims' && method === 'GET') {
    const signal = url.searchParams.get('signal') || ''
    if (!signal) { json(res, { error: 'signal is required' }, 400); return true }
    json(res, listLiveAlertClaims(signal, Math.floor(Date.now() / 1000)))
    return true
  }

  return false
}
