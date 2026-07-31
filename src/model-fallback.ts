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
// The full fleet ladder (Gabor's final order, 2026-07-04): each agent's HOME
// RUNG on it is a monthly-review decision; the chain itself never steps onto a
// PRICIER model, per pricing re-verified from the primary source 2026-07-31
// (Fable $10/$50 -> Opus 5 $5/$25 -> Opus 4.8 $5/$25, same price but older
// tier -> Sonnet 5 $3/$15, intro $2/$10 through 2026-08-31 -> Sonnet 4.6,
// same list price but older tier -> Haiku $1/$5) -- downgrading onto a pricier
// model during limit exhaustion would be counterproductive.
// Opus 5 is the fleet's current PRIMARY rung (repo-root .claude/settings.json
// for the main agent, agent-config.json for most sub-agents); while it was
// missing from this list a limited primary read as an unrecognised model and
// landed straight on Sonnet 5, skipping the whole Opus tier.
// Kept as literals to preserve the zero-import, trivially-testable property.
export const DEFAULT_MODEL_CHAIN: readonly string[] = [
  'claude-fable-5',
  'claude-opus-5',
  'claude-opus-4-8[1m]',
  'claude-sonnet-5',
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
// switch. The "session limit" wordings are the same plan-budget class under
// another name (observed live 2026-07-05: "You've hit your session limit ·
// resets 3:10am" -- pre-fix it fell through to the unrecognized-error
// telemetry and no downgrade happened). Bare "session limit" prose stays a
// non-match; each session alternative needs the hit/reached/resets framing,
// and both the · and ∙ separator glyphs are accepted before "resets".
const USAGE_LIMIT_RX =
  /(usage limit reached|reached your usage limit|hit (?:your|the) (?:usage|session) limit|approaching (?:your )?usage limit|usage limit (?:will )?reset|limit will reset at|\d+-hour limit reached|upgrade to increase your usage limit|session limit reached|session limit\s*[·∙]\s*resets)/i

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

// Reset-time capture next to the limit banner: "resets 3:10am",
// "resets 5pm", "limit will reset at 18:00". Deliberately a TIGHT time shape
// (clock time with optional am/pm, or hour+am/pm) rather than free text: the
// pane is untrusted terminal content and callers interpolate the captured
// value into operator alerts, so anything that does not look like a clock
// time simply reports as unknown.
const LIMIT_RESET_RX = /reset(?:s)?(?:\s+at)?\s+(\d{1,2}:\d{2}\s*(?:am|pm)?|\d{1,2}\s*(?:am|pm))/i

/**
 * The reset time shown next to the live usage/session-limit banner (e.g.
 * "3:10am" from "resets 3:10am"), or null when absent. Same live-region
 * scoping as detectsUsageLimit so a quoted line in scrollback cannot feed it.
 */
export function extractLimitReset(pane: string): string | null {
  if (!pane || !pane.trim()) return null
  const lines = pane.split('\n')
  const region = lines.slice(-USAGE_LIMIT_BANNER_REGION_LINES).join('\n')
  const m = region.match(LIMIT_RESET_RX)
  return m ? m[1].trim() : null
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

// Known-transient API-error phrasings: normal retry territory, never a reason
// to switch models and not interesting for the unrecognized-error telemetry.
const TRANSIENT_ERROR_RX = /rate_limit|overloaded|429|529|timed? ?out|connection|ECONN|network/i

/**
 * Telemetry helper (audit F8): the first live-region line that carries an
 * API-error anchor but matches NO known cause and NO known-transient class --
 * i.e. a wording we might need to add to ACCESS_CAUSE_RX. The exact error text
 * of future entitlement changes is unknown in advance; the runner logs these
 * so the pattern list can be extended from evidence instead of guesses.
 */
export function detectsUnrecognizedApiError(pane: string): string | null {
  if (!pane || !pane.trim()) return null
  const lines = pane.split('\n').slice(-USAGE_LIMIT_BANNER_REGION_LINES)
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    if (!ACCESS_ERROR_ANCHOR.test(line)) continue
    if (ACCESS_CAUSE_RX.some((rx) => rx.test(line))) continue
    if (TRANSIENT_ERROR_RX.test(line)) continue
    if (USAGE_LIMIT_RX.test(line)) continue
    return line.slice(0, 300)
  }
  return null
}

/**
 * Strip a pane line for inclusion in an inter-agent message (audit C3): the
 * line is UNTRUSTED terminal content and the message lands in another agent's
 * context -- a prompt-injection channel. Keep it short, printable, quote-safe.
 * Anchor tokens are defused (audit R3): the quote will be rendered in the
 * RECIPIENT'S pane, and an intact "API Error ... model ..." line there could
 * echo-trigger this very detector against the recipient.
 */
export function sanitizeFailureSnippet(line: string): string {
  return line
    .replace(/[^\x20-\x7EáéíóöőúüűÁÉÍÓÖŐÚÜŰ]/g, ' ')
    .replace(/["'`\\[\]]/g, ' ')
    .replace(/API Error/gi, 'API-Err')
    .replace(/_error/gi, '-err')
    .replace(/credit balance/gi, 'credit-bal')
    .replace(/usage limit/gi, 'usage-lim')
    .replace(/session limit/gi, 'session-lim')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
}

// Where an UNRECOGNISED current model lands when it must downgrade. With the
// full fleet ladder in the default chain (Fable at [0]), an unknown model --
// a future release, a non-Claude experiment -- must NOT fall to chain[0]
// (that is now the priciest rung); the fleet-default rung is the safe
// landing. Falls back to chain[1] when the operator's chain has no such rung.
const UNKNOWN_MODEL_LANDING = 'claude-sonnet-5'

/**
 * The next model one step down the chain from `current`, or null if already
 * at the bottom. An unrecognised current model lands on the fleet-default
 * rung (see UNKNOWN_MODEL_LANDING).
 */
export function nextFallbackModel(current: string, chain: string[]): string | null {
  if (chain.length < 2) return null
  const idx = chain.indexOf(current)
  if (idx < 0) {
    return chain.includes(UNKNOWN_MODEL_LANDING) ? UNKNOWN_MODEL_LANDING : (chain[1] ?? null)
  }
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
  /** True when a live probe confirmed the pre-downgrade model works again
   * (the reset-trigger for sticky downgrades: quota refilled, credit added). */
  preferredUsable?: boolean
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
 *   - access failure & a lower model exists -> STICKY downgrade (no
 *     time-based auto-revert: the error is permanent as far as waiting goes).
 *   - limit detected & a lower model exists -> downgrade (auto-reverts later),
 *     but at most ONE step per limit window (see the cascade guard below).
 *   - already at the bottom -> nothing (cannot go lower).
 *   - sticky downgrade & a probe confirmed the preferred model works again
 *     (quota reset / usage credit added) -> revert to it. This is the
 *     reset-trigger: sticky means "do not revert on a TIMER", not "never".
 *   - no signal & non-sticky downgrade aged past the window -> revert to the
 *     agent's own pre-downgrade model (falling back to chain[0] when the
 *     origin was not recorded, e.g. after a dashboard restart).
 */
export function decideModelAction(f: ModelFallbackFacts): ModelAction {
  const accessFailure = f.accessFailure ?? null
  if (accessFailure || f.limitDetected) {
    // Cascade guard (2026-07-05 incident, config_change_log 6-9): the plan
    // limit is ACCOUNT-scoped, not per-model, so every respawn onto a cheaper
    // rung re-hit the SAME limit and the runner walked the whole ladder
    // fable -> opus -> sonnet -> haiku, one step per cooldown expiry. Stepping
    // down under a limit buys nothing and destroys capability, so a limit
    // signal is worth exactly ONE step per limit window: while a non-sticky
    // downgrade record is still inside the revert window, sit tight. Past the
    // window the record ages out and a fresh limit opens a new window.
    // Deliberately NOT applied to an access failure: that is a different error
    // class (this specific model is unusable, the next one may not be), so it
    // keeps walking the chain even with an active record. The guard keys on
    // the SIGNAL (limit vs access), not on the record's stickiness: a sticky
    // record (access-driven downgrade) followed by a genuine limit banner is
    // the same account-scoped limit, and stepping further down is just as
    // futile there (audit 2026-07-31, P1).
    if (
      !accessFailure
      && f.downgradedAt !== null
      && f.now - f.downgradedAt < f.revertAfterMs
    ) {
      return { kind: 'none' }
    }
    const next = nextFallbackModel(f.currentModel, f.chain)
    if (next && next !== f.currentModel) {
      return accessFailure
        ? { kind: 'downgrade', model: next, sticky: true, cause: 'model-access' }
        : { kind: 'downgrade', model: next, sticky: false, cause: 'usage-limit' }
    }
    return { kind: 'none' }
  }
  if (f.downgradeSticky) {
    if (f.preferredUsable && f.downgradedFrom && f.currentModel !== f.downgradedFrom) {
      return { kind: 'revert', model: f.downgradedFrom }
    }
    return { kind: 'none' }
  }
  if (f.downgradedAt !== null && f.now - f.downgradedAt >= f.revertAfterMs) {
    const target = f.downgradedFrom ?? f.chain[0]
    if (target && f.currentModel !== target) return { kind: 'revert', model: target }
  }
  return { kind: 'none' }
}

// The fleet's nightly pause: 22:00-06:00 in the host's local timezone
// (Europe/Budapest on this install). A REVERT costs a session restart and is
// never urgent -- the agent is working fine on the fallback model -- so it is
// deferred to the next daytime sweep. A DOWNGRADE is NOT gated: that one
// unsticks an agent sitting deaf on a limited or unusable model, which is
// exactly the failure the night shift must not sleep through.
export const QUIET_HOURS_START = 22
export const QUIET_HOURS_END = 6

/**
 * True when the given local hour-of-day (0-23) falls inside the fleet's quiet
 * window. Pure so the boundary is testable without mocking the clock; the
 * runner supplies `new Date(now).getHours()`.
 */
export function isQuietHour(hour: number): boolean {
  return hour >= QUIET_HOURS_START || hour < QUIET_HOURS_END
}
