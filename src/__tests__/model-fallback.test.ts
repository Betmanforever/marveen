import { describe, it, expect } from 'vitest'
import {
  detectsUsageLimit,
  extractLimitReset,
  detectsModelAccessFailure,
  detectsUnrecognizedApiError,
  sanitizeFailureSnippet,
  nextFallbackModel,
  decideModelAction,
  normalizeModelFallbackConfig,
  isQuietHour,
  DEFAULT_MODEL_CHAIN,
  DEFAULT_MODEL_FALLBACK,
} from '../model-fallback.js'

const CHAIN = [...DEFAULT_MODEL_CHAIN]
// Full fleet ladder: [fable, opus-5, opus-4-8[1m], sonnet-5, sonnet-4-6, haiku]
const FABLE = CHAIN[0]
const OPUS5 = CHAIN[1]
const OPUS48 = CHAIN[2]
const SONNET5 = CHAIN[3]
const SONNET46 = CHAIN[4]
const HAIKU = CHAIN[5]

describe('detectsUsageLimit', () => {
  it('matches Claude plan usage-limit banners in the live region', () => {
    expect(detectsUsageLimit('You have reached your usage limit. Try again later.')).toBe(true)
    expect(detectsUsageLimit('5-hour limit reached ∙ resets 3pm')).toBe(true)
    expect(detectsUsageLimit('Approaching usage limit')).toBe(true)
    expect(detectsUsageLimit('Your limit will reset at 18:00')).toBe(true)
    expect(detectsUsageLimit('/upgrade to increase your usage limit')).toBe(true)
  })

  it('matches the plan session-limit wordings (2026-07-05 incident)', () => {
    // Observed live pane line. The API-error anchor is concatenated so this
    // file rendered in an agent's pane cannot echo-trigger the access-failure
    // detectors (same self-trigger guard as the anchored fixtures below).
    const observed = 'ended early due to an API ' + "error: You've hit your session limit · resets 3:10am"
    expect(detectsUsageLimit(observed)).toBe(true)
    expect(detectsUsageLimit('You have hit the session limit.')).toBe(true)
    expect(detectsUsageLimit('Session limit reached · resets 3:10am')).toBe(true)
    expect(detectsUsageLimit('session limit ∙ resets 5pm')).toBe(true)
  })

  it('matches the observed session-limit line only inside the bottom banner region', () => {
    const observed = "You've hit your session limit · resets 3:10am"
    const atBottom = [...Array(40).fill('normal output line'), observed].join('\n')
    expect(detectsUsageLimit(atBottom)).toBe(true)
    // A quoted occurrence up in scrollback (outside the bottom region) must
    // NOT trip a downgrade.
    const inScrollback = [observed, ...Array(40).fill('normal output line')].join('\n')
    expect(detectsUsageLimit(inScrollback)).toBe(false)
  })

  it('does NOT match a transient API 429 / generic rate limit', () => {
    expect(detectsUsageLimit('  ⎿  API Error: 429 rate_limit_error: too many requests')).toBe(false)
    expect(detectsUsageLimit('  ⎿  API Error: 429 overloaded_error: server busy, retrying')).toBe(false)
    // "session" near a rate limit is still transient territory, not plan budget.
    expect(detectsUsageLimit('  ⎿  API Error: 429 rate_limit_error: this session sent too many requests')).toBe(false)
    // Bare "session limit" prose without the hit/reached/resets framing stays quiet.
    expect(detectsUsageLimit('we should document the session limit behaviour')).toBe(false)
  })

  it('ignores the phrase when it is only up in scrollback, not the live region', () => {
    const scrollback = ['you reached your usage limit', ...Array(40).fill('normal output line')].join('\n')
    expect(detectsUsageLimit(scrollback)).toBe(false)
  })

  it('returns false for empty / whitespace panes', () => {
    expect(detectsUsageLimit('')).toBe(false)
    expect(detectsUsageLimit('   \n  ')).toBe(false)
  })
})

describe('extractLimitReset', () => {
  it('extracts the reset time from the live banner', () => {
    expect(extractLimitReset("You've hit your session limit · resets 3:10am")).toBe('3:10am')
    expect(extractLimitReset('5-hour limit reached ∙ resets 3pm')).toBe('3pm')
    expect(extractLimitReset('Your limit will reset at 18:00')).toBe('18:00')
  })
  it('returns null when no reset time is present or it sits up in scrollback', () => {
    expect(extractLimitReset('usage limit reached')).toBeNull()
    expect(extractLimitReset('')).toBeNull()
    const scrollback = ['resets 3:10am', ...Array(40).fill('normal output line')].join('\n')
    expect(extractLimitReset(scrollback)).toBeNull()
  })
  it('never captures free text (the value lands in an operator alert)', () => {
    expect(extractLimitReset('resets when the ops team says so')).toBeNull()
    expect(extractLimitReset('resets 3')).toBeNull()
  })
})

describe('nextFallbackModel', () => {
  it('walks one step down the chain', () => {
    expect(nextFallbackModel(FABLE, CHAIN)).toBe(OPUS5)
    expect(nextFallbackModel(OPUS5, CHAIN)).toBe(OPUS48)
    expect(nextFallbackModel(OPUS48, CHAIN)).toBe(SONNET5)
    expect(nextFallbackModel(SONNET5, CHAIN)).toBe(SONNET46)
    expect(nextFallbackModel(SONNET46, CHAIN)).toBe(HAIKU)
  })
  it('returns null at the bottom', () => {
    expect(nextFallbackModel(HAIKU, CHAIN)).toBeNull()
  })
  it('an unknown current model lands on the fleet-default rung, not the pricey head', () => {
    expect(nextFallbackModel('some-unknown-model', CHAIN)).toBe(SONNET5)
    // operator chain without the default rung: falls back to chain[1]
    expect(nextFallbackModel('some-unknown-model', [OPUS48, SONNET46, HAIKU])).toBe(SONNET46)
  })
  it('returns null for a degenerate chain', () => {
    expect(nextFallbackModel(FABLE, [FABLE])).toBeNull()
    expect(nextFallbackModel(FABLE, [])).toBeNull()
  })

  it('carries the fleet primary (opus-5) between fable and opus-4.8', () => {
    // Without this rung a limited primary read as an UNKNOWN model and dropped
    // straight to the sonnet landing, skipping the whole opus tier.
    expect(CHAIN).toContain('claude-opus-5')
    expect(nextFallbackModel('claude-fable-5', CHAIN)).toBe('claude-opus-5')
    expect(nextFallbackModel('claude-opus-5', CHAIN)).toBe('claude-opus-4-8[1m]')
  })

  it('never steps onto a pricier rung than the one it left', () => {
    // $/MTok input, verified from the primary source 2026-07-31.
    const inputPrice: Record<string, number> = {
      'claude-fable-5': 10,
      'claude-opus-5': 5,
      'claude-opus-4-8[1m]': 5,
      'claude-sonnet-5': 3,
      'claude-sonnet-4-6': 3,
      'claude-haiku-4-5-20251001': 1,
    }
    for (const model of CHAIN) {
      const next = nextFallbackModel(model, CHAIN)
      if (!next) continue
      expect(inputPrice[next]).toBeLessThanOrEqual(inputPrice[model]!)
    }
  })
})

// Trigger fixtures are built by CONCATENATION so this source file, rendered in
// an agent's tmux pane (an agent editing or cat-ing it), never contains a
// literal anchor+cause line -- the runtime strings still match. Self-trigger
// guard for the fleet that develops its own watchdog (audit F3 companion).
const ERR = 'API ' + 'Error'
const NOTFOUND = 'not_' + 'found_error'
const PERM = 'permission' + '_error'
const INVALID = 'invalid_' + 'request_error'
const BILLING = 'billing' + '_error'

describe('detectsModelAccessFailure', () => {
  it('matches API-error lines with a model/credit cause on the SAME line', () => {
    expect(detectsModelAccessFailure(`  ⎿  ${ERR}: 404 ${NOTFOUND}: model claude-fable-5 not ` + 'found'))
      .toContain('not found')
    expect(detectsModelAccessFailure(`  ⎿  ${ERR}: 403 ${PERM}: your plan does not have access to this ` + 'model'))
      .toContain('does not have access')
    expect(detectsModelAccessFailure(`  ⎿  ${ERR}: 400 ${INVALID}: this model requires usage ` + 'credits'))
      .toContain('usage credits')
    expect(detectsModelAccessFailure(`  ⎿  ${ERR}: 400 ${BILLING}: credit balance is too ` + 'low'))
      .toContain('credit balance')
  })

  it('matches the standalone credit-balance TUI banner', () => {
    expect(detectsModelAccessFailure('Credit balance too ' + 'low · Add funds to continue')).not.toBeNull()
  })

  it('does NOT match conversation text without an API-error anchor (self-trigger guard)', () => {
    expect(detectsModelAccessFailure('a modell nem elerheto: model not available a July 7 valtas utan')).toBeNull()
    expect(detectsModelAccessFailure('we should handle the out of credits case in the watcher')).toBeNull()
  })

  it('does NOT match the temporary classes: usage limit / rate limit / overloaded', () => {
    expect(detectsModelAccessFailure('You have reached your usage limit. Try again later.')).toBeNull()
    expect(detectsModelAccessFailure(`  ⎿  ${ERR}: 429 rate_limit_error: too many requests`)).toBeNull()
    expect(detectsModelAccessFailure(`  ⎿  ${ERR}: 529 overloaded_error: server busy`)).toBeNull()
  })

  it('ignores matching lines up in scrollback outside the live region', () => {
    const scrollback = [
      `  ⎿  ${ERR}: 404 ${NOTFOUND}: model x not ` + 'found',
      ...Array(40).fill('normal output line'),
    ].join('\n')
    expect(detectsModelAccessFailure(scrollback)).toBeNull()
  })
})

describe('detectsUnrecognizedApiError', () => {
  it('surfaces an anchored line with no known cause (telemetry for new wordings)', () => {
    expect(detectsUnrecognizedApiError(`  ⎿  ${ERR}: 400 ${INVALID}: some brand new wording we have never seen`))
      .toContain('brand new wording')
  })
  it('stays silent on recognized causes, transients and usage-limit lines', () => {
    expect(detectsUnrecognizedApiError(`  ⎿  ${ERR}: 404 ${NOTFOUND}: model x not ` + 'found')).toBeNull()
    expect(detectsUnrecognizedApiError(`  ⎿  ${ERR}: 429 rate_limit_error: slow down`)).toBeNull()
    expect(detectsUnrecognizedApiError(`  ⎿  ${ERR}: 500 request timed out, retrying`)).toBeNull()
    expect(detectsUnrecognizedApiError('plain conversation line')).toBeNull()
    // 2026-07-05 incident line: pre-fix this surfaced as "unrecognized API
    // error wording"; the session-limit wording now belongs to USAGE_LIMIT_RX,
    // so the telemetry must stay quiet on it.
    expect(detectsUnrecognizedApiError(`ended early due to an ${ERR}: You've hit your session limit · resets 3:10am`)).toBeNull()
  })
})

describe('sanitizeFailureSnippet', () => {
  it('strips quotes, control chars and caps the length', () => {
    const nasty = 'x'.repeat(200) + '[31m"`\'\\ danger'
    const out = sanitizeFailureSnippet(nasty)
    expect(out.length).toBeLessThanOrEqual(120)
    expect(out).not.toMatch(/["'`\\]/)
  })
  it('keeps ordinary error text readable', () => {
    expect(sanitizeFailureSnippet(`${ERR}: 403 model access denied`)).toContain('403 model access denied')
  })
  it('defuses the usage/session-limit anchors so a quoted snippet cannot echo-trigger', () => {
    expect(sanitizeFailureSnippet('you hit your usage limit today')).toContain('usage-lim')
    const out = sanitizeFailureSnippet('hit your session limit · resets 3:10am')
    expect(out).toContain('session-lim')
    expect(out).not.toMatch(/session limit/i)
  })
})

describe('decideModelAction', () => {
  const base = { chain: CHAIN, now: 1_000_000, revertAfterMs: 60_000 }

  it('downgrades when a limit is detected and a lower model exists', () => {
    expect(decideModelAction({ ...base, limitDetected: true, currentModel: FABLE, downgradedAt: null }))
      .toEqual({ kind: 'downgrade', model: OPUS5, sticky: false, cause: 'usage-limit' })
    // downgradedAt is 500_000 ms back, far past the 60_000 ms window, so the
    // cascade guard has aged out and this is a fresh limit window.
    expect(decideModelAction({ ...base, limitDetected: true, currentModel: SONNET46, downgradedAt: 500_000 }))
      .toEqual({ kind: 'downgrade', model: HAIKU, sticky: false, cause: 'usage-limit' })
  })

  it('does nothing when limited at the bottom of the chain', () => {
    expect(decideModelAction({ ...base, limitDetected: true, currentModel: HAIKU, downgradedAt: 500_000 }))
      .toEqual({ kind: 'none' })
  })

  it('reverts to chain[0] after the window when no origin was recorded', () => {
    expect(decideModelAction({ ...base, limitDetected: false, currentModel: HAIKU, downgradedAt: 1_000_000 - 60_000 }))
      .toEqual({ kind: 'revert', model: FABLE })
  })

  it('does not revert before the window elapses', () => {
    expect(decideModelAction({ ...base, limitDetected: false, currentModel: SONNET5, downgradedAt: 1_000_000 - 59_999 }))
      .toEqual({ kind: 'none' })
  })

  it('does nothing when on the primary and limit-free', () => {
    expect(decideModelAction({ ...base, limitDetected: false, currentModel: FABLE, downgradedAt: null }))
      .toEqual({ kind: 'none' })
  })

  it('does not re-revert when already back on the primary', () => {
    expect(decideModelAction({ ...base, limitDetected: false, currentModel: FABLE, downgradedAt: 0 }))
      .toEqual({ kind: 'none' })
  })

  it('access failure produces a STICKY downgrade and wins over a limit banner', () => {
    expect(decideModelAction({
      ...base, limitDetected: true, accessFailure: 'API Error: 403 ... model',
      currentModel: FABLE, downgradedAt: null,
    })).toEqual({ kind: 'downgrade', model: OPUS5, sticky: true, cause: 'model-access' })
  })

  it('access failure on the fable rung walks to opus (fable is IN the chain now)', () => {
    expect(decideModelAction({
      ...base, limitDetected: false, accessFailure: 'API Error: 404 model not found',
      currentModel: 'claude-fable-5', downgradedAt: null,
    })).toEqual({ kind: 'downgrade', model: OPUS5, sticky: true, cause: 'model-access' })
  })

  it('a sticky downgrade never auto-reverts on a TIMER, no matter how old', () => {
    expect(decideModelAction({
      ...base, limitDetected: false, currentModel: SONNET5,
      downgradedAt: 0, downgradedFrom: FABLE, downgradeSticky: true,
    })).toEqual({ kind: 'none' })
  })

  it('a sticky downgrade DOES revert when a probe confirms the preferred model works again', () => {
    expect(decideModelAction({
      ...base, limitDetected: false, currentModel: SONNET5,
      downgradedAt: 999_999, downgradedFrom: FABLE, downgradeSticky: true,
      preferredUsable: true,
    })).toEqual({ kind: 'revert', model: FABLE })
  })

  it('a probe-confirmed sticky revert needs a recorded origin (no guess after restart)', () => {
    expect(decideModelAction({
      ...base, limitDetected: false, currentModel: SONNET5,
      downgradedAt: 0, downgradedFrom: null, downgradeSticky: true, preferredUsable: true,
    })).toEqual({ kind: 'none' })
  })

  it('a still-visible access failure blocks the probe-confirmed revert', () => {
    // failure signal wins: downgrade path is evaluated first
    expect(decideModelAction({
      ...base, limitDetected: false, accessFailure: 'API x model y',
      currentModel: SONNET5, downgradedAt: 0, downgradedFrom: FABLE,
      downgradeSticky: true, preferredUsable: true,
    })).toEqual({ kind: 'downgrade', model: SONNET46, sticky: true, cause: 'model-access' })
  })

  it('a non-sticky revert returns to the agent OWN pre-downgrade model, not chain[0]', () => {
    // mixed fleet: this agent's home rung is opus, chain[0] is fable
    expect(decideModelAction({
      ...base, limitDetected: false, currentModel: SONNET5,
      downgradedAt: 1_000_000 - 60_000, downgradedFrom: OPUS5, downgradeSticky: false,
    })).toEqual({ kind: 'revert', model: OPUS5 })
  })

  // --- Cascade guard (2026-07-05 incident, config_change_log 6-9) ---
  // The plan limit is ACCOUNT-scoped: every respawn onto a cheaper rung re-hit
  // the same limit, so the runner walked the whole ladder one step per cooldown
  // expiry. A limit signal is worth exactly ONE step per limit window.

  it('does NOT walk further down while a non-sticky limit downgrade is still fresh', () => {
    expect(decideModelAction({
      ...base, limitDetected: true, currentModel: OPUS5,
      downgradedAt: 1_000_000 - 59_999, downgradedFrom: FABLE, downgradeSticky: false,
    })).toEqual({ kind: 'none' })
  })

  it('holds the line at every rung of the chain, not just the first step', () => {
    // The 07-05 cascade was fable->opus->sonnet5->sonnet46->haiku; each of those
    // hops must be blocked while the window is open.
    for (const rung of [OPUS5, OPUS48, SONNET5, SONNET46]) {
      expect(decideModelAction({
        ...base, limitDetected: true, currentModel: rung,
        downgradedAt: 1_000_000 - 30_000, downgradedFrom: FABLE, downgradeSticky: false,
      })).toEqual({ kind: 'none' })
    }
  })

  it('steps again once the window has elapsed (a genuinely new limit window)', () => {
    expect(decideModelAction({
      ...base, limitDetected: true, currentModel: OPUS5,
      downgradedAt: 1_000_000 - 60_000, downgradedFrom: FABLE, downgradeSticky: false,
    })).toEqual({ kind: 'downgrade', model: OPUS48, sticky: false, cause: 'usage-limit' })
  })

  it('an ACCESS failure still walks the chain during an active downgrade window', () => {
    // Different error class: this model is unusable, the next one may not be.
    expect(decideModelAction({
      ...base, limitDetected: false, accessFailure: 'API x model y',
      currentModel: OPUS5, downgradedAt: 1_000_000 - 1_000,
      downgradedFrom: FABLE, downgradeSticky: false,
    })).toEqual({ kind: 'downgrade', model: OPUS48, sticky: true, cause: 'model-access' })
  })

  it('an access failure alongside a limit banner is not blocked by the guard', () => {
    expect(decideModelAction({
      ...base, limitDetected: true, accessFailure: 'API x model y',
      currentModel: OPUS5, downgradedAt: 1_000_000 - 1_000,
      downgradedFrom: FABLE, downgradeSticky: true,
    })).toEqual({ kind: 'downgrade', model: OPUS48, sticky: true, cause: 'model-access' })
  })

  it('the guard needs a record: a first limit with no history still steps down', () => {
    expect(decideModelAction({
      ...base, limitDetected: true, currentModel: OPUS5, downgradedAt: null,
    })).toEqual({ kind: 'downgrade', model: OPUS48, sticky: false, cause: 'usage-limit' })
  })
})

describe('isQuietHour', () => {
  it('covers the fleet night pause, 22:00 through 05:59', () => {
    expect(isQuietHour(22)).toBe(true)
    expect(isQuietHour(23)).toBe(true)
    expect(isQuietHour(0)).toBe(true)
    expect(isQuietHour(3)).toBe(true)
    expect(isQuietHour(5)).toBe(true)
  })

  it('is false right at the boundaries and through the working day', () => {
    expect(isQuietHour(6)).toBe(false)
    expect(isQuietHour(12)).toBe(false)
    expect(isQuietHour(21)).toBe(false)
  })

  it('classifies every hour of the day exactly once', () => {
    const quiet = [...Array(24).keys()].filter(isQuietHour)
    expect(quiet).toEqual([0, 1, 2, 3, 4, 5, 22, 23])
  })
})

describe('normalizeModelFallbackConfig', () => {
  it('defaults on junk input', () => {
    expect(normalizeModelFallbackConfig(null)).toEqual(DEFAULT_MODEL_FALLBACK)
    expect(normalizeModelFallbackConfig('nope')).toEqual(DEFAULT_MODEL_FALLBACK)
    expect(normalizeModelFallbackConfig({})).toEqual(DEFAULT_MODEL_FALLBACK)
  })

  it('honors a valid override', () => {
    const cfg = normalizeModelFallbackConfig({ enabled: true, chain: ['a', 'b', 'c'], revertAfterMinutes: 120 })
    expect(cfg).toEqual({ enabled: true, chain: ['a', 'b', 'c'], revertAfterMinutes: 120 })
  })

  it('rejects a too-short chain and non-string entries', () => {
    expect(normalizeModelFallbackConfig({ chain: ['only-one'] }).chain).toEqual(DEFAULT_MODEL_FALLBACK.chain)
    expect(normalizeModelFallbackConfig({ chain: ['a', 2, '', 'b'] }).chain).toEqual(['a', 'b'])
  })

  it('rejects a non-positive revert window', () => {
    expect(normalizeModelFallbackConfig({ revertAfterMinutes: 0 }).revertAfterMinutes).toBe(DEFAULT_MODEL_FALLBACK.revertAfterMinutes)
    expect(normalizeModelFallbackConfig({ revertAfterMinutes: -5 }).revertAfterMinutes).toBe(DEFAULT_MODEL_FALLBACK.revertAfterMinutes)
  })
})
