// Contract tests for the thinking-block wedge escalation (coordinator-first).
//
// Background: when a session's history is corrupt every prompt returns the same
// `400 ... thinking blocks cannot be modified` and detectPaneState reads the
// pane as 'error'. The watchdog deliberately never auto-resets (a false
// positive must not nuke a healthy agent), so it must escalate. The OLD
// behaviour blasted a raw `tmux attach -t <session>` alert straight to Gabor
// about a sub-agent -- the same fleet-rule violation ("never send Gabor to a
// sub-agent terminal") fixed earlier for the permission-dialog path. This
// applies the identical two-phase mr-wolfe-first escalation (reusing the pure
// decideDialogEscalation) to the thinking-block call-site.
//
// As with the sibling channel-monitor tests, a real tmux interaction cannot be
// driven from a unit test, so the asserts read the source and lock in the
// structural invariants the change introduced. The pure two-phase decision
// (decideDialogEscalation) has behavioural tests in pane-state.test.ts.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MONITOR_PATH = join(__dirname, '..', 'web', 'channel-monitor.ts')
const src = readFileSync(MONITOR_PATH, 'utf-8')

// The thinking-block error pass, from its banner comment to the next pass.
function thinkingBlockRegion(): string {
  const start = src.indexOf('// Pane-level thinking-block error detection')
  const end = src.indexOf('// Blocking-menu recovery', start)
  expect(start, 'thinking-block region start not found').toBeGreaterThan(0)
  expect(end, 'thinking-block region end not found').toBeGreaterThan(start)
  return src.slice(start, end)
}

describe('channel-monitor: thinking-block wedge escalates to the coordinator first', () => {
  it('declares its own escalation state-map, separate from the permission-dialog one', () => {
    expect(src).toMatch(/const paneErrorEscalation: Map<string, DialogEscalationState> = new Map\(\)/)
    const region = thinkingBlockRegion()
    // The pass uses paneErrorEscalation and must NOT reach into
    // paneDialogEscalation (that would let the two call-sites cross-throttle).
    expect(region).toContain('paneErrorEscalation')
    expect(region).not.toContain('paneDialogEscalation')
  })

  it('reuses the pure two-phase decision instead of a bespoke re-implementation', () => {
    const region = thinkingBlockRegion()
    expect(region).toContain('decideDialogEscalation(prevEsc, now, {')
    expect(region).toContain('graceMs: DIALOG_WOLFE_GRACE_MS')
    expect(region).toContain('dedupMs: DIALOG_ESCALATE_DEDUP_MS')
    expect(region).toContain("esc.action === 'notify-wolfe'")
    expect(region).toContain("esc.action === 'fallback-gabor'")
  })

  it('drives escalation off the confirmed error SPELL, not decision.alert (dedup-conflict fix)', () => {
    const region = thinkingBlockRegion()
    // The per-tick spell-activity signal gates the escalation...
    expect(region).toMatch(/const spellConfirmed = isError/)
    expect(region).toContain('now - decision.next.firstSeenAt >= PANE_ERROR_CONFIRM_MS')
    expect(region).toContain('if (spellConfirmed) {')
    // ...and the old decision.alert-gated alert branch is gone (it fired only
    // once per 30-min dedup, which would starve the 6-min owner grace).
    expect(region).not.toMatch(/if \(decision\.alert\) \{/)
  })

  it('phase 1 flags the coordinator FROM the wedged sub-agent, scoped to sub-agents', () => {
    const region = thinkingBlockRegion()
    // from = t.agentName, to = MAIN_AGENT_ID (decision-flag.py convention).
    expect(region).toContain('createAgentMessage(t.agentName, MAIN_AGENT_ID, buildThinkingBlockCoordinatorFlag(label))')
    // Escalation is sub-agent-scoped (the main session runs skip-permissions
    // and is itself the coordinator).
    expect(region).toContain('if (!t.isMarveen && t.agentName) {')
    // A router enqueue failure must not silently drop the escalation.
    expect(region).toContain('sendAlert(buildThinkingBlockOwnerFallback(label))')
  })

  it('clears the escalation state when the error spell clears', () => {
    const region = thinkingBlockRegion()
    // The paneErrorState clear branch (firstSeenAt === null) also drops the
    // escalation state so a future wedge starts as a fresh spell.
    expect(region).toMatch(/paneErrorState\.delete\(t\.session\)\s*\n[\s\S]*?paneErrorEscalation\.delete\(t\.session\)/)
  })

  it('the raw "tmux attach" owner blast is gone from the thinking-block pass', () => {
    const region = thinkingBlockRegion()
    expect(region).not.toContain('tmux attach')
    // The specific old technical message to Gabor (session-id leak) is gone.
    expect(region).not.toContain('Reszletek: tmux attach')
  })
})

describe('channel-monitor: thinking-block message builders (no terminal/session leak)', () => {
  it('the coordinator flag uses [AUTOMATIKUS DECISION-FLAG] + manual-reset semantics, no tmux/marker leak', () => {
    const s = src.indexOf('function buildThinkingBlockCoordinatorFlag')
    expect(s, 'buildThinkingBlockCoordinatorFlag not found').toBeGreaterThan(0)
    const flag = src.slice(s, src.indexOf('\n}\n', s))
    // Mirrors scripts/hooks/decision-flag.py so mr-wolfe's triage skill
    // recognises it identically.
    expect(flag).toContain('[AUTOMATIKUS DECISION-FLAG]')
    // Names the corrupt-session / manual-reset resolution.
    expect(flag).toContain('thinking-block')
    expect(flag).toMatch(/KEZI RESET|allitsd le es inditsd ujra/)
    // Must never direct anyone to a terminal or leak a raw session-id, and
    // must not carry a literal [DONTESRE-VAR:...] marker (the Stop hook
    // false-detects it).
    expect(flag).not.toContain('tmux attach')
    expect(flag).not.toContain('t.session')
    expect(flag).not.toContain('[DONTESRE-VAR:')
  })

  it('the owner fallback is human-friendly (no tmux attach, no raw session-id, no 400 jargon)', () => {
    const s = src.indexOf('function buildThinkingBlockOwnerFallback')
    expect(s, 'buildThinkingBlockOwnerFallback not found').toBeGreaterThan(0)
    const fallback = src.slice(s, src.indexOf('\n}\n', s))
    expect(fallback).not.toContain('tmux attach')
    expect(fallback).not.toContain('t.session')
    expect(fallback).not.toContain('400')
  })
})
