import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { STORE_DIR } from '../config.js'

// Inter-agent delivery-mode registry (reliability plan, Phase 0). This is a
// MODE-ONLY nameplate: it records which delivery path an agent is meant to use
// ('legacy' = the tmux send-keys router in message-router.ts, 'hook' = the
// future hook-based delivery). Phase 0 is INSTRUMENTATION ONLY -- nothing in
// the delivery path reads this yet; the sole consumer is the read-only
// /api/metrics/delivery endpoint, which reports each agent's declared mode.
// Flipping an agent to 'hook' has NO runtime effect until a later phase wires
// it in.
export type DeliveryMode = 'legacy' | 'hook'

export interface DeliveryConfig {
  agents: Record<string, DeliveryMode>
  default: DeliveryMode
}

// FAIL-SAFE default. A missing, unreadable, or corrupt config file MUST resolve
// to 'legacy' -- the delivery path that exists today -- so a bad file can never
// silently route an agent onto an unimplemented ('hook') path.
export const DEFAULT_DELIVERY_MODE: DeliveryMode = 'legacy'

const STORE_PATH = join(STORE_DIR, 'agent-delivery-config.json')

// Short read cache: getDeliveryMode may be called on hot paths (per-message in
// a future delivery phase, per-agent in the metrics endpoint). A TTL cache
// bounds fs reads to at most one per window while keeping the code trivial --
// no fs.watch lifecycle to own, no missed-event edge cases, and a few seconds
// of staleness on a (rare, operator-driven) mode flip is harmless. This is a
// deliberate choice of TTL over fs.watch for robustness.
const CACHE_TTL_MS = 5000
let cache: DeliveryConfig | null = null
let cacheLoadedAtMs = 0

function isDeliveryMode(v: unknown): v is DeliveryMode {
  return v === 'legacy' || v === 'hook'
}

/**
 * Pure normaliser: coerce arbitrary parsed JSON into a valid DeliveryConfig.
 * Junk is dropped rather than thrown on -- an unknown/invalid per-agent mode is
 * discarded (that agent then falls through to the default), and an invalid or
 * missing top-level default becomes DEFAULT_DELIVERY_MODE ('legacy'). Never
 * throws; always returns a usable config.
 */
export function parseDeliveryConfig(raw: unknown): DeliveryConfig {
  const out: DeliveryConfig = { agents: {}, default: DEFAULT_DELIVERY_MODE }
  if (!raw || typeof raw !== 'object') return out
  const obj = raw as Record<string, unknown>
  if (isDeliveryMode(obj['default'])) out.default = obj['default']
  const agents = obj['agents']
  if (agents && typeof agents === 'object') {
    for (const [id, mode] of Object.entries(agents as Record<string, unknown>)) {
      if (id && isDeliveryMode(mode)) out.agents[id] = mode
    }
  }
  return out
}

/**
 * Pure resolve: an agent's explicit entry wins; otherwise the config default.
 * Separated from the fs read so it is trivially unit-testable.
 */
export function resolveDeliveryMode(cfg: DeliveryConfig, agentId: string): DeliveryMode {
  return cfg.agents[agentId] ?? cfg.default
}

/**
 * Pure decision: is `agentId` a PULL-model agent -- one that CLAIMS its own
 * inbox rather than being tmux-pushed by the router? Two kinds qualify: the
 * main/coordinator agent (always pull -- it drains via the drain-inbox endpoint
 * + its UserPromptSubmit hook), and any agent an operator has flipped to 'hook'
 * delivery.
 *
 * This is the SINGLE SOURCE for two paths that MUST stay in lock-step or
 * inter-agent messages are lost or doubled:
 *   - the router (message-router.ts) SKIPS tmux-pushing to a pull-model agent
 *     -- pushing while the agent also drains its own inbox would DOUBLE-deliver;
 *   - the drain-inbox route (routes/agents.ts) ACCEPTS a claim ONLY from a
 *     pull-model agent -- serving a legacy agent there would double-deliver
 *     alongside the router's still-active tmux push.
 * Both call sites derive their decision from THIS predicate, so "router skips X"
 * and "drain accepts X" are the same set by construction and cannot drift.
 *
 * `modeOf` is INJECTED (not calling getDeliveryMode directly) to keep this pure
 * and unit-testable, mirroring aggregateDeliveryMetrics in delivery-metrics.ts.
 * Fail-safe rides entirely on modeOf: getDeliveryMode returns 'legacy' for any
 * unflipped agent AND for a missing/corrupt config file, so a non-main agent
 * defaults to the push path that exists today -- flipping to 'hook' is the only
 * thing that moves it, and only an operator does that.
 */
export function isPullModeAgent(
  agentId: string,
  mainAgentId: string,
  modeOf: (agentId: string) => DeliveryMode,
): boolean {
  return agentId === mainAgentId || modeOf(agentId) === 'hook'
}

/**
 * Read + parse a specific config file path. FAIL-SAFE: any error (missing file,
 * unreadable, malformed JSON) returns the default config ({} agents, 'legacy'
 * default) rather than throwing. Path is injectable so tests can exercise the
 * fail-safe behaviour against temp files without touching the live store.
 */
export function loadDeliveryConfigFromFile(path: string): DeliveryConfig {
  try {
    return parseDeliveryConfig(JSON.parse(readFileSync(path, 'utf-8')))
  } catch {
    return { agents: {}, default: DEFAULT_DELIVERY_MODE }
  }
}

/**
 * The current delivery mode for an agent, read from the live store config with
 * a short TTL cache. Fail-safe to 'legacy' end-to-end: a missing/corrupt file
 * yields an empty config, and an agent with no explicit entry resolves to the
 * (also-'legacy') default.
 */
export function getDeliveryMode(agentId: string): DeliveryMode {
  const now = Date.now()
  if (cache === null || now - cacheLoadedAtMs >= CACHE_TTL_MS) {
    cache = loadDeliveryConfigFromFile(STORE_PATH)
    cacheLoadedAtMs = now
  }
  return resolveDeliveryMode(cache, agentId)
}

/** Test-only: drop the cached config so the next getDeliveryMode re-reads. */
export function __resetDeliveryConfigCacheForTest(): void {
  cache = null
  cacheLoadedAtMs = 0
}
