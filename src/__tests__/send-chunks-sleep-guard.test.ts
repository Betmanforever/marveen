// Contract test for the inter-chunk pacing sleep in sendPromptToSession's
// sendChunks closure (2026-07-06 fork-storm incident).
//
// Background: sendChunks streams the prompt into the pane as 80-char literal
// send-keys writes with a 30ms /bin/sleep between them. During a fork-storm
// (two agents respawning at once) the sleep's own child-process spawn hit
// ETIMEDOUT; the uncaught exception aborted the chunk stream mid-message,
// leaving half-typed text parked in the target pane. The router then marked
// the message failed and the stuck-input watcher later SUBMITTED the truncated
// garbage as a phantom turn. The pacing gap is an optimisation, not a
// correctness requirement -- a lost gap at worst risks the paste-detector
// placeholder, which the post-send retry loop already recovers via
// 'clear-and-resend' -- so the sleep must be best-effort like its siblings
// (the retry-poll sleep, the idle-wait sleep).
//
// We cannot drive a real tmux + child_process interaction from a unit test,
// so the assert reads the source and locks in the try/catch wrapper.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const AGENT_PROCESS_PATH = join(__dirname, '..', 'web', 'agent-process.ts')
const src = readFileSync(AGENT_PROCESS_PATH, 'utf-8')

// The sendChunks closure, from its declaration to its first invocation.
function sendChunksRegion(): string {
  const start = src.indexOf('const sendChunks = (): void => {')
  expect(start, 'sendChunks closure not found').toBeGreaterThan(0)
  const end = src.indexOf('\n  sendChunks()', start)
  expect(end, 'sendChunks() call not found').toBeGreaterThan(start)
  return src.slice(start, end)
}

describe('sendChunks: inter-chunk sleep is best-effort', () => {
  it('wraps the 30ms pacing sleep in try/catch (sibling call-site idiom)', () => {
    const region = sendChunksRegion()
    expect(region).toContain("try { execFileSync('/bin/sleep', ['0.03'], { timeout: 1000 }) } catch { /* best effort */ }")
  })

  it('no bare (unguarded) sleep spawn remains in the chunk loop', () => {
    const region = sendChunksRegion()
    const all = region.match(/execFileSync\('\/bin\/sleep'/g) ?? []
    const guarded = region.match(/try \{ execFileSync\('\/bin\/sleep'/g) ?? []
    expect(all.length).toBeGreaterThan(0)
    expect(guarded.length).toBe(all.length)
  })

  it('documents WHY (fork-storm ETIMEDOUT must not abort the chunk stream)', () => {
    const region = sendChunksRegion()
    expect(region).toContain('fork-storm')
    expect(region).toContain('2026-07-06')
  })
})
