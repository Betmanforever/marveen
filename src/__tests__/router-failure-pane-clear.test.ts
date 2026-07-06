// Contract test for the router's failed-delivery pane hygiene (2026-07-06
// fork-storm incident).
//
// Background: when sendPromptToSession throws mid-chunk-stream (e.g. the
// inter-chunk sleep spawn ETIMEDOUT under fork-storm load), the router caught
// the error and marked the message failed WITHOUT cleaning the target pane.
// The half-typed message stayed parked in the input box, and the stuck-input
// watcher later submitted the truncated garbage as a phantom turn. The fix:
// before markMessageFailed, best-effort clear the target pane's input buffer
// (clearInputBuffer, Ctrl-U) so a failed delivery never leaves injectable
// residue behind.
//
// The router loop is tmux/db-bound, so as with the sibling router tests the
// asserts read the source and lock in the structural invariants.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROUTER_PATH = join(__dirname, '..', 'web', 'message-router.ts')
const src = readFileSync(ROUTER_PATH, 'utf-8')

// The delivery-failure catch branch, from its log line to the miss-set reset.
function deliveryCatchRegion(): string {
  const start = src.indexOf("'Failed to deliver agent message'")
  expect(start, 'delivery-failure catch branch not found').toBeGreaterThan(0)
  const end = src.indexOf('routerLoggedMisses.delete(msg.id)', start)
  expect(end, 'catch-branch end not found').toBeGreaterThan(start)
  return src.slice(start, end)
}

describe('message-router: failed delivery clears the target input buffer', () => {
  it('imports clearInputBuffer from agent-process', () => {
    expect(src).toMatch(/import\s*{[^}]*\bclearInputBuffer\b[^}]*}\s*from\s*['"]\.\/agent-process\.js['"]/)
  })

  it('clears the pane BEFORE marking the message failed', () => {
    const region = deliveryCatchRegion()
    const clearIdx = region.indexOf('clearInputBuffer(session, host)')
    const failIdx = region.indexOf("markMessageFailed(msg.id, 'Failed to inject into tmux session')")
    expect(clearIdx).toBeGreaterThan(0)
    expect(failIdx).toBeGreaterThan(clearIdx)
  })

  it('the clear itself is best-effort (pane may be gone) and logs its failure', () => {
    const region = deliveryCatchRegion()
    expect(region).toMatch(/try \{\s*\n\s*clearInputBuffer\(session, host\)\s*\n\s*\} catch \(clearErr\)/)
    expect(region).toContain("'Post-failure input-buffer clear failed'")
  })

  it('documents the phantom-injection mechanism it prevents', () => {
    const region = deliveryCatchRegion()
    expect(region).toContain('phantom')
    expect(region).toContain('stuck-input watcher')
  })
})
