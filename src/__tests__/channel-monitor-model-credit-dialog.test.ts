// Contract tests for the model-credit dialog branch (2026-07-24 incident).
//
// Background: when an agent's configured model exhausts its included quota,
// Claude Code parks the session in a consent modal ("You've reached your
// Fable 5 limit ... 1. Continue with Fable 5 / 2. Switch to Sonnet 5 and
// continue"). It wears the same navigable-modal footer as a /mcp menu, and is
// NOT a permission dialog, so the blocking-menu pass answered it with the
// generic recovery Escape. In the CLI that Escape resolves as `cancelled`, and
// every non-consent answer makes the query loop swap the session onto the
// fallback model and continue -- silently. Observed live 2026-07-24
// ~21:09-21:24: neo (configured claude-fable-5) ran ~15 minutes on Sonnet 5
// with nothing in the pane, the dashboard or agent-config.json showing it.
//
// The fix gives the dialog its OWN branch: navigate explicitly to the option
// matching the configured model, or -- when no option unambiguously matches --
// escalate two-phase like the permission dialog. Never Escape.
//
// As with the sibling channel-monitor tests, a real tmux interaction cannot be
// driven from a unit test, so the asserts read the source and lock in the
// structural invariants. The pure pieces (detectsModelCreditDialog,
// findModelCreditDialogOption) have behavioral tests in pane-state.test.ts.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MONITOR_PATH = join(__dirname, '..', 'web', 'channel-monitor.ts')
const src = readFileSync(MONITOR_PATH, 'utf-8')

// The blocking-menu recovery pass, from its banner comment to the next pass.
function menuRecoveryRegion(): string {
  const start = src.indexOf('// Blocking-menu recovery')
  const end = src.indexOf('// Stuck channel-input recovery', start)
  expect(start, 'menu-recovery region start not found').toBeGreaterThan(0)
  expect(end, 'menu-recovery region end not found').toBeGreaterThan(start)
  return src.slice(start, end)
}

describe('channel-monitor: model-credit dialog branch', () => {
  it('imports the pure detectors from pane-state', () => {
    expect(src).toMatch(/import\s*{[^}]*\bdetectsModelCreditDialog\b[^}]*}\s*from\s*['"]\.\.\/pane-state\.js['"]/s)
    expect(src).toMatch(/import\s*{[^}]*\bfindModelCreditDialogOption\b[^}]*}\s*from\s*['"]\.\.\/pane-state\.js['"]/s)
  })

  it('reads the configured model through the shared agent-config resolver', () => {
    // readModelFor already switches main-agent settings.json vs. sub-agent
    // agent-config.json; re-implementing that here would drift.
    expect(src).toMatch(/import\s*{[^}]*\breadModelFor\b[^}]*}\s*from\s*['"]\.\/agent-config\.js['"]/s)
    const region = menuRecoveryRegion()
    expect(region).toContain('const agentIdForModel = t.isMarveen ? MAIN_AGENT_ID : (t.agentName ?? null)')
    expect(region).toContain('const configuredModel = agentIdForModel ? readModelFor(agentIdForModel) : null')
  })

  it('runs AFTER the permission-dialog branch and BEFORE the generic Escape branch', () => {
    // Ordering is the whole contract: D1 keeps precedence (Escape there aborts
    // a tool call), and the generic Escape must never see a credit dialog.
    const region = menuRecoveryRegion()
    const permIdx = region.indexOf('detectsPermissionDialog(pane)')
    const creditIdx = region.indexOf('} else if (pane != null && detectsModelCreditDialog(pane)) {')
    const genericEscapeIdx = region.indexOf("send-keys', '-t', t.session, 'Escape'")
    expect(permIdx).toBeGreaterThan(0)
    expect(creditIdx).toBeGreaterThan(permIdx)
    expect(genericEscapeIdx).toBeGreaterThan(creditIdx)
  })

  it('sends NO Escape in the credit branch (the whole point of the fix)', () => {
    const region = menuRecoveryRegion()
    // Still exactly one Escape send in the entire pass, and it is the generic
    // one -- the credit branch adds none.
    const escapes = region.match(/send-keys', '-t', t\.session, 'Escape'/g) ?? []
    expect(escapes.length).toBe(1)
    const creditIdx = region.indexOf('detectsModelCreditDialog(pane)')
    const genericBranchIdx = region.indexOf('} else {\n          paneDialogEscalation.delete(t.session)')
    const escapeIdx = region.indexOf("send-keys', '-t', t.session, 'Escape'")
    expect(genericBranchIdx).toBeGreaterThan(creditIdx)
    expect(escapeIdx).toBeGreaterThan(genericBranchIdx)
  })

  it('navigates explicitly with the digit + settle + Enter select sequence', () => {
    const region = menuRecoveryRegion()
    expect(region).toContain('const optionNum = configuredModel ? findModelCreditDialogOption(pane, configuredModel) : null')
    expect(region).toContain('if (optionNum != null) {')
    expect(region).toContain("execFileSync(TMUX, ['send-keys', '-t', t.session, String(optionNum)], { timeout: 5000 })")
    expect(region).toContain("execFileSync('/bin/sleep', ['0.1'], { timeout: 2000 })")
    expect(region).toContain("execFileSync(TMUX, ['send-keys', '-t', t.session, 'Enter'], { timeout: 5000 })")
    // Ordering within the sequence: digit, then settle, then Enter.
    const digitIdx = region.indexOf('String(optionNum)], { timeout: 5000 })')
    const sleepIdx = region.indexOf("execFileSync('/bin/sleep', ['0.1']")
    const enterIdx = region.indexOf("t.session, 'Enter'], { timeout: 5000 })")
    expect(sleepIdx).toBeGreaterThan(digitIdx)
    expect(enterIdx).toBeGreaterThan(sleepIdx)
  })

  it('the navigation alert names the configured model and the credit consequence', () => {
    const region = menuRecoveryRegion()
    expect(region).toContain('${configuredModel} (${optionNum}. opcio)')
    expect(region).toContain('Escape-et NEM kuldtunk')
    expect(region).toContain('usage-creditet fogyaszt')
  })

  it('escalates two-phase (coordinator first) when no option matches -- never guesses', () => {
    const region = menuRecoveryRegion()
    const creditIdx = region.indexOf('detectsModelCreditDialog(pane)')
    const elseIdx = region.indexOf('} else {', region.indexOf('if (optionNum != null) {'))
    expect(elseIdx).toBeGreaterThan(creditIdx)
    const escalate = region.slice(elseIdx)
    // Reuses the pure two-phase decision + the D1 timing constants...
    expect(escalate).toContain('decideDialogEscalation(prevEsc, Date.now()')
    expect(escalate).toContain('graceMs: DIALOG_WOLFE_GRACE_MS')
    expect(escalate).toContain('dedupMs: DIALOG_ESCALATE_DEDUP_MS')
    // ...phase 1 flags the coordinator FROM the stuck sub-agent...
    expect(escalate).toContain('createAgentMessage(t.agentName, MAIN_AGENT_ID, buildModelCreditCoordinatorFlag(label, configuredModel))')
    expect(escalate).toContain("esc.action === 'notify-wolfe'")
    // ...and only phase 2 falls back to a direct owner alert.
    expect(escalate).toContain("esc.action === 'fallback-gabor'")
    expect(escalate).toContain('sendAlert(buildModelCreditOwnerFallback(label))')
    // Escalation is sub-agent-scoped; the main session gets the throttled
    // direct alert instead (it cannot delegate its own dialog to itself).
    expect(escalate).toContain('if (!t.isMarveen && t.agentName) {')
  })

  it('clears the shared escalation state once the dialog is resolved by navigation', () => {
    const region = menuRecoveryRegion()
    const navIdx = region.indexOf('if (optionNum != null) {')
    const nav = region.slice(navIdx, region.indexOf('} else {', navIdx))
    expect(nav).toContain('paneDialogEscalation.delete(t.session)')
  })

  it('the coordinator flag uses the [AUTOMATIKUS DECISION-FLAG] shape, no tmux/marker leak', () => {
    // Mirrors scripts/hooks/decision-flag.py so mr-wolfe's triage skill
    // recognises it; must never direct anyone to a terminal, and must not
    // carry a literal [DONTESRE-VAR:...] marker (the Stop hook false-detects it).
    const s = src.indexOf('function buildModelCreditCoordinatorFlag')
    expect(s).toBeGreaterThan(0)
    const flag = src.slice(s, src.indexOf('\n}\n', s))
    expect(flag).toContain('[AUTOMATIKUS DECISION-FLAG]')
    expect(flag).toContain('model-credit dialogusban')
    // It must NOT claim to be a permission prompt -- that would misroute triage.
    expect(flag).not.toContain('permission_prompt')
    expect(flag).not.toContain('tmux attach')
    expect(flag).not.toContain('[DONTESRE-VAR:')
  })

  it('the owner fallback is human-friendly (no tmux attach, no raw session-id)', () => {
    const s = src.indexOf('function buildModelCreditOwnerFallback')
    expect(s).toBeGreaterThan(0)
    const fallback = src.slice(s, src.indexOf('\n}\n', s))
    expect(fallback).toContain('modell-valasztasnal')
    expect(fallback).not.toContain('tmux attach')
    expect(fallback).not.toContain('t.session')
  })

  it('does not disturb the limit-dialog path (a different modal, Escape still correct)', () => {
    const region = menuRecoveryRegion()
    // detectsUsageLimit keys on the plan-window banner, not this modal, and it
    // stays inside the generic Escape branch where it has always lived.
    const limitIdx = region.indexOf('const limitDialog = pane != null && detectsUsageLimit(pane)')
    const escapeIdx = region.indexOf("send-keys', '-t', t.session, 'Escape'")
    expect(limitIdx).toBeGreaterThan(0)
    expect(escapeIdx).toBeGreaterThan(limitIdx)
  })
})
