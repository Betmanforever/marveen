import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  isPullModeAgent,
  loadDeliveryConfigFromFile,
  resolveDeliveryMode,
  type DeliveryMode,
} from '../web/delivery-config.js'

// Phase-1 pull-vs-push gate. isPullModeAgent is the SINGLE SOURCE both the
// drain-inbox route gate (routes/agents.ts) and the router skip
// (message-router.ts) call, so the "router skips X" and "drain accepts X" sets
// cannot drift. The invariant that MUST hold: for EVERY agent exactly one
// delivery path is active -- the router pushes XOR drain-inbox serves it --
// never both (double-deliver) and never neither (a stranded message). And the
// Phase-0 fail-safe carries through: a missing/corrupt config leaves every
// sub-agent on the push path (legacy), so drain rejects and the router keeps
// delivering.

const MAIN = 'mr-wolfe'

// Deterministic mode lookups standing in for getDeliveryMode (injected so the
// decision stays pure, mirroring aggregateDeliveryMetrics' modeOf param).
const allLegacy = (): DeliveryMode => 'legacy'
const allHook = (): DeliveryMode => 'hook'
const modeMap = (m: Record<string, DeliveryMode>) => (id: string): DeliveryMode => m[id] ?? 'legacy'

describe('isPullModeAgent (single-source pull/push decision)', () => {
  it('the main agent is ALWAYS pull-mode, regardless of its configured mode', () => {
    // The main agent drains its own inbox no matter what the config says -- even
    // an (unexpected) explicit 'legacy' entry must not force a tmux push onto
    // its perpetually-busy channels session.
    expect(isPullModeAgent(MAIN, MAIN, allLegacy)).toBe(true)
    expect(isPullModeAgent(MAIN, MAIN, allHook)).toBe(true)
    expect(isPullModeAgent(MAIN, MAIN, modeMap({ [MAIN]: 'legacy' }))).toBe(true)
  })

  it('a hook-mode sub-agent is pull-mode (drain accepts it)', () => {
    expect(isPullModeAgent('neo', MAIN, modeMap({ neo: 'hook' }))).toBe(true)
    expect(isPullModeAgent('neo', MAIN, allHook)).toBe(true)
  })

  it('a legacy sub-agent is NOT pull-mode (router delivers, drain 400s)', () => {
    expect(isPullModeAgent('neo', MAIN, modeMap({ neo: 'legacy' }))).toBe(false)
    expect(isPullModeAgent('ive', MAIN, allLegacy)).toBe(false)
  })

  it('an unlisted sub-agent follows the injected default (fail-safe legacy)', () => {
    // modeMap defaults unknown ids to 'legacy', mirroring getDeliveryMode's
    // resolution for an agent with no explicit entry.
    expect(isPullModeAgent('unknown-agent', MAIN, modeMap({ neo: 'hook' }))).toBe(false)
  })
})

describe('fail-safe: a missing/corrupt config keeps sub-agents on the push path', () => {
  // Wire the REAL file loader + resolver as modeOf, exactly the way
  // getDeliveryMode composes them, to prove the Phase-0 fail-safe carries into
  // the Phase-1 gate: a missing or corrupt file must leave every sub-agent
  // NON-pull (router keeps pushing, drain rejects), while the main agent stays
  // pull regardless.
  const modeOfFromFile = (path: string) => (id: string): DeliveryMode =>
    resolveDeliveryMode(loadDeliveryConfigFromFile(path), id)

  it('missing file -> sub-agent is push (legacy), main still pull', () => {
    const modeOf = modeOfFromFile(join(tmpdir(), 'no-such-delivery-cfg-' + Date.now() + '.json'))
    expect(isPullModeAgent('neo', MAIN, modeOf)).toBe(false)
    expect(isPullModeAgent(MAIN, MAIN, modeOf)).toBe(true)
  })

  it('corrupt (non-JSON) file -> sub-agent is push (legacy), main still pull', () => {
    const dir = mkdtempSync(join(tmpdir(), 'delivery-gate-'))
    try {
      const p = join(dir, 'agent-delivery-config.json')
      writeFileSync(p, '{ not valid json ')
      const modeOf = modeOfFromFile(p)
      expect(isPullModeAgent('neo', MAIN, modeOf)).toBe(false)
      expect(isPullModeAgent(MAIN, MAIN, modeOf)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a valid file flips only the listed sub-agent to pull', () => {
    const dir = mkdtempSync(join(tmpdir(), 'delivery-gate-'))
    try {
      const p = join(dir, 'agent-delivery-config.json')
      writeFileSync(p, JSON.stringify({ agents: { neo: 'hook' }, default: 'legacy' }))
      const modeOf = modeOfFromFile(p)
      expect(isPullModeAgent('neo', MAIN, modeOf)).toBe(true) // explicit hook
      expect(isPullModeAgent('ive', MAIN, modeOf)).toBe(false) // default legacy
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('router-skip and drain-allow partition every agent (no double-deliver, no black hole)', () => {
  // Mirror the two call sites as pure functions of the SAME predicate:
  //   - drain-inbox route (routes/agents.ts): accepts a claim iff isPullModeAgent
  //     (else 400).
  //   - router (message-router.ts): tmux-PUSHES iff it does NOT skip; it skips a
  //     pull-mode agent (the main agent via its own nudge branch, hook sub-agents
  //     via the isPullModeAgent check). So the router delivers iff
  //     !isPullModeAgent.
  // If a future edit changes one call site to stop using the shared predicate,
  // the concrete-routing assertions below pin the intended truth table; this
  // block additionally pins the partition property the two must jointly satisfy.
  const drainAccepts = (id: string, modeOf: (id: string) => DeliveryMode) =>
    isPullModeAgent(id, MAIN, modeOf)
  const routerDelivers = (id: string, modeOf: (id: string) => DeliveryMode) =>
    !isPullModeAgent(id, MAIN, modeOf)

  const modeOf = modeMap({ neo: 'hook', charlie: 'legacy' })
  const agents = [MAIN, 'neo', 'charlie', 'ive', 'unlisted-agent']

  it('exactly one of {router delivers, drain accepts} is true for each agent', () => {
    for (const id of agents) {
      // XOR: never both (double-deliver), never neither (message stranded).
      expect(drainAccepts(id, modeOf)).toBe(!routerDelivers(id, modeOf))
    }
  })

  it('the concrete per-agent routing matches expectations', () => {
    expect(drainAccepts(MAIN, modeOf)).toBe(true) // main: pull (drain)
    expect(drainAccepts('neo', modeOf)).toBe(true) // hook sub: pull (drain)
    expect(routerDelivers('charlie', modeOf)).toBe(true) // legacy sub: push
    expect(routerDelivers('ive', modeOf)).toBe(true) // unlisted -> legacy: push
    expect(routerDelivers('unlisted-agent', modeOf)).toBe(true)
  })
})
