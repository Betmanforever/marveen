import { describe, it, expect, beforeAll } from 'vitest'
import { initDatabase, getDb, getDeliveredLatenciesSince, getPendingCountsByAgent } from '../db.js'
import { percentile, aggregateDeliveryMetrics } from '../web/delivery-metrics.js'
import type { DeliveryMode } from '../web/delivery-config.js'

describe('percentile (nearest-rank)', () => {
  it('returns null for an empty sample', () => {
    expect(percentile([], 50)).toBeNull()
    expect(percentile([], 95)).toBeNull()
  })
  it('returns the single value for a one-element sample at any p', () => {
    expect(percentile([7], 50)).toBe(7)
    expect(percentile([7], 95)).toBe(7)
  })
  it('computes p50/p95/max over a 10-element sample', () => {
    const v = [10, 1, 5, 8, 3, 9, 2, 7, 4, 6] // unsorted on purpose
    expect(percentile(v, 50)).toBe(5) // rank ceil(0.5*10)=5 -> 5th smallest
    expect(percentile(v, 95)).toBe(10) // rank ceil(0.95*10)=10 -> largest
    expect(percentile(v, 100)).toBe(10)
    expect(percentile(v, 0)).toBe(1)
  })
  it('does not mutate the caller array', () => {
    const v = [3, 1, 2]
    percentile(v, 50)
    expect(v).toEqual([3, 1, 2])
  })
})

describe('aggregateDeliveryMetrics', () => {
  const modeOf = (a: string): DeliveryMode => (a === 'neo' ? 'hook' : 'legacy')

  it('returns [] when there is no traffic', () => {
    expect(aggregateDeliveryMetrics([], [], modeOf)).toEqual([])
  })

  it('aggregates per agent, attaches mode, and merges the pending cohort', () => {
    const latencies = [
      { to_agent: 'neo', latency_sec: 10 },
      { to_agent: 'neo', latency_sec: 20 },
      { to_agent: 'neo', latency_sec: 30 },
      { to_agent: 'ive', latency_sec: 5 },
    ]
    const pending = [
      { to_agent: 'neo', count: 2 },
      { to_agent: 'charlie', count: 4 }, // pending-only agent, zero deliveries
    ]
    const out = aggregateDeliveryMetrics(latencies, pending, modeOf)

    const neo = out.find(r => r.to_agent === 'neo')!
    expect(neo).toEqual({
      to_agent: 'neo', delivery_mode: 'hook', count: 3,
      p50_latency_sec: 20, p95_latency_sec: 30, max_latency_sec: 30, pending_now: 2,
    })

    const ive = out.find(r => r.to_agent === 'ive')!
    expect(ive).toEqual({
      to_agent: 'ive', delivery_mode: 'legacy', count: 1,
      p50_latency_sec: 5, p95_latency_sec: 5, max_latency_sec: 5, pending_now: 0,
    })

    // pending-only agent surfaces with null latencies and its pending count
    const charlie = out.find(r => r.to_agent === 'charlie')!
    expect(charlie).toEqual({
      to_agent: 'charlie', delivery_mode: 'legacy', count: 0,
      p50_latency_sec: null, p95_latency_sec: null, max_latency_sec: null, pending_now: 4,
    })

    // sorted by descending count, then name
    expect(out.map(r => r.to_agent)).toEqual(['neo', 'ive', 'charlie'])
  })

  it('clamps a negative (clock-skew) latency to 0', () => {
    const out = aggregateDeliveryMetrics([{ to_agent: 'neo', latency_sec: -5 }], [], modeOf)
    expect(out[0].max_latency_sec).toBe(0)
    expect(out[0].p50_latency_sec).toBe(0)
  })
})

// DB-level coverage of the read-only accessors: latency is derived from the
// existing created_at/delivered_at columns, the window is anchored on
// delivered_at, and only rows with a non-null delivered_at count.
describe('delivery metric DB accessors', () => {
  beforeAll(() => { initDatabase(':memory:') })

  it('reads delivered latencies in-window and pending counts, end to end', () => {
    const db = getDb()
    const ins = db.prepare(
      'INSERT INTO agent_messages (from_agent, to_agent, content, status, created_at, delivered_at) VALUES (?,?,?,?,?,?)',
    )
    const now = Math.floor(Date.now() / 1000)
    const DAY = 24 * 60 * 60
    const cutoff = now - 7 * DAY

    // neo: three delivered rows in-window, latencies 10/20/30
    ins.run('a', 'neo', 'x', 'delivered', now - 1000, now - 990)
    ins.run('a', 'neo', 'x', 'delivered', now - 1000, now - 980)
    ins.run('a', 'neo', 'x', 'delivered', now - 1000, now - 970)
    // ive: a 'done' row still has its delivered_at -> counts, latency 5
    ins.run('a', 'ive', 'x', 'done', now - 205, now - 200)
    // neo: delivered but OUTSIDE the window (delivered_at 8 days ago) -> excluded
    ins.run('a', 'neo', 'x', 'done', now - 8 * DAY - 10, now - 8 * DAY)
    // ive: failed with no delivered_at -> excluded from latencies
    ins.run('a', 'ive', 'x', 'failed', now - 50, null)
    // neo: two pending (no delivered_at) -> excluded from latencies, counted pending
    ins.run('a', 'neo', 'x', 'pending', now - 5, null)
    ins.run('a', 'neo', 'x', 'pending', now - 4, null)

    const latencies = getDeliveredLatenciesSince(cutoff)
    const neoLat = latencies.filter(r => r.to_agent === 'neo').map(r => r.latency_sec).sort((x, y) => x - y)
    const iveLat = latencies.filter(r => r.to_agent === 'ive').map(r => r.latency_sec)
    expect(neoLat).toEqual([10, 20, 30]) // the out-of-window neo row is absent
    expect(iveLat).toEqual([5]) // the failed (null delivered_at) ive row is absent

    const pending = getPendingCountsByAgent()
    expect(pending).toEqual([{ to_agent: 'neo', count: 2 }])

    // and the full pipe produces the expected aggregate
    const agg = aggregateDeliveryMetrics(latencies, pending, () => 'legacy')
    const neo = agg.find(r => r.to_agent === 'neo')!
    expect(neo.count).toBe(3)
    expect(neo.max_latency_sec).toBe(30)
    expect(neo.pending_now).toBe(2)
  })
})
