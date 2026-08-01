// Contract tests for the context-budget escalation + pending-age watchdog added
// after the 2026-07-12 wedge (a sub-agent at 97% context stalled and silently
// dropped four inter-agent messages in both directions, escalation included).
//
// As with the sibling channel-monitor escalation tests, a real tmux interaction
// cannot be driven from a unit test, so the asserts read the source and lock in
// the structural invariants the change introduced. The pure decisions
// (decideContextBudgetEscalation, decidePendingAgeAlert, decideCoordinatorNudge)
// have behavioural tests in pane-state.test.ts / router-pending-watchdog.test.ts.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MONITOR_PATH = join(__dirname, '..', 'web', 'channel-monitor.ts')
const src = readFileSync(MONITOR_PATH, 'utf-8')

// The context-budget escalation pass, from its banner comment to the next pass.
function contextBudgetRegion(): string {
  const start = src.indexOf('// Context-budget escalation (main + sub-agents)')
  const end = src.indexOf('// Blocking-menu recovery', start)
  expect(start, 'context-budget region start not found').toBeGreaterThan(0)
  expect(end, 'context-budget region end not found').toBeGreaterThan(start)
  return src.slice(start, end)
}

// The in-process pending-age watchdog pass.
function pendingWatchdogRegion(): string {
  const start = src.indexOf('// In-process pending-age watchdog')
  const end = src.indexOf('// Desired-state reconciliation', start)
  expect(start, 'pending-watchdog region start not found').toBeGreaterThan(0)
  expect(end, 'pending-watchdog region end not found').toBeGreaterThan(start)
  return src.slice(start, end)
}

describe('channel-monitor: context-budget escalation (coordinator-first, recommend-restart only)', () => {
  it('declares its own escalation state-map, separate from the dialog/error ones', () => {
    expect(src).toMatch(/const paneContextBudgetEscalation: Map<string, ContextBudgetState> = new Map\(\)/)
    const region = contextBudgetRegion()
    // The pass must NOT reach into the dialog / thinking-block maps (that would
    // let the three call-sites cross-throttle each other).
    expect(region).toContain('paneContextBudgetEscalation')
    expect(region).not.toContain('paneDialogEscalation')
    expect(region).not.toContain('paneErrorEscalation')
  })

  it('reuses the pure decision with the confirm-tick guard + shared DIALOG_* grace/dedup', () => {
    const region = contextBudgetRegion()
    expect(region).toContain('decideContextBudgetEscalation(signal, prevEsc, now, {')
    expect(region).toContain('confirmTicks: CONTEXT_BUDGET_CONFIRM_TICKS')
    expect(region).toContain('graceMs: DIALOG_WOLFE_GRACE_MS')
    expect(region).toContain('dedupMs: DIALOG_ESCALATE_DEDUP_MS')
    expect(region).toContain("esc.action === 'notify-wolfe'")
    expect(region).toContain("esc.action === 'fallback-gabor'")
  })

  it('triggers on context-LOW OR full saturation', () => {
    const region = contextBudgetRegion()
    expect(region).toContain('paneShowsContextLow(pane)')
    expect(region).toContain('paneShowsContextSaturation(pane)')
    expect(region).toMatch(/const signal = low \|\| saturated/)
  })

  it('phase 1 flags the coordinator FROM the ceiling-hit sub-agent, scoped to sub-agents', () => {
    const region = contextBudgetRegion()
    // from = t.agentName, to = MAIN_AGENT_ID (decision-flag.py convention).
    expect(region).toContain('createAgentMessage(t.agentName, MAIN_AGENT_ID, buildContextBudgetCoordinatorFlag(t.agentName))')
    expect(region).toContain('if (!t.isMarveen && t.agentName) {')
    // A router enqueue failure must not silently drop the finding -- but it is
    // internal ops state, so it lands in the digest, never an owner ping
    // (card 919b96a8 doctrine).
    expect(region).toContain('recordInternalOpsFinding(CONTEXT_BUDGET_SOURCE, buildContextBudgetOwnerFallback(label))')
    expect(region).not.toContain('sendAlert(buildContextBudgetOwnerFallback')
  })

  it('the main channels session gets a deduped digest finding on context-LOW only, never a self-flag', () => {
    const region = contextBudgetRegion()
    // Isolate the main branch by its unique banner comment (the sub-agent branch
    // has its own `} else {` for the !signal reset, so a bare indexOf would
    // mis-slice).
    const mainStart = region.indexOf('// Main channels session: full saturation')
    expect(mainStart, 'main branch banner not found').toBeGreaterThan(0)
    const mainBranch = region.slice(mainStart)
    // Main branch keys off `low` (saturation is handled by the readiness gate).
    expect(mainBranch).toContain('if (low) {')
    expect(mainBranch).toContain('mainContextLowAlertAt')
    // Main must NOT createAgentMessage to itself (it is the coordinator).
    expect(mainBranch).not.toContain('createAgentMessage')
  })

  it('NEVER auto-restarts -- it only recommends a restart', () => {
    const region = contextBudgetRegion()
    expect(region).not.toContain('stopAgentProcess')
    expect(region).not.toContain('startAgentProcess')
    expect(region).not.toContain('respawn-pane')
  })

  it('clears the escalation state when the ceiling signal clears', () => {
    const region = contextBudgetRegion()
    expect(region).toMatch(/if \(!signal\) \{[\s\S]*?paneContextBudgetEscalation\.delete\(t\.session\)/)
  })
})

describe('channel-monitor: context-budget message builders (restart recommendation, no terminal leak)', () => {
  it('the coordinator flag uses [AUTOMATIKUS DECISION-FLAG] + the restart API, no tmux/marker leak', () => {
    const s = src.indexOf('function buildContextBudgetCoordinatorFlag')
    expect(s, 'buildContextBudgetCoordinatorFlag not found').toBeGreaterThan(0)
    const flag = src.slice(s, src.indexOf('\n}\n', s))
    expect(flag).toContain('[AUTOMATIKUS DECISION-FLAG]')
    // Names the context-ceiling cause + the restart recommendation (API path).
    expect(flag).toContain('kontextus')
    expect(flag).toContain('POST /api/agents/')
    expect(flag).toContain('/restart')
    // Recommendation only: the watchdog does not auto-reset.
    expect(flag).toMatch(/nem inditott auto-resetet|SZANDEKOSAN nem/)
    // Never direct anyone to a terminal / leak a raw session-id, and no literal
    // [DONTESRE-VAR:...] marker (the Stop hook false-detects it).
    expect(flag).not.toContain('tmux attach')
    expect(flag).not.toContain('t.session')
    expect(flag).not.toContain('[DONTESRE-VAR:')
  })

  it('the owner fallback is human-friendly (no curl/api-path, no tmux, no raw session-id)', () => {
    const s = src.indexOf('function buildContextBudgetOwnerFallback')
    expect(s, 'buildContextBudgetOwnerFallback not found').toBeGreaterThan(0)
    const fallback = src.slice(s, src.indexOf('\n}\n', s))
    expect(fallback).not.toContain('tmux attach')
    expect(fallback).not.toContain('t.session')
    expect(fallback).not.toContain('/api/agents/')
    expect(fallback).not.toContain('POST')
  })
})

describe('channel-monitor: in-process pending-age watchdog (I/O wiring only)', () => {
  // The 2026-07-31 audit (AC-11) requires the whole decision path to be
  // replayable with injected senders, so it now lives in pending-age-watchdog.ts
  // (behavioural tests: pending-age-watchdog.test.ts). What must stay true HERE
  // is the wiring: the queue is read directly, and both transports are supplied.
  it('reads the queue directly and injects every transport into the watchdog', () => {
    const region = pendingWatchdogRegion()
    expect(region).toContain('getPendingMessages()')
    expect(region).toContain('runPendingAgeWatchdog(')
    // Coordinator leg (routine findings), the independent owner leg -- FATAL
    // class since 3f6c8457, because suppressing THIS one is the silence risk --
    // and, since card 919b96a8, the self-heal leg for the catch-22 shape where
    // the stalled target IS the coordinator and no flag can reach it.
    expect(region).toContain('createAgentMessage')
    expect(region).toContain('sendAlert(text, { fatal: true })')
    expect(region).toContain('selfHealCoordinator:')
    // Claim table wiring (AC-4): the shared "someone already owns this" ledger.
    expect(region).toContain('claimAlertItem(')
    expect(region).toContain('getLiveAlertClaim(')
  })

  it('probes the target pane per sweep (P3 needs one sample per tick) and is fail-safe', () => {
    const region = pendingWatchdogRegion()
    expect(region).toContain('capturePane(session)')
    expect(region).toContain('paneProcessAgeMs(session)')
    // Defensive: a DB hiccup must not break the rest of the monitor tick.
    expect(region).toMatch(/try \{[\s\S]*?\} catch \(err\) \{/)
  })

  it('the owner leg does NOT depend on an inter-agent message being delivered', () => {
    // The queue this watchdog reports on is the queue the coordinator message
    // travels through. If it is genuinely wedged the flag rots in it, the grace
    // expires unanswered and sendAlert (an independent transport) still fires.
    const wd = readFileSync(join(__dirname, '..', 'web', 'pending-age-watchdog.ts'), 'utf-8')
    expect(wd).toContain('only on one having been SENT')
    expect(wd).not.toContain('markMessageDelivered')
  })
})
