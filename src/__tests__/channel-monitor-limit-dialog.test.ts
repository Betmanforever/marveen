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
