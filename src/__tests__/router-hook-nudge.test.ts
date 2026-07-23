// Tests for the hook-mode wake nudge in the message router (push->pull migration,
// Phase 1 component 3).
//
// An agent flipped to 'hook' delivery pulls its own inbox via a UserPromptSubmit
// drain-hook that only fires at the START of a turn. An IDLE hook agent takes no
// turns, so a pending message would starve until an organic turn. The router
// therefore WAKES it with a tiny, fixed, content-free nudge: the nudge starts a
// turn, and the drain-hook then claims the inbox. Invariants pinned here:
//   - a ready hook agent with pending messages gets EXACTLY one nudge, and the
//     nudge NEVER touches the agent_messages rows (the drain claims them);
//   - at most one nudge per agent per 60s window across ticks;
//   - the legacy push path and the main-agent branch are byte-for-byte unaffected;
//   - a busy/not-ready session gets no nudge and NO janitor action.
//
// Split into a pure-decision suite (shouldNudge) and an integration suite that
// drives runMessageRouterTick with the same STORE_DIR-sentinel / module-mock
// pattern as message-router-tick-cap.test.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetPendingMessages = vi.fn()
const mockMarkDelivered = vi.fn((..._a: unknown[]) => true)
const mockMarkFailed = vi.fn((..._a: unknown[]) => true)
// The tick expires stale claim leases first; default no-op ([]), overridden in
// the expiry-log test to return reset rows.
const mockExpireStaleClaims = vi.fn((..._a: unknown[]) => [] as unknown[])
const mockSessionExistsOnHost = vi.fn((..._a: unknown[]) => true)
const mockIsSessionReady = vi.fn((..._a: unknown[]) => true)
const mockColdStart = vi.fn((..._a: unknown[]) => false)
const mockClearStaleParked = vi.fn((..._a: unknown[]) => false)
const mockSendPrompt = vi.fn((..._a: unknown[]) => 'landed')
// Which agents resolve to 'hook' (pull) delivery. Read LAZILY by the
// delivery-config mock when getDeliveryMode is called mid-tick, so beforeEach can
// (re)populate it well before any tick runs. `mock` prefix so the vi.mock factory
// may reference it (vitest hoisting rule).
const mockHookAgents = new Set<string>()

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

// STORE_DIR sentinel: message-router imports delivery-config, which computes
// join(STORE_DIR, 'agent-delivery-config.json') at load. We mock delivery-config
// below so the path is never read, but config.js must still resolve MAIN_AGENT_ID
// and STORE_DIR for the module graph to load.
vi.mock('../config.js', () => ({
  MAIN_AGENT_ID: 'orin',
  STORE_DIR: '/tmp/marveen-router-hook-nudge-no-store',
}))

vi.mock('../db.js', () => ({
  getPendingMessages: () => mockGetPendingMessages(),
  markMessageDelivered: (...a: unknown[]) => mockMarkDelivered(...a),
  markMessageFailed: (...a: unknown[]) => mockMarkFailed(...a),
  expireStaleClaims: (...a: unknown[]) => mockExpireStaleClaims(...a),
}))

vi.mock('../web/voice-directive.js', () => ({
  resolveAgentChannelStateDir: () => '/tmp/none',
}))

vi.mock('../web/agent-config.js', () => ({
  readAgentRemoteHost: () => null,
  readAgentVoiceConfig: () => ({ responseMode: 'text' }),
}))

vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (name: string) => `agent-${name}`,
  channelColdStartHoldActive: (...a: unknown[]) => mockColdStart(...a),
  isSessionReadyForPrompt: (...a: unknown[]) => mockIsSessionReady(...a),
  clearStaleParkedInput: (...a: unknown[]) => mockClearStaleParked(...a),
  clearInputBuffer: vi.fn(),
  sendPromptToSession: (...a: unknown[]) => mockSendPrompt(...a),
  sessionExistsOnHost: (...a: unknown[]) => mockSessionExistsOnHost(...a),
}))

vi.mock('../web/voice-modality.js', () => ({
  setLastInboundModality: vi.fn(),
}))

vi.mock('../web/main-agent.js', () => ({
  MAIN_CHANNELS_SESSION: 'orin-channels',
}))

vi.mock('../web/agent-message-wrap.js', () => ({
  classifyAgentMessage: () => ({ category: 'trusted-peer', safeFrom: 'orin' }),
  wrapAgentMessageForDelivery: () => ({ prefix: 'PFX ', wrapped: 'WRAPPED' }),
}))

// Control delivery mode WITHOUT touching the fs: getDeliveryMode reads the Set,
// and isPullModeAgent replicates the REAL predicate (delivery-config.ts:94) so
// the router's gate wiring is exercised faithfully. The real file-resolution
// fail-safe is separately pinned by delivery-gate.test.ts.
vi.mock('../web/delivery-config.js', () => ({
  getDeliveryMode: (id: string) => (mockHookAgents.has(id) ? 'hook' : 'legacy'),
  isPullModeAgent: (id: string, mainId: string, modeOf: (id: string) => string) =>
    id === mainId || modeOf(id) === 'hook',
}))

import { logger } from '../logger.js'
import {
  runMessageRouterTick,
  shouldNudge,
  __resetHookNudgeStateForTest,
  HOOK_NUDGE_PROMPT,
  HOOK_NUDGE_RATE_MS,
} from '../web/message-router.js'

// ---- pure decision -----------------------------------------------------------

describe('shouldNudge (pure wake-nudge rate-limit decision)', () => {
  const RATE = 60_000

  it('nudges when no nudge has been sent yet (lastNudgeMs === null)', () => {
    expect(shouldNudge(null, 1_000_000, RATE)).toBe(true)
  })

  it('does NOT nudge inside the rate window', () => {
    expect(shouldNudge(1_000_000, 1_000_000, RATE)).toBe(false) // same instant
    expect(shouldNudge(1_000_000, 1_000_000 + RATE - 1, RATE)).toBe(false) // 1ms short
  })

  it('nudges again once the window has fully elapsed (>= boundary inclusive)', () => {
    expect(shouldNudge(1_000_000, 1_000_000 + RATE, RATE)).toBe(true) // exact boundary
    expect(shouldNudge(1_000_000, 1_000_000 + RATE + 1, RATE)).toBe(true)
  })

  it('treats a future-dated last nudge (clock skew) as nudge-now', () => {
    expect(shouldNudge(2_000_000, 1_000_000, RATE)).toBe(true)
  })
})

// ---- integration through runMessageRouterTick --------------------------------

// created_at is seconds (the DB unit); the hook path ignores age, but keep it
// fresh so nothing looks abandoned. `to` selects the routing branch: a member of
// mockHookAgents -> hook (nudge); 'orin' -> main branch; anything else -> legacy.
function pendingTo(to: string, count = 1, createdAtSec?: number) {
  const nowSec = createdAtSec ?? Math.floor(Date.now() / 1000)
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    from_agent: 'orin',
    to_agent: to,
    content: 'ping',
    created_at: nowSec,
  }))
}

describe('runMessageRouterTick: hook-mode wake nudge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __resetHookNudgeStateForTest()
    mockSessionExistsOnHost.mockReturnValue(true)
    mockIsSessionReady.mockReturnValue(true)
    mockColdStart.mockReturnValue(false)
    mockClearStaleParked.mockReturnValue(false)
    mockSendPrompt.mockReturnValue('landed')
    mockMarkDelivered.mockReturnValue(true)
    mockMarkFailed.mockReturnValue(true)
    mockExpireStaleClaims.mockReturnValue([]) // default: no stale lease to expire
    mockHookAgents.clear()
    mockHookAgents.add('dex')
  })

  it('a ready hook agent with a pending message gets EXACTLY one nudge, row untouched', async () => {
    mockGetPendingMessages.mockReturnValue(pendingTo('dex', 1))

    await runMessageRouterTick()

    expect(mockSendPrompt).toHaveBeenCalledTimes(1)
    expect(mockSendPrompt).toHaveBeenCalledWith('agent-dex', HOOK_NUDGE_PROMPT, null, { waitForIdle: false })
    // The nudge NEVER touches the agent_messages row -- the drain claims it.
    expect(mockMarkDelivered).not.toHaveBeenCalled()
    expect(mockMarkFailed).not.toHaveBeenCalled()
    // Greppable 'wake' log line (the plan's created->wake->claim breakpoint).
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      { agent: 'dex', pending: 1 },
      'Hook-mode wake nudge sent',
    )
  })

  it('multiple pending messages to the SAME hook agent still nudge only once per tick', async () => {
    mockGetPendingMessages.mockReturnValue(pendingTo('dex', 3))

    await runMessageRouterTick()

    // The first message stamps the rate limiter; the 2nd and 3rd see the fresh
    // stamp and skip -> one nudge, and the log reports the per-agent pending count.
    expect(mockSendPrompt).toHaveBeenCalledTimes(1)
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      { agent: 'dex', pending: 3 },
      'Hook-mode wake nudge sent',
    )
    expect(mockMarkDelivered).not.toHaveBeenCalled()
    expect(mockMarkFailed).not.toHaveBeenCalled()
  })

  it('rate-limits across ticks: one nudge, none within the window, then again after it', async () => {
    const nowSpy = vi.spyOn(Date, 'now')
    const T0 = 5_000_000
    try {
      mockGetPendingMessages.mockReturnValue(pendingTo('dex', 1, Math.floor(T0 / 1000)))

      nowSpy.mockReturnValue(T0)
      await runMessageRouterTick()
      expect(mockSendPrompt).toHaveBeenCalledTimes(1)

      // Next tick, still inside the 60s window -> no second nudge.
      nowSpy.mockReturnValue(T0 + HOOK_NUDGE_RATE_MS - 1000)
      await runMessageRouterTick()
      expect(mockSendPrompt).toHaveBeenCalledTimes(1)

      // Past the window with the message still pending -> nudge again.
      nowSpy.mockReturnValue(T0 + HOOK_NUDGE_RATE_MS + 1000)
      await runMessageRouterTick()
      expect(mockSendPrompt).toHaveBeenCalledTimes(2)
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('a gave-up nudge leaves the row untouched and retries next WINDOW, not next tick', async () => {
    const nowSpy = vi.spyOn(Date, 'now')
    const T0 = 7_000_000
    try {
      mockGetPendingMessages.mockReturnValue(pendingTo('dex', 1, Math.floor(T0 / 1000)))
      mockSendPrompt.mockReturnValue('gave-up')

      nowSpy.mockReturnValue(T0)
      await runMessageRouterTick()
      expect(mockSendPrompt).toHaveBeenCalledTimes(1)
      // gave-up must NOT touch the row (the drain still claims it) ...
      expect(mockMarkDelivered).not.toHaveBeenCalled()
      expect(mockMarkFailed).not.toHaveBeenCalled()

      // ... and must NOT un-stamp for an immediate next-tick retry: the stamp was
      // set before the send, so a tick 5s later (within the window) sends nothing.
      nowSpy.mockReturnValue(T0 + 5000)
      await runMessageRouterTick()
      expect(mockSendPrompt).toHaveBeenCalledTimes(1)
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('a busy/not-ready hook session gets NO nudge and NO janitor', async () => {
    mockGetPendingMessages.mockReturnValue(pendingTo('dex', 1))
    mockIsSessionReady.mockReturnValue(false)

    await runMessageRouterTick()

    expect(mockSendPrompt).not.toHaveBeenCalled() // never type into a busy pane
    expect(mockClearStaleParked).not.toHaveBeenCalled() // nudges run NO janitor
    expect(mockMarkDelivered).not.toHaveBeenCalled()
    expect(mockMarkFailed).not.toHaveBeenCalled()
  })

  it('a cold-starting hook session gets NO nudge', async () => {
    mockGetPendingMessages.mockReturnValue(pendingTo('dex', 1))
    mockColdStart.mockReturnValue(true)

    await runMessageRouterTick()

    expect(mockSendPrompt).not.toHaveBeenCalled()
    expect(mockMarkDelivered).not.toHaveBeenCalled()
    expect(mockMarkFailed).not.toHaveBeenCalled()
  })

  it('a legacy sub-agent takes the normal push path and is NOT nudged', async () => {
    mockGetPendingMessages.mockReturnValue(pendingTo('lex', 1)) // not in mockHookAgents -> legacy

    await runMessageRouterTick()

    // Pushed the WRAPPED content (prefix+wrapped), NOT the content-free nudge.
    expect(mockSendPrompt).toHaveBeenCalledTimes(1)
    expect(mockSendPrompt).toHaveBeenCalledWith('agent-lex', 'PFX WRAPPED', null)
    expect(mockSendPrompt).not.toHaveBeenCalledWith('agent-lex', HOOK_NUDGE_PROMPT, null, { waitForIdle: false })
    // The push path marks the row delivered (a 'landed' send); no nudge log.
    expect(mockMarkDelivered).toHaveBeenCalledTimes(1)
    expect(vi.mocked(logger.info)).not.toHaveBeenCalledWith(
      expect.anything(),
      'Hook-mode wake nudge sent',
    )
  })

  it('the main agent keeps its own branch: no push, no hook nudge, row untouched', async () => {
    // A young main-bound message: the coordinator self-poll has a 3-min min-age
    // gate, so nothing is sent, and the main branch never reaches the hook path
    // or the push path. This pins that the wake-nudge change left main untouched.
    mockGetPendingMessages.mockReturnValue(pendingTo('orin', 1))

    await runMessageRouterTick()

    expect(mockSendPrompt).not.toHaveBeenCalled()
    expect(mockMarkDelivered).not.toHaveBeenCalled()
    expect(mockMarkFailed).not.toHaveBeenCalled()
  })
})

// ---- stale claim-lease expiry (silent-loss fix, component 7) ------------------

describe('runMessageRouterTick: stale claim-lease expiry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __resetHookNudgeStateForTest()
    mockExpireStaleClaims.mockReturnValue([])
    mockGetPendingMessages.mockReturnValue([]) // isolate the expiry step
  })

  it('expires stale leases once per tick (in epoch SECONDS) and logs what it redelivered', async () => {
    const T0 = 5_000_000 // ms
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(T0)
    try {
      mockExpireStaleClaims.mockReturnValueOnce([
        { id: 7, to_agent: 'dex', redeliveries: 1 },
        { id: 8, to_agent: 'dex', redeliveries: 2 },
      ])

      await runMessageRouterTick()

      // Called exactly once, with the tick time as epoch SECONDS (not the ms clock).
      expect(mockExpireStaleClaims).toHaveBeenCalledTimes(1)
      expect(mockExpireStaleClaims).toHaveBeenCalledWith(Math.floor(T0 / 1000))
      // Structured, greppable redelivery log with ids, unique agents, and counts.
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        { ids: [7, 8], agents: ['dex'], redeliveries: [1, 2] },
        'message-router: expired stale inbox-drain claim leases, redelivering',
      )
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('logs nothing when there is no stale lease to expire', async () => {
    await runMessageRouterTick()
    expect(mockExpireStaleClaims).toHaveBeenCalledTimes(1)
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalledWith(
      expect.anything(),
      'message-router: expired stale inbox-drain claim leases, redelivering',
    )
  })
})
