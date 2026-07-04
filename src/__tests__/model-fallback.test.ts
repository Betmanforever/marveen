import { describe, it, expect } from 'vitest'
import {
  detectsUsageLimit,
  detectsModelAccessFailure,
  detectsUnrecognizedApiError,
  sanitizeFailureSnippet,
  nextFallbackModel,
  decideModelAction,
  normalizeModelFallbackConfig,
  DEFAULT_MODEL_CHAIN,
  DEFAULT_MODEL_FALLBACK,
} from '../model-fallback.js'

const CHAIN = [...DEFAULT_MODEL_CHAIN]
const PRIMARY = CHAIN[0]
const SONNET = CHAIN[1]
const HAIKU = CHAIN[2]

describe('detectsUsageLimit', () => {
  it('matches Claude plan usage-limit banners in the live region', () => {
    expect(detectsUsageLimit('You have reached your usage limit. Try again later.')).toBe(true)
    expect(detectsUsageLimit('5-hour limit reached ∙ resets 3pm')).toBe(true)
    expect(detectsUsageLimit('Approaching usage limit')).toBe(true)
    expect(detectsUsageLimit('Your limit will reset at 18:00')).toBe(true)
    expect(detectsUsageLimit('/upgrade to increase your usage limit')).toBe(true)
  })

  it('does NOT match a transient API 429 / generic rate limit', () => {
    expect(detectsUsageLimit('  ⎿  API Error: 429 rate_limit_error: too many requests')).toBe(false)
    expect(detectsUsageLimit('  ⎿  API Error: 429 overloaded_error: server busy, retrying')).toBe(false)
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

describe('nextFallbackModel', () => {
  it('walks one step down the chain', () => {
    expect(nextFallbackModel(PRIMARY, CHAIN)).toBe(SONNET)
    expect(nextFallbackModel(SONNET, CHAIN)).toBe(HAIKU)
  })
  it('returns null at the bottom', () => {
    expect(nextFallbackModel(HAIKU, CHAIN)).toBeNull()
  })
  it('treats an unknown current model as the primary', () => {
    expect(nextFallbackModel('some-unknown-model', CHAIN)).toBe(SONNET)
  })
  it('returns null for a degenerate chain', () => {
    expect(nextFallbackModel(PRIMARY, [PRIMARY])).toBeNull()
    expect(nextFallbackModel(PRIMARY, [])).toBeNull()
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
})

describe('decideModelAction', () => {
  const base = { chain: CHAIN, now: 1_000_000, revertAfterMs: 60_000 }

  it('downgrades when a limit is detected and a lower model exists', () => {
    expect(decideModelAction({ ...base, limitDetected: true, currentModel: PRIMARY, downgradedAt: null }))
      .toEqual({ kind: 'downgrade', model: SONNET, sticky: false, cause: 'usage-limit' })
    expect(decideModelAction({ ...base, limitDetected: true, currentModel: SONNET, downgradedAt: 500_000 }))
      .toEqual({ kind: 'downgrade', model: HAIKU, sticky: false, cause: 'usage-limit' })
  })

  it('does nothing when limited at the bottom of the chain', () => {
    expect(decideModelAction({ ...base, limitDetected: true, currentModel: HAIKU, downgradedAt: 500_000 }))
      .toEqual({ kind: 'none' })
  })

  it('reverts to the primary after the window once limit-free', () => {
    expect(decideModelAction({ ...base, limitDetected: false, currentModel: HAIKU, downgradedAt: 1_000_000 - 60_000 }))
      .toEqual({ kind: 'revert', model: PRIMARY })
  })

  it('does not revert before the window elapses', () => {
    expect(decideModelAction({ ...base, limitDetected: false, currentModel: SONNET, downgradedAt: 1_000_000 - 59_999 }))
      .toEqual({ kind: 'none' })
  })

  it('does nothing when on the primary and limit-free', () => {
    expect(decideModelAction({ ...base, limitDetected: false, currentModel: PRIMARY, downgradedAt: null }))
      .toEqual({ kind: 'none' })
  })

  it('does not re-revert when already back on the primary', () => {
    expect(decideModelAction({ ...base, limitDetected: false, currentModel: PRIMARY, downgradedAt: 0 }))
      .toEqual({ kind: 'none' })
  })

  it('access failure produces a STICKY downgrade and wins over a limit banner', () => {
    expect(decideModelAction({
      ...base, limitDetected: true, accessFailure: 'API Error: 403 ... model',
      currentModel: PRIMARY, downgradedAt: null,
    })).toEqual({ kind: 'downgrade', model: SONNET, sticky: true, cause: 'model-access' })
  })

  it('access failure on an off-chain primary (e.g. fable) downgrades to chain[1]', () => {
    expect(decideModelAction({
      ...base, limitDetected: false, accessFailure: 'API Error: 404 model not found',
      currentModel: 'claude-fable-5', downgradedAt: null,
    })).toEqual({ kind: 'downgrade', model: SONNET, sticky: true, cause: 'model-access' })
  })

  it('a sticky downgrade never auto-reverts, no matter how old', () => {
    expect(decideModelAction({
      ...base, limitDetected: false, currentModel: SONNET,
      downgradedAt: 0, downgradedFrom: 'claude-fable-5', downgradeSticky: true,
    })).toEqual({ kind: 'none' })
  })

  it('a non-sticky revert returns to the agent OWN pre-downgrade model, not chain[0]', () => {
    // mixed fleet: this agent ran claude-fable-5, chain[0] is the opus default
    expect(decideModelAction({
      ...base, limitDetected: false, currentModel: SONNET,
      downgradedAt: 1_000_000 - 60_000, downgradedFrom: 'claude-fable-5', downgradeSticky: false,
    })).toEqual({ kind: 'revert', model: 'claude-fable-5' })
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
