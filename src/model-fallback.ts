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

// --- Unintended MODEL DRIFT (2026-07-31 incident, card b0c90a8a) ---
//
// A THIRD failure class, and the one the two detectors above are blind to by
// construction: the agent is answering on a model it was never configured for,
// with nothing in the pane to detect. Measured 2026-07-31: the main channels
// session was restarted at 15:01:01 with the CORRECT `--model claude-fable-5`
// (verified from the PID's cmdline), yet its first API call 29s later answered
// as claude-sonnet-5 and 22 assistant turns ran on Sonnet until 15:31, when the
// owner switched by hand. Cause: the dashboard itself was restarting between
// 15:01:01 and 15:02:06, so neither the channel-monitor's model-credit dialog
// branch (which navigates that dialog to the CONFIGURED model) nor this runner
// was alive; the credit gate resolved silently to its pre-highlighted "Switch
// to Sonnet 5" default and nothing put it back.
//
// The response is deliberately the OPPOSITE of a fallback: a usage-limit
// downgrade is intentional and steps DOWN the chain, a drift is unintended and
// must go BACK to the configured model. Everything below is pure; the runner
// supplies the measurement (see readBootModelSample) and gates the I/O (idle
// pane, restart, audit row).
//
// SCOPE, so nobody mistakes this for a general model-identity monitor: the
// measurement is what the CURRENT PROCESS BOOT started on, which is the
// restart-window failure above. A session that boots correctly and switches
// LATER is invisible here by construction -- that one belongs to the hourly
// scripts/check-model-drift.sh detector.

// The session's main-loop model is the majority of its EARLIEST model-bearing
// rows -- never the token-weighted dominant one. Where sub-agent turns land
// INLINE in the parent session log they can out-weigh the main loop outright
// (measured 2026-07-30 on session 0ba2dcef: fable 147k tokens vs opus 130k);
// Claude Code 2.1.220 writes them to a per-session `subagents/` sidecar
// instead (measured 2026-07-31 on session d1ab52c1). Sampling the first rows
// is correct under BOTH, because a sub-agent cannot answer before the main
// loop's own first turn. Both constants mirror scripts/check-model-drift.sh,
// which validated the rule against all 5 recent multi-model neo sessions.
export const DRIFT_SAMPLE_ROWS = 7
// ... but do not wait for all 7: the incident produced 6 Sonnet rows in the
// first 16 seconds and then nothing for 3.5 minutes. Three rows is enough to
// call the main loop, and it is what keeps the detector inside the ~65s
// restart window this feature exists to close.
export const DRIFT_MIN_ROWS = 3

/**
 * Compare-ready model id: strips the `[1m]` context-window marker and a
 * trailing `-YYYYMMDD` version pin, so `claude-opus-4-8[1m]` (config) and
 * `claude-opus-4-8` (API response) are the same model. Mirrors normalize() in
 * scripts/check-model-drift.sh. Alias expansion is NOT done here: the
 * configured side already comes through resolveModelId() and the measured side
 * is always a full API model id, so adding the alias map would only duplicate
 * agent-config.ts and break this module's zero-import property.
 */
export function normalizeModelId(model: string): string {
  return model.trim().replace(/\[1m\]/g, '').replace(/-20\d{6}$/, '')
}

/**
 * The main-loop model behind a session's earliest model-bearing rows, or null
 * when it cannot be called: fewer than `minRows` samples, or a tie.
 *
 * The tie -> null is a DELIBERATE deviation from the shell script, which takes
 * the first-inserted on a tie. There the output is a report line a human
 * reads; here it restarts a live session, so an ambiguous sample must mean "no
 * measurement" and let the next sweep (one more row) resolve it.
 */
export function deriveMeasuredModel(models: readonly string[], minRows = DRIFT_MIN_ROWS): string | null {
  const sample = models.filter((m) => typeof m === 'string' && m.trim().length > 0).slice(0, DRIFT_SAMPLE_ROWS)
  if (sample.length < minRows) return null
  const counts = new Map<string, number>()
  for (const m of sample) counts.set(m, (counts.get(m) ?? 0) + 1)
  let best: string | null = null
  let bestCount = 0
  let tied = false
  for (const [model, count] of counts) {
    if (count > bestCount) { best = model; bestCount = count; tied = false }
    else if (count === bestCount) tied = true
  }
  return tied ? null : best
}

/** One agent's run of consecutive sweeps that all measured the SAME drift. */
export interface ModelDriftStreak {
  /** The measured (wrong) model. */
  model: string
  /** Consecutive sweeps that measured it, including the latest one. */
  sweeps: number
}

/**
 * Fold this sweep's measurement into the agent's drift streak. Returns null
 * (streak cleared) when there is no drift to confirm.
 *
 * An UNMEASURABLE sweep (`measuredModel === null` -- session too young, tail
 * scan inconclusive) clears the streak rather than carrying it: "sustained"
 * has to mean consecutive POSITIVE observations, or a flapping measurement
 * could accumulate its way to a restart it never actually justified.
 */
export function advanceDriftStreak(
  prev: ModelDriftStreak | null,
  measuredModel: string | null,
  configuredModel: string,
): ModelDriftStreak | null {
  if (!measuredModel) return null
  if (normalizeModelId(measuredModel) === normalizeModelId(configuredModel)) return null
  const sameAsPrev = prev !== null && normalizeModelId(prev.model) === normalizeModelId(measuredModel)
  return { model: measuredModel, sweeps: sameAsPrev ? prev!.sweeps + 1 : 1 }
}

export interface ModelDriftFacts {
  /** This agent's current drift streak, or null when nothing is drifting. */
  streak: ModelDriftStreak | null
  /** Model of the agent's MOST RECENT turn, or null when unknown. */
  latestModel: string | null
  /** The agent's configured model -- the correction target. */
  configuredModel: string
  /** True when an INTENTIONAL fallback record is active for this agent. */
  hasActiveDowngrade: boolean
  /** True when the pane currently shows a usage-limit / access-failure signal. */
  limitSignal: boolean
  /** Consecutive drift sweeps required before correcting. */
  minSweeps: number
}

export type ModelDriftAction =
  | {
      kind: 'none'
      reason: 'no-drift' | 'already-recovered' | 'intentional-downgrade' | 'limit-signal' | 'not-sustained'
    }
  | { kind: 'correct'; model: string; measured: string }

/**
 * Decide whether an agent's measured/configured mismatch is an unintended
 * drift worth correcting. Pure; the runner owns the flap cap, the quiet-hours
 * and idle gates, and the restart.
 *
 * The three guards that keep this from fighting anything deliberate:
 *
 *   - latestModel already on the configured model: the drift is OVER (an
 *     operator answered the dialog or typed /model). The streak cannot notice
 *     that by itself -- it is built from the boot's first rows, which never
 *     change while the session lives -- so without this veto a hand-fixed
 *     agent would be restarted for a drift that no longer exists.
 *   - hasActiveDowngrade: while a downgrade record is live the agent is MEANT
 *     to be off its original model, and the write+restart+first-rows sequence
 *     transiently reads as a mismatch. Correcting there would undo a
 *     deliberate fallback -- and, under an account-scoped limit, re-trip it.
 *   - limitSignal: a limit or access banner is on the pane right now.
 *     Restarting onto the (higher) configured model under an active limit buys
 *     nothing; decideModelAction owns that situation.
 */
export function decideDriftAction(f: ModelDriftFacts): ModelDriftAction {
  if (!f.streak) return { kind: 'none', reason: 'no-drift' }
  if (f.latestModel && normalizeModelId(f.latestModel) === normalizeModelId(f.configuredModel)) {
    return { kind: 'none', reason: 'already-recovered' }
  }
  if (f.hasActiveDowngrade) return { kind: 'none', reason: 'intentional-downgrade' }
  if (f.limitSignal) return { kind: 'none', reason: 'limit-signal' }
  if (f.streak.sweeps < f.minSweeps) return { kind: 'none', reason: 'not-sustained' }
  return { kind: 'correct', model: f.configuredModel, measured: f.streak.model }
}

// --- MID-SESSION drift (scope decision on card b0c90a8a, 2026-07-31 16:2x) ---
//
// The boot detector above is structurally blind to a session that boots on the
// RIGHT model and slides off it later: its measurement is the boot's first
// rows, which never change while the session lives. That variant is real --
// measured 2026-07-31 10:37:27, neo's own main loop switched fable-5 ->
// opus-4-8 mid-session, no dialog, no /model, no config change, and stayed
// there for 5+ hours until a human noticed.
//
// The response here is ALERT ONLY, never a restart. That asymmetry is the
// audit's R2 condition (2026-07-31, ESCALATE item): a boot-window correction
// destroys an empty context, a mid-session correction destroys a working one,
// so past the boot window the automated system detects and reports while the
// fix stays a human decision (/model, or a restart they choose to take).
//
// The signal is latestModel -- the very value the boot path only trusts as a
// veto. Two things make it strong enough to ALERT on (though still not to
// restart on): the scan only reads interactive main-loop turns (sub-agent
// traffic lives in the subagents/ sidecar since Claude Code 2.1.220, and the
// entrypoint filter drops headless runs), and the streak demands more
// consecutive sightings than the boot path, so a single odd row cannot page
// anyone.

/** Consecutive sweeps of the same wrong latestModel before alerting. */
export const MIN_MIDSESSION_DRIFT_SWEEPS = 3

export interface MidSessionDriftFacts {
  /** Streak built from latestModel sightings (advanceDriftStreak), or null. */
  streak: ModelDriftStreak | null
  /** deriveMeasuredModel(bootModels) for the same boot, or null. */
  bootMeasured: string | null
  configuredModel: string
  hasActiveDowngrade: boolean
  limitSignal: boolean
  minSweeps: number
  /** True when this drift episode was already announced. */
  alreadyAlerted: boolean
}

export type MidSessionDriftAction =
  | {
      kind: 'none'
      reason:
        | 'no-drift'
        | 'boot-drift'
        | 'intentional-downgrade'
        | 'limit-signal'
        | 'not-sustained'
        | 'already-alerted'
    }
  | { kind: 'alert'; measured: string }

/**
 * Decide whether a sustained latestModel mismatch deserves an alert. Pure;
 * the runner owns the streak bookkeeping and the once-per-episode latch.
 *
 * The one guard beyond the boot path's set: when the BOOT rows themselves
 * measure wrong, the session has been off-model since start and the
 * correction path owns it -- alerting here too would page twice for one
 * event, and worse, keep paging after the correction path hit its flap cap
 * deliberately (that cap already announces itself once).
 */
export function decideMidSessionDriftAction(f: MidSessionDriftFacts): MidSessionDriftAction {
  if (!f.streak) return { kind: 'none', reason: 'no-drift' }
  if (f.bootMeasured && normalizeModelId(f.bootMeasured) !== normalizeModelId(f.configuredModel)) {
    return { kind: 'none', reason: 'boot-drift' }
  }
  if (f.hasActiveDowngrade) return { kind: 'none', reason: 'intentional-downgrade' }
  if (f.limitSignal) return { kind: 'none', reason: 'limit-signal' }
  if (f.streak.sweeps < f.minSweeps) return { kind: 'none', reason: 'not-sustained' }
  if (f.alreadyAlerted) return { kind: 'none', reason: 'already-alerted' }
  return { kind: 'alert', measured: f.streak.model }
}

// The fleet's nightly pause: 22:00-06:00 in the host's local timezone
// (Europe/Budapest on this install). A REVERT costs a session restart and is
// never urgent -- the agent is working fine on the fallback model -- so it is
// deferred to the next daytime sweep. A DOWNGRADE is NOT gated: that one
// unsticks an agent sitting deaf on a limited or unusable model, which is
// exactly the failure the night shift must not sleep through.
// Fleet quiet window: single source of truth is src/quiet-hours.ts (card
// 093ee62a, 2026-07-30 -- Gabor's "22:00-06:00, every schedule respects it").
// Re-exported here so the runner keeps importing isQuietHour from this module,
// but the 22/6 boundary is defined in exactly one place: change it there and
// every consumer (scheduler catch-up, this runner, the notification paths)
// follows, instead of three copies silently drifting apart.
export { isQuietHour } from './quiet-hours.js'
