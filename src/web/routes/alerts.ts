import { renderDigest } from '../../alert-policy.js'
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

  if (path === '/api/alerts/digest' && method === 'GET') {
    // consume=1 clears the buffer, so the same finding is never reported twice.
    // Callers that only want to LOOK (dashboard, a human checking) must omit it.
    const consume = url.searchParams.get('consume') === '1'
    json(res, renderDigest(Date.now(), { consume }))
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
