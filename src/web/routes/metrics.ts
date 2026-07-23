import { getDeliveredLatenciesSince, getPendingCountsByAgent } from '../../db.js'
import { getDeliveryMode } from '../delivery-config.js'
import { aggregateDeliveryMetrics } from '../delivery-metrics.js'
import { json } from '../http-helpers.js'
import { logger } from '../../logger.js'
import type { RouteContext } from './types.js'

const DELIVERY_WINDOW_DAYS = 7

// Read-only inter-agent delivery metrics (reliability plan, Phase 0). Auth is
// enforced by the /api/* Bearer gate in web.ts; this handler only reads.
export async function tryHandleMetrics(ctx: RouteContext): Promise<boolean> {
  const { res, path, method } = ctx

  if (path === '/api/metrics/delivery' && method === 'GET') {
    try {
      const cutoff = Math.floor(Date.now() / 1000) - DELIVERY_WINDOW_DAYS * 24 * 60 * 60
      const latencies = getDeliveredLatenciesSince(cutoff)
      const pending = getPendingCountsByAgent()
      const agents = aggregateDeliveryMetrics(latencies, pending, getDeliveryMode)
      json(res, {
        window_days: DELIVERY_WINDOW_DAYS,
        generated_at: Math.floor(Date.now() / 1000),
        agents,
      })
    } catch (err) {
      logger.error({ err }, 'Delivery metrics query failed')
      json(res, { error: 'Metrics query failed' }, 500)
    }
    return true
  }

  return false
}
