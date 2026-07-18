import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// Source-region regression tests for the worker stuck-alert path (card
// ceb92ac3). Two defects surfaced by the 2026-07-18 23:01 false alarm:
//  (1) ordering -- ensureWorkerReady alerted the operator BEFORE the central
//      restart-and-retry in runViaWorker had run, so every successful
//      self-heal still blasted a stale "keszenlet nem allt helyre" alert;
//  (2) policy -- the alert text directed Gabor to a terminal (tmux attach),
//      violating the Telegram-only rule (same class the channel-monitor
//      dialog/limit alerts were already purged of).
// Mirrors the channel-monitor-*-dialog test pattern: assert on the source
// so a reintroduction of either defect fails loudly.

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'agent-worker.ts'),
  'utf-8',
)

function region(startMarker: string): string {
  const s = src.indexOf(startMarker)
  expect(s).toBeGreaterThan(-1)
  return src.slice(s, src.indexOf('\n}\n', s))
}

describe('worker stuck alert ordering (card ceb92ac3)', () => {
  it('ensureWorkerReady never alerts the operator itself', () => {
    const r = region('async function ensureWorkerReady')
    expect(r).not.toContain('alertWorkerStuck')
    // It still leaves a diagnostic trail for the caller's decision.
    expect(r).toContain('caller decides retry/alert')
  })

  it('runViaWorker alerts only on the TERMINAL not-ready failure, after the retry', () => {
    const r = region('export async function runViaWorker')
    // The attempt-0 branch restarts and retries without alerting...
    expect(r).toContain("if (r.error === 'worker session not ready' && attempt === 0)")
    // ...and only the terminal branch (retry exhausted) raises the alert.
    const terminal = r.indexOf("if (r.error === 'worker session not ready') {")
    expect(terminal).toBeGreaterThan(r.indexOf('&& attempt === 0'))
    expect(r.slice(terminal)).toContain('alertWorkerStuck')
  })
})

describe('worker stuck alert text (Telegram-only rule)', () => {
  it('never directs the owner to a terminal', () => {
    const alert = region('function alertWorkerStuck')
    expect(alert).not.toContain('tmux attach')
    expect(alert).not.toContain('Nezz ra:')
    // Human-friendly escalation: point at the agents, not at a session.
    expect(alert).toContain('Szolj neo-nak vagy mr-wolfe-nak')
  })

  it('the alert text reflects that restart+retry already ran', () => {
    const alert = region('function alertWorkerStuck')
    expect(alert).toContain('ujraprobalkozas) utan SEM allt keszen')
  })
})
