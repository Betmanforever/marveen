// Contract tests for the limit-aware menu-recovery alert (2026-07-05 incident).
//
// Background: the Claude plan session-limit modal ("You've hit your session
// limit · resets 3:10am") wears the same navigable-modal footer as a genuine
// blocking menu, so the menu-recovery pass classified it as one and the
// operator alert misleadingly blamed an interactive menu "(pl. /mcp)". The fix
// keeps the Escape recovery identical but names the real cause -- reusing
// detectsUsageLimit from the pure model-fallback module -- and includes the
// extracted reset time.
//
// As with the sibling channel-monitor tests, we cannot drive a real tmux
// interaction from a unit test, so the asserts read the source and lock in
// the structural invariants the fix introduced. The pure pieces
// (detectsUsageLimit, extractLimitReset) have behavioral tests in
// model-fallback.test.ts.

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
  // The end marker's phrase also occurs earlier in the file; search from start.
  const end = src.indexOf('// Stuck channel-input recovery', start)
  expect(start, 'menu-recovery region start not found').toBeGreaterThan(0)
  expect(end, 'menu-recovery region end not found').toBeGreaterThan(start)
  return src.slice(start, end)
}

describe('channel-monitor: limit-aware menu-recovery alert', () => {
  it('imports the limit detectors from the pure model-fallback module', () => {
    expect(src).toMatch(/import\s*{[^}]*\bdetectsUsageLimit\b[^}]*}\s*from\s*['"]\.\.\/model-fallback\.js['"]/)
    expect(src).toMatch(/import\s*{[^}]*\bextractLimitReset\b[^}]*}\s*from\s*['"]\.\.\/model-fallback\.js['"]/)
  })

  it('distinguishes the limit dialog from a genuine menu via the pane banner', () => {
    const region = menuRecoveryRegion()
    expect(region).toContain('const limitDialog = pane != null && detectsUsageLimit(pane)')
  })

  it('the limit-variant alert names the real cause and the reset time', () => {
    const region = menuRecoveryRegion()
    expect(region).toContain('a plan usage-limit dialogusaban all (nem menu-beragadas)')
    expect(region).toContain("${reset ?? 'ismeretlen'}")
    expect(region).toContain('A model-fallback kezeli, kulon teendo nincs.')
  })

  it('the genuine-menu alert is unchanged', () => {
    const region = menuRecoveryRegion()
    expect(region).toContain('beragadt egy interaktiv menube (pl. /mcp) es nem dolgozott fel uzeneteket')
  })

  it('the recovery Escape stays unconditional (sent before the alert branches)', () => {
    const region = menuRecoveryRegion()
    // Exactly one Escape send in the pass, and it precedes the limitDialog
    // alert branch -- i.e. it is NOT gated on the limit/menu distinction.
    const escapes = region.match(/send-keys', '-t', t\.session, 'Escape'/g) ?? []
    expect(escapes.length).toBe(1)
    const escapeIdx = region.indexOf("'Escape'")
    const limitAlertIdx = region.indexOf('if (limitDialog) {')
    expect(escapeIdx).toBeGreaterThan(0)
    expect(limitAlertIdx).toBeGreaterThan(escapeIdx)
  })

  it('the D1 permission-dialog escalation path is untouched', () => {
    const region = menuRecoveryRegion()
    expect(region).toContain('engedely-dialogusban all es dontesre var')
  })
})

// The limit-dialog alert dedup: the 5-min menu dedup restarts with every menu
// spell, and each model-fallback respawn re-hit the plan-wide limit and
// started a fresh spell, so one 35-min limit window produced 5 identical
// alerts + 5 resume nudges. The fix throttles the messaging (NOT the Escape
// recovery) to one per session per limit window on a dedicated timestamp map
// that survives the menu-state clear until the limit banner is gone too.
describe('channel-monitor: one limit-dialog alert per limit window', () => {
  it('declares a dedicated 60-min throttle for the limit-dialog alert', () => {
    expect(src).toMatch(/const LIMIT_DIALOG_ALERT_DEDUP_MS = 60 \* 60 \* 1000/)
    expect(src).toMatch(/const paneLimitDialogAlertAt: Map<string, number> = new Map\(\)/)
  })

  it('gates BOTH the alert and the resume nudge on the throttle in the limit case', () => {
    const region = menuRecoveryRegion()
    // notify defaults true (genuine menus keep today's cadence) and is only
    // narrowed for the limit dialog.
    expect(region).toContain('let notify = true')
    expect(region).toMatch(/notify = Date\.now\(\) - lastLimitAlert >= LIMIT_DIALOG_ALERT_DEDUP_MS/)
    // The nudge enqueue sits INSIDE the notify gate...
    const notifyIdx = region.indexOf('if (notify) {')
    const nudgeIdx = region.indexOf('MENU_RECOVER_NUDGE)')
    expect(notifyIdx).toBeGreaterThan(0)
    expect(nudgeIdx).toBeGreaterThan(notifyIdx)
    // ...while the recovery Escape stays before (outside) it, per-cycle.
    expect(region.indexOf("'Escape'")).toBeLessThan(notifyIdx)
  })

  it('the throttle survives the menu-state clear while the limit banner persists', () => {
    const region = menuRecoveryRegion()
    // The state-clear branch may only reset the limit throttle when the pane
    // ALSO shows no limit banner (a respawn clears the menu spell mid-window
    // while the plan window still holds).
    expect(region).toMatch(/if \(pane != null && !detectsUsageLimit\(pane\)\) \{\s*\n\s*paneLimitDialogAlertAt\.delete\(t\.session\)/)
    // No unconditional delete of the limit throttle anywhere in the pass.
    const deletes = region.match(/paneLimitDialogAlertAt\.delete\(/g) ?? []
    expect(deletes.length).toBe(1)
  })
})
