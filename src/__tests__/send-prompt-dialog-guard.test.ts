// Contract test for the sendPromptToSession permission-dialog hard guard
// (2026-07-15 ive Artifact-publish incident, card 17de383f).
//
// Background: sendPromptToSession's chunk stream always ends with a submitting
// Enter. When the target pane is parked in a permission/tool-approval dialog,
// the wait-until-idle gate times out (the dialog hides the idle footer) and the
// pre-fix code fell through to a best-effort send -- typing chunks and pressing
// Enter INTO the dialog, which confirms the highlighted option (default "Yes").
// That path can self-approve an outward-facing action (Artifact web publish)
// with no human in the loop. The forceSend scheduled-task path (waitForIdle:
// false) reached the same keystrokes without even the idle wait.
//
// The fix: a pre-send capture checks detectsPermissionDialog and returns
// 'gave-up' (message stays pending; router retries after a human resolves the
// dialog) instead of typing. These asserts read the source and lock in the
// structural invariants, matching the sibling router contract tests.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { detectsPermissionDialog } from '../pane-state.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(__dirname, '..', 'web', 'agent-process.ts'), 'utf-8')

// The sendPromptToSession body, from its declaration to the chunk-stream send.
function sendPromptRegion(): string {
  const start = src.indexOf('export function sendPromptToSession(')
  expect(start, 'sendPromptToSession not found').toBeGreaterThan(0)
  const end = src.indexOf('sendChunks()', start)
  expect(end, 'sendChunks() call not found after sendPromptToSession').toBeGreaterThan(start)
  return src.slice(start, end)
}

describe('sendPromptToSession: permission-dialog hard guard', () => {
  it('imports detectsPermissionDialog from pane-state', () => {
    expect(src).toMatch(/import\s*{[^}]*\bdetectsPermissionDialog\b[^}]*}\s*from\s*['"]\.\.\/pane-state\.js['"]/)
  })

  it('checks the dialog BEFORE any chunk is typed and bails with gave-up', () => {
    const region = sendPromptRegion()
    const guardAt = region.indexOf('detectsPermissionDialog(preCapture)')
    expect(guardAt, 'dialog guard missing from the pre-send capture block').toBeGreaterThan(0)
    // The guard must return 'gave-up' (pending + retry), never fall through.
    const afterGuard = region.slice(guardAt, guardAt + 400)
    expect(afterGuard).toMatch(/return 'gave-up'/)
  })

  it('guards ahead of the preamble-clear (no clearInputBuffer against a dialog)', () => {
    const region = sendPromptRegion()
    const guardAt = region.indexOf('detectsPermissionDialog(preCapture)')
    const clearAt = region.indexOf('shouldClearTruncatedPreamble(preCapture)')
    expect(clearAt).toBeGreaterThan(0)
    expect(guardAt, 'dialog guard must run before the preamble clear').toBeLessThan(clearAt)
  })
})

describe('detectsPermissionDialog: recognises the Artifact-publish dialog shape', () => {
  // Condensed from the live 2026-07-15 agent-ive pane: modal overlay, no idle
  // footer, numbered options with a highlighted Yes.
  const ivePane = [
    '   Render an HTML or Markdown file to an Artifact — a default-private',
    '   claude.ai web page the user can share with teammates.',
    '',
    ' Publishing a file to the web requires confirmation',
    '',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    "   2. Yes, and don't ask again for Artifact commands in",
    '      /home/szabgabor/marveen/agents/ive',
    '   3. No',
    '',
    ' Esc to cancel · Tab to amend',
  ].join('\n')

  it('classifies the ive Artifact dialog as a permission dialog', () => {
    expect(detectsPermissionDialog(ivePane)).toBe(true)
  })

  it('does not fire on a healthy idle pane', () => {
    const idle = ['❯ ', '', '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ? for shortcuts'].join('\n')
    expect(detectsPermissionDialog(idle)).toBe(false)
  })
})
