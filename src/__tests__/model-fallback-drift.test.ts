import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  normalizeModelId,
  deriveMeasuredModel,
  advanceDriftStreak,
  decideDriftAction,
  decideMidSessionDriftAction,
  DRIFT_SAMPLE_ROWS,
  DRIFT_MIN_ROWS,
  MIN_MIDSESSION_DRIFT_SWEEPS,
  type ModelDriftStreak,
  type MidSessionDriftFacts,
} from '../model-fallback.js'
import { readBootModelSample } from '../web/active-model.js'

// Unintended model-drift detection (card b0c90a8a, incident 2026-07-31).
//
// The incident, replayed from the primary sources so the fixtures below are
// measurements rather than invented shapes: the main channels session was
// restarted at 15:01:01 CEST (tmux session_created 1785502861) with the
// correct `--model claude-fable-5`, yet transcript
// d1ab52c1-3afd-4929-bda5-256a34bef48b.jsonl opens with SIX consecutive
// claude-sonnet-5 assistant turns between 13:01:30Z and 13:01:46Z, and stays
// on Sonnet for 22 turns until the owner switched by hand at ~13:31Z.
//
// The whole point of these tests is the distinction that makes the feature
// safe: a drift correction goes BACK to the configured model, while a
// usage-limit downgrade deliberately goes DOWN the chain -- so the correction
// must never fire against a live fallback.

const FABLE = 'claude-fable-5'
const SONNET5 = 'claude-sonnet-5'
const OPUS48 = 'claude-opus-4-8'

describe('normalizeModelId', () => {
  it('strips the [1m] context-window marker', () => {
    expect(normalizeModelId('claude-opus-4-8[1m]')).toBe(OPUS48)
    // The chain rung and the API's answer must compare equal, or every agent
    // on the 1m rung would read as permanently drifted.
    expect(normalizeModelId('claude-opus-4-8[1m]')).toBe(normalizeModelId(OPUS48))
  })

  it('strips a trailing -YYYYMMDD version pin', () => {
    expect(normalizeModelId('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5')
  })

  it('leaves a version-shaped model suffix that is NOT a date alone', () => {
    // claude-sonnet-4-6 must not be mistaken for a dated pin.
    expect(normalizeModelId('claude-sonnet-4-6')).toBe('claude-sonnet-4-6')
    expect(normalizeModelId(SONNET5)).toBe(SONNET5)
  })

  it('trims surrounding whitespace', () => {
    expect(normalizeModelId('  claude-fable-5 ')).toBe(FABLE)
  })
})

describe('deriveMeasuredModel', () => {
  it('reads the measured main-loop model from the incident sample', () => {
    // The six turns the restarted session actually produced.
    expect(deriveMeasuredModel(Array(6).fill(SONNET5))).toBe(SONNET5)
  })

  it('returns null below the minimum sample -- a young session is not evidence', () => {
    expect(deriveMeasuredModel([])).toBeNull()
    expect(deriveMeasuredModel(Array(DRIFT_MIN_ROWS - 1).fill(SONNET5))).toBeNull()
    expect(deriveMeasuredModel(Array(DRIFT_MIN_ROWS).fill(SONNET5))).toBe(SONNET5)
  })

  it('takes the majority of the earliest rows, not the token-weighted winner', () => {
    // Where sub-agent turns land INLINE in the parent session log they can
    // out-weigh the main loop outright (measured 2026-07-30 on session
    // 0ba2dcef: fable 147k tokens vs opus 130k), so token weight is the wrong
    // signal. Claude Code 2.1.220 writes them to a `subagents/` sidecar
    // instead (measured 2026-07-31 on session d1ab52c1), but the majority rule
    // has to hold under BOTH -- the earliest rows belong to the main loop
    // either way, because a sub-agent cannot answer before it is spawned.
    expect(deriveMeasuredModel([FABLE, FABLE, FABLE, OPUS48, FABLE, OPUS48, OPUS48])).toBe(FABLE)
  })

  it('ignores rows past the sample window', () => {
    const rows = [...Array(DRIFT_SAMPLE_ROWS).fill(SONNET5), ...Array(50).fill(OPUS48)]
    expect(deriveMeasuredModel(rows)).toBe(SONNET5)
  })

  it('returns null on a tie -- an ambiguous sample must not restart a session', () => {
    expect(deriveMeasuredModel([FABLE, OPUS48, FABLE, OPUS48])).toBeNull()
  })

  it('ignores blank entries when counting the sample', () => {
    expect(deriveMeasuredModel(['', '  ', SONNET5, SONNET5, SONNET5])).toBe(SONNET5)
  })
})

describe('advanceDriftStreak', () => {
  it('clears the streak when the measured model matches the configured one', () => {
    expect(advanceDriftStreak(null, FABLE, FABLE)).toBeNull()
    expect(advanceDriftStreak({ model: SONNET5, sweeps: 3 }, FABLE, FABLE)).toBeNull()
  })

  it('treats a [1m] rung and its bare id as the same model', () => {
    expect(advanceDriftStreak(null, OPUS48, 'claude-opus-4-8[1m]')).toBeNull()
  })

  it('opens a streak on the first drift sighting', () => {
    expect(advanceDriftStreak(null, SONNET5, FABLE)).toEqual({ model: SONNET5, sweeps: 1 })
  })

  it('counts consecutive sightings of the SAME drift', () => {
    const first = advanceDriftStreak(null, SONNET5, FABLE)
    expect(advanceDriftStreak(first, SONNET5, FABLE)).toEqual({ model: SONNET5, sweeps: 2 })
  })

  it('restarts the count when the measured model changes', () => {
    const prev: ModelDriftStreak = { model: SONNET5, sweeps: 4 }
    expect(advanceDriftStreak(prev, OPUS48, FABLE)).toEqual({ model: OPUS48, sweeps: 1 })
  })

  it('clears the streak on an unmeasurable sweep', () => {
    // "Sustained" has to mean consecutive POSITIVE observations -- otherwise a
    // flapping measurement accumulates its way to a restart it never earned.
    const prev: ModelDriftStreak = { model: SONNET5, sweeps: 1 }
    expect(advanceDriftStreak(prev, null, FABLE)).toBeNull()
  })
})

describe('decideDriftAction', () => {
  const base = {
    // The agent's newest turn still answers on the wrong model, i.e. the drift
    // is live. Overridden per test where the recovery veto is the subject.
    latestModel: SONNET5,
    configuredModel: FABLE,
    hasActiveDowngrade: false,
    limitSignal: false,
    minSweeps: 2,
  }

  it('does nothing without a streak', () => {
    expect(decideDriftAction({ ...base, streak: null }))
      .toEqual({ kind: 'none', reason: 'no-drift' })
  })

  it('does nothing on a single sighting', () => {
    expect(decideDriftAction({ ...base, streak: { model: SONNET5, sweeps: 1 } }))
      .toEqual({ kind: 'none', reason: 'not-sustained' })
  })

  it('corrects BACK to the configured model once the drift is sustained', () => {
    expect(decideDriftAction({ ...base, streak: { model: SONNET5, sweeps: 2 } }))
      .toEqual({ kind: 'correct', model: FABLE, measured: SONNET5 })
  })

  it('NEVER corrects once the newest turn is back on the configured model', () => {
    // The streak is built from the boot's FIRST rows, which never change while
    // the session lives -- so after a hand fix (/model, or an operator
    // answering the dialog) it keeps reporting a drift that is already over.
    // Without this veto the incident's own agent would be restarted for it.
    expect(decideDriftAction({
      ...base, streak: { model: SONNET5, sweeps: 99 }, latestModel: FABLE,
    })).toEqual({ kind: 'none', reason: 'already-recovered' })
  })

  it('applies the recovery veto through model normalization', () => {
    expect(decideDriftAction({
      ...base,
      streak: { model: SONNET5, sweeps: 99 },
      configuredModel: 'claude-opus-4-8[1m]',
      latestModel: OPUS48,
    })).toEqual({ kind: 'none', reason: 'already-recovered' })
  })

  it('still corrects when the newest turn is a THIRD model', () => {
    // A sub-agent answering mid-sweep must not read as recovery.
    expect(decideDriftAction({
      ...base, streak: { model: SONNET5, sweeps: 2 }, latestModel: OPUS48,
    })).toEqual({ kind: 'correct', model: FABLE, measured: SONNET5 })
  })

  it('NEVER corrects while an intentional downgrade is active', () => {
    // The core safety property: a usage-limit fallback is SUPPOSED to run off
    // the original model. Correcting there would undo a deliberate downgrade
    // and, under an account-scoped limit, re-trip it immediately.
    expect(decideDriftAction({
      ...base, streak: { model: SONNET5, sweeps: 99 }, hasActiveDowngrade: true,
    })).toEqual({ kind: 'none', reason: 'intentional-downgrade' })
  })

  it('NEVER corrects while a limit / access signal is on the pane', () => {
    // Restarting onto the higher configured model under a live limit buys
    // nothing; decideModelAction owns that situation.
    expect(decideDriftAction({
      ...base, streak: { model: SONNET5, sweeps: 99 }, limitSignal: true,
    })).toEqual({ kind: 'none', reason: 'limit-signal' })
  })

  it('reports the downgrade guard first when both guards apply', () => {
    expect(decideDriftAction({
      ...base, streak: { model: SONNET5, sweeps: 99 },
      hasActiveDowngrade: true, limitSignal: true,
    })).toEqual({ kind: 'none', reason: 'intentional-downgrade' })
  })

  it('replays the 2026-07-31 incident end to end', () => {
    // Two sweeps over the six Sonnet turns the restarted session produced.
    const measured = deriveMeasuredModel(Array(6).fill(SONNET5))
    let streak = advanceDriftStreak(null, measured, FABLE)
    expect(decideDriftAction({ ...base, streak })).toEqual({ kind: 'none', reason: 'not-sustained' })
    streak = advanceDriftStreak(streak, measured, FABLE)
    expect(decideDriftAction({ ...base, streak }))
      .toEqual({ kind: 'correct', model: FABLE, measured: SONNET5 })
  })
})

// --- transcript scan -------------------------------------------------------

const BOOT = 1_785_502_861 // the incident's tmux session_created, CEST 15:01:01

function iso(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString()
}

function assistantLine(unixSec: number, model: string | null, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'assistant', entrypoint: 'cli', timestamp: iso(unixSec),
    message: { model, id: `msg-${unixSec}` }, ...extra,
  })
}

describe('readBootModelSample', () => {
  const dirs: string[] = []

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
  })

  /** Build a config root holding one session log, and return that root. */
  function withTranscript(lines: string[], sessionId = 'sess-1'): string {
    const root = mkdtempSync(join(tmpdir(), 'boot-models-'))
    dirs.push(root)
    const projectDir = join(root, 'projects', '-work')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), lines.join('\n') + '\n')
    return root
  }

  /** Add another session log to an existing config root. */
  function addTranscript(root: string, sessionId: string, lines: string[]): void {
    writeFileSync(join(root, 'projects', '-work', `${sessionId}.jsonl`), lines.join('\n') + '\n')
  }

  it('returns the models of the turns this boot produced, in order', () => {
    const root = withTranscript([
      assistantLine(BOOT + 29, SONNET5),
      assistantLine(BOOT + 30, SONNET5),
      assistantLine(BOOT + 45, SONNET5),
    ])
    expect(readBootModelSample('/work', BOOT, root)).toEqual({
      bootModels: [SONNET5, SONNET5, SONNET5],
      latestModel: SONNET5,
    })
  })

  it('skips headless (sdk-cli) session logs even when they are the newest', () => {
    // Measured 2026-07-31: `claude -p` runs (this runner's own model probe,
    // the audit-brief exporter) write into the SAME project dir, are
    // short-lived, and answer on a different model. Reading one instead of the
    // tmux session's log reports a drift that does not exist.
    const root = withTranscript([assistantLine(BOOT + 10, FABLE)], 'sess-live')
    addTranscript(root, 'zz-headless', [
      assistantLine(BOOT + 20, SONNET5, { entrypoint: 'sdk-cli' }),
    ])
    expect(readBootModelSample('/work', BOOT, root)).toEqual({
      bootModels: [FABLE],
      latestModel: FABLE,
    })
  })

  it('measures nothing when the only recent log is headless', () => {
    const root = withTranscript([
      assistantLine(BOOT + 20, SONNET5, { entrypoint: 'sdk-cli' }),
    ])
    expect(readBootModelSample('/work', BOOT, root)).toEqual({ bootModels: [], latestModel: null })
  })

  it('excludes turns from BEFORE the boot boundary', () => {
    // The --continue restart path appends to the SAME session log, so the
    // pre-restart turns sit right above the ones we want (measured: session
    // 440a4480 spans 31 hours across restarts). Counting them would measure
    // the model the agent ran yesterday.
    const root = withTranscript([
      assistantLine(BOOT - 7200, FABLE),
      assistantLine(BOOT - 3600, FABLE),
      assistantLine(BOOT + 29, SONNET5),
      assistantLine(BOOT + 30, SONNET5),
    ])
    expect(readBootModelSample('/work', BOOT, root).bootModels).toEqual([SONNET5, SONNET5])
  })

  it('caps the boot sample at the limit but keeps tracking the newest turn', () => {
    // The recovery veto depends on latestModel following the session past the
    // sampling window -- this is the /model-fix case in miniature.
    const lines = Array.from({ length: 20 }, (_, i) => assistantLine(BOOT + i, SONNET5))
    lines.push(assistantLine(BOOT + 900, FABLE))
    const root = withTranscript(lines)
    const sample = readBootModelSample('/work', BOOT, root, 7)
    expect(sample.bootModels).toEqual(Array(7).fill(SONNET5))
    expect(sample.latestModel).toBe(FABLE)
  })

  it('skips non-assistant rows, synthetic models and malformed lines', () => {
    const root = withTranscript([
      JSON.stringify({ type: 'user', timestamp: iso(BOOT + 1), message: { model: OPUS48 } }),
      assistantLine(BOOT + 2, '<synthetic>'),
      assistantLine(BOOT + 3, null),
      '{ not json',
      JSON.stringify({ type: 'assistant', message: { model: OPUS48 } }), // no timestamp
      assistantLine(BOOT + 4, SONNET5),
    ])
    expect(readBootModelSample('/work', BOOT, root).bootModels).toEqual([SONNET5])
  })

  it('returns nothing when the project dir does not exist', () => {
    expect(readBootModelSample('/work', BOOT, join(tmpdir(), 'no-such-config-root')))
      .toEqual({ bootModels: [], latestModel: null })
  })

  it('ignores the per-session subagents/ sidecar logs', () => {
    // Claude Code 2.1.220 writes Task-tool runs to
    // <session>/subagents/agent-*.jsonl. Those are a DIFFERENT model by
    // design, and the sidecar is written later than the session log -- picking
    // it up would report a permanent false drift on every agent that delegates.
    const root = withTranscript([assistantLine(BOOT + 1, FABLE)], 'sess-main')
    const sidecar = join(root, 'projects', '-work', 'sess-main', 'subagents')
    mkdirSync(sidecar, { recursive: true })
    writeFileSync(join(sidecar, 'agent-abc.jsonl'), assistantLine(BOOT + 2, OPUS48) + '\n')
    expect(readBootModelSample('/work', BOOT, root).bootModels).toEqual([FABLE])
  })

  it('reports the boot sample UNMEASURABLE when the boundary is outside the scanned tail', () => {
    // Safety direction: without proof that the scan reached back past the
    // boot, the earliest visible rows are NOT this boot's first rows and could
    // be sub-agent traffic -- so measure nothing rather than guess. The newest
    // turn is still readable, because every tail row is post-boot there.
    const pad = 'x'.repeat(4096)
    const lines = [assistantLine(BOOT - 60, FABLE)]
    for (let i = 0; i < 600; i++) lines.push(assistantLine(BOOT + i, SONNET5, { pad }))
    const root = withTranscript(lines)
    const sample = readBootModelSample('/work', BOOT, root)
    expect(sample.bootModels).toEqual([])
    expect(sample.latestModel).toBe(SONNET5)
  })
})

describe('decideMidSessionDriftAction', () => {
  // The measured mid-session case (2026-07-31 10:37): neo booted on Fable,
  // slid to opus-4-8 with no dialog and no config change, and stayed there
  // for 5+ hours. The boot rows read Fable forever, so only the latestModel
  // streak can see it -- and the response must be an ALERT, never a restart
  // (audit R2: past the boot window the blast radius is a working context).
  const base = (over: Partial<MidSessionDriftFacts> = {}): MidSessionDriftFacts => ({
    streak: { model: OPUS48, sweeps: MIN_MIDSESSION_DRIFT_SWEEPS },
    bootMeasured: FABLE,
    configuredModel: FABLE,
    hasActiveDowngrade: false,
    limitSignal: false,
    minSweeps: MIN_MIDSESSION_DRIFT_SWEEPS,
    alreadyAlerted: false,
  })

  it('alerts on the incident shape: clean boot, sustained wrong latest model', () => {
    expect(decideMidSessionDriftAction(base())).toEqual({ kind: 'alert', measured: OPUS48 })
  })

  it('does nothing without a streak', () => {
    expect(decideMidSessionDriftAction({ ...base(), streak: null }))
      .toEqual({ kind: 'none', reason: 'no-drift' })
  })

  it('yields to the correction path when the BOOT rows are themselves wrong', () => {
    // One event must page once: a boot drift is the other detector's case,
    // and alerting here too would keep paging after its flap cap stopped it.
    expect(decideMidSessionDriftAction({ ...base(), bootMeasured: SONNET5 }))
      .toEqual({ kind: 'none', reason: 'boot-drift' })
  })

  it('treats an UNMEASURABLE boot sample as no obstacle', () => {
    // A long-lived session's boot boundary ages out of the scanned tail; the
    // latest-model signal is exactly what still works there.
    expect(decideMidSessionDriftAction({ ...base(), bootMeasured: null }))
      .toEqual({ kind: 'alert', measured: OPUS48 })
  })

  it('stays quiet during an intentional downgrade', () => {
    expect(decideMidSessionDriftAction({ ...base(), hasActiveDowngrade: true }))
      .toEqual({ kind: 'none', reason: 'intentional-downgrade' })
  })

  it('stays quiet while a limit signal is on the pane', () => {
    expect(decideMidSessionDriftAction({ ...base(), limitSignal: true }))
      .toEqual({ kind: 'none', reason: 'limit-signal' })
  })

  it('waits for the streak to sustain', () => {
    expect(decideMidSessionDriftAction({
      ...base(), streak: { model: OPUS48, sweeps: MIN_MIDSESSION_DRIFT_SWEEPS - 1 },
    })).toEqual({ kind: 'none', reason: 'not-sustained' })
  })

  it('pages once per episode', () => {
    expect(decideMidSessionDriftAction({ ...base(), alreadyAlerted: true }))
      .toEqual({ kind: 'none', reason: 'already-alerted' })
  })

  it('compares boot and configured models normalized', () => {
    // A 1m-rung config against a bare API id must not read as a boot drift.
    expect(decideMidSessionDriftAction({
      ...base(), bootMeasured: 'claude-fable-5[1m]',
    })).toEqual({ kind: 'alert', measured: OPUS48 })
  })
})
