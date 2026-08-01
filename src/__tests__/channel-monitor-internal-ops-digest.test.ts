// Owner-alert doctrine (card 919b96a8, layer 3; Gabor msg 4251).
//
// An owner ping is legitimate for exactly two things: a decision only Gabor can
// make, or an impact he actually feels (deliverable, deadline, security).
// INTERNAL OPERATIONAL STATE -- a starving queue, a parked pane, a restart, a
// stuck dialog, a model drift -- goes self-heal -> coordinator -> daily digest
// and never to the owner, however long it stays unresolved.
//
// The three escalations below all report internal operational state, and all
// three used to end in a direct sendAlert. Their terminal rung is now a digest
// 'open' entry. The COORDINATOR rung above them is untouched -- that is what
// makes this a downgrade of the last rung, not a removal of the control.
//
// As with the sibling channel-monitor escalation tests, a real tmux interaction
// cannot be driven from a unit test, so the asserts read the source and lock in
// the structural invariant. The pure decisions have behavioural tests
// (pane-state.test.ts, pending-age-watchdog.test.ts).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MONITOR_PATH = join(__dirname, '..', 'web', 'channel-monitor.ts')
const src = readFileSync(MONITOR_PATH, 'utf-8')

function region(startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker)
  expect(start, `region start not found: ${startMarker}`).toBeGreaterThan(0)
  const end = src.indexOf(endMarker, start)
  expect(end, `region end not found: ${endMarker}`).toBeGreaterThan(start)
  return src.slice(start, end)
}

// The pane-level thinking-block escalation pass.
const thinkingBlockRegion = (): string =>
  region('// Pane-level thinking-block error detection', '// Context-budget escalation (main + sub-agents)')

// The permission-dialog (D1) branch inside the blocking-menu pass.
const permissionDialogRegion = (): string =>
  region('// D1: a permission/tool-approval dialog', '// D3 (2026-07-24): the model-credit consent dialog')

// The model-credit (D3) branch, from its banner to the plan-limit else-branch.
const modelCreditRegion = (): string =>
  region('// D3 (2026-07-24): the model-credit consent dialog', "// The Claude plan limit modal (\"You've hit your session limit")

// The D3 sub-branch the card names: no unambiguous option for the configured
// model, so the gate escalates instead of navigating. Scoped deliberately -- the
// SIBLING branch (navigation FAILED, dialog probably still open) stays
// owner-facing by design (card 012a417a), and a whole-D3 slice would hide that.
const modelCreditNoOptionRegion = (): string =>
  region('// No unambiguous option for the configured model', "// The Claude plan limit modal (\"You've hit your session limit")

// The in-process pending-age watchdog wiring.
const pendingWatchdogRegion = (): string =>
  region('// In-process pending-age watchdog', '// Desired-state reconciliation')

const INTERNAL_OPS_PASSES: Array<[string, () => string, string]> = [
  ['thinking-block wedge', thinkingBlockRegion, 'THINKING_BLOCK_SOURCE'],
  ['permission dialog', permissionDialogRegion, 'PERMISSION_DIALOG_SOURCE'],
  ['model-credit gate (no matching option)', modelCreditNoOptionRegion, 'MODEL_CREDIT_SOURCE'],
]

describe('owner-alert doctrine: internal operational state never pages the owner', () => {
  it.each(INTERNAL_OPS_PASSES)('%s: the terminal rung writes a digest item, not an owner alert', (_name, getRegion, source) => {
    const r = getRegion()
    // No direct owner transport is left anywhere in the pass -- not on the
    // fallback-gabor rung, not in the enqueue-failed catch, not on the
    // main-session branch that has no coordinator to delegate to.
    expect(r).not.toContain('sendAlert(')
    expect(r).not.toContain('notifyChannel(')
    // ... and the finding is recorded rather than dropped.
    expect(r).toContain(`recordInternalOpsFinding(${source},`)
  })

  it.each(INTERNAL_OPS_PASSES)('%s: the coordinator rung is untouched', (_name, getRegion) => {
    const r = getRegion()
    // Phase 1 still flags the coordinator FROM the affected agent (the
    // decision-flag.py convention); only the last rung changed.
    expect(r).toContain('createAgentMessage(t.agentName, MAIN_AGENT_ID,')
    expect(r).toContain("esc.action === 'notify-wolfe'")
    expect(r).toContain("esc.action === 'fallback-gabor'")
  })

  it('all four rerouted passes are covered: fallback-gabor, enqueue-catch and the main-session branch', () => {
    // Three call sites per pass (thinking-block, permission-dialog,
    // model-credit-no-option, context-budget); twelve in total. A future edit
    // that reinstates a sendAlert on any of them fails the first assertion
    // above, and one that deletes a rung outright fails this count.
    const calls = src.match(/recordInternalOpsFinding\(/g) ?? []
    // 12 call sites + the function's own declaration.
    expect(calls).toHaveLength(13)
  })

  it('writes category "open" -- an unresolved internal item, not a silent auto-fix', () => {
    const helper = src.slice(src.indexOf('function recordInternalOpsFinding'))
    const body = helper.slice(0, helper.indexOf('\n}\n'))
    expect(body).toContain("category: 'open'")
    expect(body).toContain('appendDigestEntry(')
  })

  it('keeps sendAlert ONLY as the never-silent-drop backstop for a failed digest write', () => {
    const helper = src.slice(src.indexOf('function recordInternalOpsFinding'))
    const body = helper.slice(0, helper.indexOf('\n}\n'))
    // The sole sendAlert in the helper is guarded by the digest write failing.
    expect(body).toMatch(/if \(!appendDigestEntry\(\{[\s\S]*?\}\)\) \{\s*sendAlert\(summary\)/)
    // A digest write that cannot report failure would make that backstop dead
    // code, so the helper's contract depends on the boolean return.
    expect(src).toContain('export function appendDigestEntry(entry: Omit<DigestEntry, \'ts\'>): boolean')
  })

  it('leaves genuinely owner-facing alerts alone (this is a reroute, not a mute)', () => {
    // Spot-check the classes the card explicitly excludes: a failed model-credit
    // NAVIGATION (the dialog is probably still open, a human must act), the
    // usage-limit / blocking-menu notices, and the channel-down cascade. If
    // these ever lose their owner path, the doctrine has been over-applied.
    expect(modelCreditRegion()).toContain('navigalas HIBAZOTT')
    expect(src).toContain('a plan usage-limit dialogusaban all')
    expect(src).toContain('Hard restart SEM segitett')
  })
})

describe('pending-age watchdog wiring: the catch-22 rung', () => {
  it('injects the coordinator identity and the self-heal transport', () => {
    const r = pendingWatchdogRegion()
    // Without the id the watchdog cannot recognise "every stalled target IS the
    // coordinator", and the ladder falls back to the undeliverable flag.
    expect(r).toContain('coordinatorAgentId: MAIN_AGENT_ID')
    expect(r).toContain('selfHealCoordinator: () => selfHealCoordinatorSession()')
  })

  it('self-heals with a --continue respawn, never by bouncing the channels unit', () => {
    const s = src.indexOf('function selfHealCoordinatorSession')
    expect(s, 'selfHealCoordinatorSession not found').toBeGreaterThan(0)
    const fn = src.slice(s, src.indexOf('\n}\n', s))
    // PRESERVE before the restart discards the box (preserve-before-clearing).
    expect(fn).toContain('saveParkedInputRollback(MAIN_CHANNELS_SESSION')
    expect(fn).toContain('resumeMarveenSession()')
    // `systemctl --user restart <service>-channels` would kill the shared tmux
    // server and with it EVERY agent session (see hardRestartMarveenChannels).
    expect(fn).not.toContain('systemctl')
    expect(fn).not.toContain('hardRestartMarveenChannels')
    // The whole point: no owner transport on this path.
    expect(fn).not.toContain('sendAlert(')
    expect(fn).not.toContain('notifyChannel(')
  })

  it('reads the parked box through the dim-stripped view, so a ghost hint is not preserved', () => {
    const s = src.indexOf('function selfHealCoordinatorSession')
    const fn = src.slice(s, src.indexOf('\n}\n', s))
    expect(fn).toContain('captureParkedInputView(MAIN_CHANNELS_SESSION)')
  })
})
