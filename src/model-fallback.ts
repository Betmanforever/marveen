// Pure logic for the model-fallback-on-limit feature.
//
// Motivation: when an agent's Claude plan usage limit is reached, the Claude
// Code session pauses and prints a usage-limit banner in its tmux pane. Until
// the window resets (or the user intervenes) the agent is deaf. This feature
// detects that banner and downgrades the agent one step down a configured model
// chain (e.g. opus -> sonnet -> haiku), respawning the session so the cheaper
// model -- on a separate budget -- takes over without losing the conversation.
// After a revert window with no limit in sight, it climbs back to the primary.
//
// This module is dependency-free so every decision is unit-testable without a
// clock, tmux, or the filesystem. The I/O (capture-pane, model write, restart)
// lives in src/web/model-fallback-runner.ts; the config store lives in
// src/web/model-fallback-store.ts.

// Resolved full model IDs, mirroring MODEL_ALIASES in src/web/agent-config.ts.
// chain[0] is the primary (what we revert UP to); each subsequent entry is the
// next downgrade target. Kept as literals here to preserve the zero-import,
// trivially-testable property of this module.
export const DEFAULT_MODEL_CHAIN: readonly string[] = [
  'claude-opus-4-8[1m]',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
]

// Revert only well after the typical 5-hour plan window so we do not climb back
// to the primary just to re-trip the same limit. Configurable.
export const DEFAULT_REVERT_AFTER_MINUTES = 330

export interface ModelFallbackConfig {
  /** Master toggle. When false no agent is ever auto-switched. */
  enabled: boolean
  /** Primary-first model chain. Downgrades walk forward; revert goes to [0]. */
  chain: string[]
  /** Minutes a downgraded agent must stay limit-free before climbing back. */
  revertAfterMinutes: number
}

export const DEFAULT_MODEL_FALLBACK: ModelFallbackConfig = {
  enabled: false,
  chain: [...DEFAULT_MODEL_CHAIN],
  revertAfterMinutes: DEFAULT_REVERT_AFTER_MINUTES,
}

/** Coerce an untrusted parsed-JSON value into a valid config (defaults on junk). */
export function normalizeModelFallbackConfig(raw: unknown): ModelFallbackConfig {
  const o = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
  const enabled = o.enabled === true
  let chain = DEFAULT_MODEL_FALLBACK.chain
  if (Array.isArray(o.chain)) {
    const cleaned = o.chain.filter((m): m is string => typeof m === 'string' && m.trim().length > 0)
    // A chain needs at least a primary + one fallback to be meaningful.
    if (cleaned.length >= 2) chain = cleaned
  }
  let revertAfterMinutes = DEFAULT_MODEL_FALLBACK.revertAfterMinutes
  if (typeof o.revertAfterMinutes === 'number' && Number.isFinite(o.revertAfterMinutes) && o.revertAfterMinutes > 0) {
    revertAfterMinutes = Math.floor(o.revertAfterMinutes)
  }
  return { enabled, chain, revertAfterMinutes }
}

// The Claude Code usage-limit banner appears at the bottom of the pane (above
// the footer) when the plan budget is exhausted or nearly so. Match only the
// live banner region so a message body or scrollback that merely quotes the
// phrase does not trip a downgrade.
const USAGE_LIMIT_BANNER_REGION_LINES = 15

// Distinctive plan-limit phrasings. Deliberately NARROW: a generic "rate limit"
// / "API Error: 429" (transient overload, handled elsewhere) must NOT match --
// that is a momentary blip, not a plan-budget exhaustion that warrants a model
// switch.
const USAGE_LIMIT_RX =
  /(usage limit reached|reached your usage limit|hit (?:your|the) usage limit|approaching (?:your )?usage limit|usage limit (?:will )?reset|limit will reset at|\d+-hour limit reached|upgrade to increase your usage limit)/i

/**
 * True when the live pane shows a Claude *plan usage-limit* banner (not a
 * transient API 429). Pure + dependency-free. Restricted to the bottom region
 * so quoted text in scrollback or a reply body cannot trigger it.
 */
export function detectsUsageLimit(pane: string): boolean {
  if (!pane || !pane.trim()) return false
  const lines = pane.split('\n')
  const region = lines.slice(-USAGE_LIMIT_BANNER_REGION_LINES).join('\n')
  return USAGE_LIMIT_RX.test(region)
}

// --- Permanent model-access failures ("auto model drop", 2026-07-04) ---
//
// A separate failure class from the usage-limit banner: the configured model is
// no longer USABLE on this auth at all -- moved off the plan's included tier
// onto paid usage credit, retired, or access revoked. Claude Code's native
// `fallbackModel` (settings.json) never triggers on billing/auth errors per the
// official docs, so this is the layer that catches them. Key semantic
// difference: a usage-limit downgrade auto-reverts after the window (the limit
// resets); a model-access downgrade is STICKY -- auto-reverting would re-trip
// the same permanent error every revert window, so climbing back is an
// operator decision.
//
// A line triggers only when an API-error ANCHOR and a model/credit CAUSE
// co-occur on the SAME line, inside the live bottom region. Rationale: agent
// panes contain ordinary conversation text that can mention models or credits
// (an agent may even be editing this very file); the same-line anchor plus the
// region cap keeps false positives rare, and a false switch is recoverable
// (logged to config_change_log, announced to the main agent, reversible).
const ACCESS_ERROR_ANCHOR = /API Error|not_found_error|permission_error|invalid_request_error|billing_error/i

const ACCESS_CAUSE_RX = [
  /model .{0,60}not (found|available|supported|included)/i,
  /(does not|doesn'?t) have access to .{0,40}model/i,
  /no access to (this |the )?model/i,
  /invalid model/i,
  /model .{0,40}(retired|no longer available)/i,
  /(requires?|needs?) .{0,30}usage credits?/i,
  /(out of|insufficient|not enough) .{0,20}credits?/i,
  /credit balance is too low/i,
]

// Banner phrasings Claude Code renders WITHOUT an API-error prefix. Short and
// literal; extend here when a new provider wording shows up in the wild.
const ACCESS_BANNER_RX = [
  /credit balance too low/i,
]

/**
 * The first pane line showing a PERMANENT model-access failure (trimmed,
 * capped), or null. Same live-region scoping as detectsUsageLimit.
 */
export function detectsModelAccessFailure(pane: string): string | null {
  if (!pane || !pane.trim()) return null
  const lines = pane.split('\n').slice(-USAGE_LIMIT_BANNER_REGION_LINES)
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    const anchored = ACCESS_ERROR_ANCHOR.test(line) && ACCESS_CAUSE_RX.some((rx) => rx.test(line))
    const banner = ACCESS_BANNER_RX.some((rx) => rx.test(line))
    if (anchored || banner) return line.slice(0, 300)
  }
  return null
}

/**
 * The next model one step down the chain from `current`, or null if already at
 * the bottom. An unrecognised current model is treated as the primary, so the
 * first downgrade target (chain[1]) applies.
 */
export function nextFallbackModel(current: string, chain: string[]): string | null {
  if (chain.length < 2) return null
  const idx = chain.indexOf(current)
  if (idx < 0) return chain[1] ?? null
  if (idx >= chain.length - 1) return null
  return chain[idx + 1]
}

export interface ModelFallbackFacts {
  /** Whether the agent's pane currently shows a usage-limit banner. */
  limitDetected: boolean
  /** First pane line showing a permanent model-access failure, or null. */
  accessFailure?: string | null
  /** The agent's current resolved model id. */
  currentModel: string
  /** Primary-first model chain. */
  chain: string[]
  /** When this agent was last downgraded (ms epoch), or null if on primary. */
  downgradedAt: number | null
  /** The model the agent ran BEFORE its first downgrade (revert target). */
  downgradedFrom?: string | null
  /** True when the downgrade was access-failure driven: never auto-revert. */
  downgradeSticky?: boolean
  /** Current time (ms epoch). */
  now: number
  /** Revert window in ms. */
  revertAfterMs: number
}

export type ModelAction =
  | { kind: 'none' }
  | { kind: 'downgrade'; model: string; sticky: boolean; cause: 'model-access' | 'usage-limit' }
  | { kind: 'revert'; model: string }

/**
 * Decide what to do for one agent. Pure: the runner gates the I/O (idle pane,
 * actual write+restart) separately.
 *
 *   - access failure & a lower model exists -> STICKY downgrade (no auto-revert:
 *     the error is permanent, climbing back is an operator decision).
 *   - limit detected & a lower model exists -> downgrade (auto-reverts later).
 *   - already at the bottom -> nothing (cannot go lower).
 *   - no signal & non-sticky downgrade aged past the window -> revert to the
 *     agent's own pre-downgrade model (falling back to chain[0] when the
 *     origin was not recorded, e.g. after a dashboard restart).
 */
export function decideModelAction(f: ModelFallbackFacts): ModelAction {
  const accessFailure = f.accessFailure ?? null
  if (accessFailure || f.limitDetected) {
    const next = nextFallbackModel(f.currentModel, f.chain)
    if (next && next !== f.currentModel) {
      return accessFailure
        ? { kind: 'downgrade', model: next, sticky: true, cause: 'model-access' }
        : { kind: 'downgrade', model: next, sticky: false, cause: 'usage-limit' }
    }
    return { kind: 'none' }
  }
  if (f.downgradeSticky) return { kind: 'none' }
  if (f.downgradedAt !== null && f.now - f.downgradedAt >= f.revertAfterMs) {
    const target = f.downgradedFrom ?? f.chain[0]
    if (target && f.currentModel !== target) return { kind: 'revert', model: target }
  }
  return { kind: 'none' }
}
