// Unconfirmed-typed-prompt rollback (card 919b96a8, layer 1).
//
// ROOT CAUSE of the 2026-08-01 13:04-13:28 episode: sendPromptToSession typed
// the folyamatos-ellenorzes prompt into the coordinator's panel, never confirmed
// the submit, returned 'gave-up' -- and LEFT the text parked in the input box. A
// multi-row parked prompt blocks the pane until a human presses Enter, so the
// coordinator's panel stayed locked for 24 minutes; the queue backed up behind
// it and the downstream watchdog eventually paged Gabor about a purely internal
// wedge.
//
// The fix is preserve-then-clear, and it has exactly one hard invariant: only
// content the send can attribute to ITSELF is ever cleared. The decision is pure
// (decideParkedPromptRollback), so both halves are testable without tmux; the
// preserve half (saveParkedInputRollback) is plain fs and is driven against a
// tmpdir here.

import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, chmodSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decideParkedPromptRollback } from '../pane-state.js'
import { saveParkedInputRollback } from '../web/agent-process.js'

const SEP = '─'.repeat(80)
const FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle)'

// The payload hint the send loop matches on: the first ~96 chars of the
// one-lined prompt (see sendPromptToSession).
const HINT = '[SYSTEM: folyamatos-ellenorzes] Nezd at a flotta aktiv sub-agent paneljeit es jelezd ha valaki'

// OUR payload, parked verbatim across several rows -- the 13:04 shape. A plain
// Enter cannot submit a multi-row buffer, which is why it sat for 24 minutes.
const OWN_PAYLOAD_PARKED = [
  '',
  SEP,
  '❯ [SYSTEM: folyamatos-ellenorzes] Nezd at a flotta aktiv sub-agent paneljeit es jelezd ha valaki',
  '  dontesre var vagy tetlenul all egy elutasitott lepes utan. Ha van ilyen, oldd fel vagy forditsd',
  '  le emberi nyelvre Gabornak.',
  SEP,
  FOOTER,
].join('\n')

// OUR payload swallowed by the bracketed-paste detector: the `[Pasted text #N]`
// stub our own chunk stream tripped. Also ours, also clearable.
const OWN_PAYLOAD_PLACEHOLDER = [
  '',
  SEP,
  '❯ [Pasted text #12 +1180 chars]',
  SEP,
  FOOTER,
].join('\n')

// NOT ours: something a human started typing. The send loop must never touch
// this -- it is decideSubmitVerdict's 'unexplained' class.
const HUMAN_DRAFT_PARKED = [
  '',
  SEP,
  '❯ Szia, meg atnezem a backup logot es utana valaszolok',
  SEP,
  FOOTER,
].join('\n')

// NOT attributable either: the msg-1105 shape, where a hard wrap split the
// payload mid-token so the verbatim match broke. We can no longer prove the box
// holds our text, so it stays untouched.
const MUTATED_PAYLOAD_PARKED = [
  '',
  SEP,
  '❯ [SYSTEM: folyamatos-ellenorzes] Nezd at a flotta aktiv sub-agent paneljeit es jelezd ha val',
  '  aki dontesre var vagy tetlenul all egy elutasitott lepes utan.',
  SEP,
  FOOTER,
].join('\n')

const CLEAN_IDLE = ['', SEP, '❯ ', SEP, FOOTER].join('\n')

const BUSY_WITH_OUR_TEXT = [
  '✢ Combobulating… (52s · ↓ 2.6k tokens · esc to interrupt)',
  '',
  SEP,
  '❯ [SYSTEM: folyamatos-ellenorzes] Nezd at a flotta aktiv sub-agent paneljeit es jelezd ha valaki',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt',
].join('\n')

describe('decideParkedPromptRollback: only OUR text is ever cleared', () => {
  it('rolls back a verbatim-parked payload -- the 24-minute wedge shape', () => {
    expect(decideParkedPromptRollback(OWN_PAYLOAD_PARKED, HINT)).toBe('preserve-then-clear')
  })

  it('rolls back the paste placeholder our own chunk stream tripped', () => {
    expect(decideParkedPromptRollback(OWN_PAYLOAD_PLACEHOLDER, HINT)).toBe('preserve-then-clear')
  })

  it('LEAVES a human draft alone (the invariant)', () => {
    expect(decideParkedPromptRollback(HUMAN_DRAFT_PARKED, HINT)).toBe('hands-off')
  })

  it('LEAVES unexplained parked content alone when the verbatim match broke', () => {
    // Guard the fixture: the hint really is not a substring any more, so this
    // case genuinely exercises the unattributable path.
    expect(MUTATED_PAYLOAD_PARKED.includes(HINT)).toBe(false)
    expect(decideParkedPromptRollback(MUTATED_PAYLOAD_PARKED, HINT)).toBe('hands-off')
  })

  it('does nothing on a clean box -- a Ctrl-C into an empty box quits the TUI', () => {
    expect(decideParkedPromptRollback(CLEAN_IDLE, HINT)).toBe('hands-off')
  })

  it('does nothing on a busy pane -- a live turn must never be interrupted', () => {
    expect(decideParkedPromptRollback(BUSY_WITH_OUR_TEXT, HINT)).toBe('hands-off')
  })

  it('does nothing when the capture failed (we cannot see what we would clear)', () => {
    expect(decideParkedPromptRollback(null, HINT)).toBe('hands-off')
  })

  it('does nothing on a too-short hint -- a generic fragment must not match UI text', () => {
    // Mirrors shouldRetrySubmit's 16-char floor: a short hint could otherwise
    // match arbitrary prose in somebody else's parked line.
    expect(decideParkedPromptRollback(HUMAN_DRAFT_PARKED, 'Szia')).toBe('hands-off')
  })
})

describe('saveParkedInputRollback: preserve BEFORE clearing', () => {
  const dirs: string[] = []
  const newDir = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'parked-rollback-'))
    dirs.push(d)
    return d
  }
  afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

  it('writes the typed payload AND the pane capture, so nothing is lost', () => {
    const dir = newDir()
    const file = saveParkedInputRollback('mr-wolfe-channels', OWN_PAYLOAD_PARKED, 'the full one-lined payload as typed', dir)
    expect(file).not.toBeNull()
    const body = readFileSync(file!, 'utf-8')
    expect(body).toContain('mr-wolfe-channels')
    expect(body).toContain('the full one-lined payload as typed')
    expect(body).toContain('folyamatos-ellenorzes')
  })

  it('is owner-readable only: the payload can carry prompt content', () => {
    const dir = newDir()
    const file = saveParkedInputRollback('agent-neo', CLEAN_IDLE, 'payload', dir)
    expect(statSync(file!).mode & 0o077).toBe(0)
  })

  it('never writes outside the rollback dir, whatever the session name looks like', () => {
    const dir = newDir()
    const file = saveParkedInputRollback('../../etc/cron.d/x', CLEAN_IDLE, 'payload', dir)
    expect(file!.startsWith(dir + '/')).toBe(true)
    expect(readdirSync(dir)).toHaveLength(1)
  })

  it('returns null when the preserve fails -- the caller must then NOT clear', () => {
    const dir = newDir()
    chmodSync(dir, 0o500)
    try {
      expect(saveParkedInputRollback('mr-wolfe-channels', OWN_PAYLOAD_PARKED, 'payload', dir)).toBeNull()
    } finally {
      chmodSync(dir, 0o700)
    }
  })

  it('records a failed capture explicitly rather than silently writing nothing', () => {
    const dir = newDir()
    const file = saveParkedInputRollback('agent-neo', null, 'payload we typed', dir)
    const body = readFileSync(file!, 'utf-8')
    expect(body).toContain('capture failed')
    expect(body).toContain('payload we typed')
  })
})
