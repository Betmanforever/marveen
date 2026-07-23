import type { DeliveryMode } from './delivery-config.js'

// Read-only inter-agent delivery metrics (reliability plan, Phase 0). All logic
// here is PURE -- it takes already-fetched DB rows and a mode lookup and
// produces the aggregate the /api/metrics/delivery endpoint returns. No DB, no
// fs, no clock: fully unit-testable.

/** One delivered message's latency, as returned by the DB accessor. */
export interface DeliveredLatencyRow {
  to_agent: string
  latency_sec: number
}

/** Pending-message count for one target agent (now snapshot). */
export interface PendingCountRow {
  to_agent: string
  count: number
}

/** Per-agent delivery metric row emitted by the endpoint. */
export interface DeliveryAgentMetric {
  to_agent: string
  delivery_mode: DeliveryMode
  count: number
  p50_latency_sec: number | null
  p95_latency_sec: number | null
  max_latency_sec: number | null
  pending_now: number
}

/**
 * Nearest-rank percentile over a numeric sample. `p` is a percentage in
 * [0, 100]. Returns an ACTUAL observed value (no interpolation) so a latency
 * percentile is always a latency that really happened -- honest for an ops
 * dashboard and free of fractional-second artifacts. Empty sample -> null.
 *
 * Nearest-rank: sort ascending, take the value at 1-based rank
 * ceil(p/100 * n), clamped to [1, n].
 */
export function percentile(values: number[], p: number): number | null {
  const n = values.length
  if (n === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  if (p <= 0) return sorted[0]
  if (p >= 100) return sorted[n - 1]
  const rank = Math.ceil((p / 100) * n)
  const idx = Math.min(Math.max(rank, 1), n) - 1
  return sorted[idx]
}

/**
 * Aggregate delivered-latency rows + pending counts into per-agent metrics.
 *
 * The agent key set is the UNION of agents seen in the delivered window and
 * agents with pending messages now, so an agent that only has a stuck pending
 * queue (zero recent deliveries) still surfaces. Each agent's delivery_mode is
 * attached via `modeOf` (the config reader). Latencies are clamped at 0 to
 * absorb any clock-skew row where delivered_at < created_at. Output is sorted
 * by descending count, then agent name, for a stable table.
 */
export function aggregateDeliveryMetrics(
  latencies: DeliveredLatencyRow[],
  pending: PendingCountRow[],
  modeOf: (agentId: string) => DeliveryMode,
): DeliveryAgentMetric[] {
  const byAgent = new Map<string, number[]>()
  for (const row of latencies) {
    if (!row.to_agent) continue
    const arr = byAgent.get(row.to_agent) ?? []
    arr.push(Math.max(0, row.latency_sec))
    byAgent.set(row.to_agent, arr)
  }

  const pendingByAgent = new Map<string, number>()
  for (const row of pending) {
    if (!row.to_agent) continue
    pendingByAgent.set(row.to_agent, row.count)
  }

  const agents = new Set<string>([...byAgent.keys(), ...pendingByAgent.keys()])
  const out: DeliveryAgentMetric[] = []
  for (const agent of agents) {
    const lat = byAgent.get(agent) ?? []
    out.push({
      to_agent: agent,
      delivery_mode: modeOf(agent),
      count: lat.length,
      p50_latency_sec: percentile(lat, 50),
      p95_latency_sec: percentile(lat, 95),
      // max via percentile(100) -> sorted[n-1]: avoids a Math.max(...spread)
      // arg-count footgun on a large backlog and keeps all three stats uniform.
      max_latency_sec: percentile(lat, 100),
      pending_now: pendingByAgent.get(agent) ?? 0,
    })
  }

  out.sort((a, b) => (b.count - a.count) || a.to_agent.localeCompare(b.to_agent))
  return out
}
