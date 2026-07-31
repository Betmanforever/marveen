import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { detectPaneState, paneShowsContextSaturation } from '../pane-state.js'
import type { ScheduledTask } from '../web/scheduled-tasks-io.js'

// Where a scheduled task goes when the context-saturation gate refuses it.
//
// 2026-07-31 09:06-09:12, mr-wolfe-channels sat at 100% context and the
// dispatcher logged "refusing prompt - session shows context saturation" once
// a minute. The question this file answers -- and pins -- is whether a
// SCHEDULED task refused that way disappears. It does not: the refusal happens
// inside isSessionReadyForPrompt(), so the runner reads it as a plain 'busy'
// and applies the normal semantics.
//
// The chain has three links, each verified by a different kind of evidence,
// because the middle one shells out to tmux and cannot be executed here:
//   1. the pane really is saturated            -> real predicate, executed;
//   2. a saturated pane makes the readiness
//      check return false                      -> source contract on agent-process.ts;
//   3. a not-ready session becomes 'busy' and
//      lands on queue+retry+alert              -> behavioural, real runCheck loop.

const AGENT_PROCESS_SRC = readFileSync(join(__dirname, '../web/agent-process.ts'), 'utf-8')
const RUNNER_SRC = readFileSync(join(__dirname, '../web/schedule-runner.ts'), 'utf-8')

const SEP = '─'.repeat(60)
// The live capture shape: a saturation banner above an otherwise idle,
// ready-looking footer -- which is exactly why the gate is needed.
const SATURATED_PANE = [
  '  some prior assistant output',
  '',
  '✻ Cooked for 3m 7s',
  '                                                              100% context used',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

describe('link 1: the refused pane is genuinely saturated (and looks idle)', () => {
  it('reads idle, yet trips the saturation predicate', () => {
    expect(detectPaneState(SATURATED_PANE)).toBe('idle')
    expect(paneShowsContextSaturation(SATURATED_PANE)).toBe(true)
  })
})

describe('link 2: the readiness check refuses a saturated pane', () => {
  it('isSessionReadyForPrompt returns false on saturation, on BOTH samples', () => {
    const start = AGENT_PROCESS_SRC.indexOf('export function isSessionReadyForPrompt(')
    expect(start).toBeGreaterThan(0)
    const body = AGENT_PROCESS_SRC.slice(start, AGENT_PROCESS_SRC.indexOf('\n}\n', start))
    // Double-sample readiness: the banner must be checked on each capture, or a
    // pane that renders it one frame late slips through.
    expect(body).toMatch(/if \(paneShowsContextSaturation\(first\)\) \{[\s\S]{0,240}?return false/)
    expect(body).toMatch(/if \(paneShowsContextSaturation\(second\)\) \{[\s\S]{0,240}?return false/)
  })

  it('the runner documents that saturation is already wired to the busy path', () => {
    // Prevents a well-meaning future change from adding a SECOND saturation
    // gate in the runner (which would double-handle the same condition).
    const idx = RUNNER_SRC.indexOf('CONTEXT SATURATION IS ALREADY WIRED HERE')
    expect(idx).toBeGreaterThan(0)
    const note = RUNNER_SRC.slice(idx, idx + 1600)
    expect(note).toMatch(/isSessionReadyForPrompt/)
    expect(note).toMatch(/pending_task_retries|queue/i)
    // The two known holes are named, not glossed over.
    expect(note).toMatch(/forceSend/)
    expect(note).toMatch(/skipIfBusy/)
  })
})

// --- link 3: behavioural, through the real cron loop -------------------------

const mockAppendTaskRun = vi.fn()
const mockInsertPendingRetry = vi.fn()
const mockSendPrompt = vi.fn(() => 'landed')
const mockIsSessionReady = vi.fn(() => true)
const mockListScheduledTasks = vi.fn(() => [] as ScheduledTask[])

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../web/atomic-write.js', () => ({ atomicWriteFileSync: vi.fn() }))

vi.mock('../db.js', () => ({
  appendTaskRun: (...a: unknown[]) => mockAppendTaskRun(...a),
  listPendingTaskRetries: () => [],
  deletePendingTaskRetry: vi.fn(),
  updatePendingTaskRetry: vi.fn(() => true),
  insertPendingTaskRetryIfNew: (...a: unknown[]) => mockInsertPendingRetry(...a),
  markPendingTaskRetryAlert: vi.fn(() => false),
  clearPendingTaskRetryAlert: vi.fn(),
}))

vi.mock('../web/scheduled-tasks-io.js', () => ({
  listScheduledTasks: () => mockListScheduledTasks(),
  SCHEDULED_TASKS_DIR: '/tmp/marveen-saturation-no-tasks-dir',
}))

vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (name: string) => `agent-${name}`,
  isAgentRunning: () => true,
  // Stands in for the tmux round-trip verified as link 2 above: a saturated
  // pane makes the real function return false.
  isSessionReadyForPrompt: () => mockIsSessionReady(),
  sendPromptToSession: (...a: unknown[]) => mockSendPrompt(...(a as [])),
  startAgentProcess: vi.fn(() => ({ ok: true })),
  sessionExistsOnHost: () => true,
  capturePane: () => null,
  sendEnterToSession: vi.fn(),
  clearStaleParkedInput: vi.fn(() => false),
}))

function task(overrides: Partial<ScheduledTask> & { name: string }): ScheduledTask {
  return {
    description: 'saturation fixture',
    prompt: 'Do the thing.',
    // '*/1' so the task is due on every tick, whatever minute the fixture clock
    // starts on.
    schedule: '* * * * *',
    agent: 'satagent',
    enabled: true,
    createdAt: 0,
    type: 'heartbeat',
    targetSession: 'sat-test-session',
    ...overrides,
  }
}

const DAILY_LIKE = task({ name: 'saturation-e2e-queued', skipIfBusy: false })
const SHORT_CADENCE = task({ name: 'saturation-e2e-skipped', skipIfBusy: true })

describe('link 3: a saturation-refused scheduled task is never silently dropped', () => {
  let stop: NodeJS.Timeout | null = null

  beforeEach(() => {
    vi.stubEnv('SCHEDULER_TZ', 'Europe/Budapest')
    vi.clearAllMocks()
    // The session is up and idle-looking, but saturated -> refused.
    mockIsSessionReady.mockReturnValue(false)
    vi.useFakeTimers()
    // 14:30:10 local: a plain working-hours tick, no quiet band, no gap.
    vi.setSystemTime(new Date('2026-07-31T12:30:10.000Z'))
  })

  afterEach(() => {
    if (stop) clearInterval(stop)
    stop = null
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  async function tickOnce(tasks: ScheduledTask[]) {
    mockListScheduledTasks.mockReturnValue(tasks)
    vi.resetModules()
    const { startScheduleRunner } = await import('../web/schedule-runner.js')
    stop = startScheduleRunner()
    vi.advanceTimersByTime(5000)
  }

  it('a skipIfBusy=false task is queued for retry and run-logged', async () => {
    await tickOnce([DAILY_LIKE])
    expect(mockSendPrompt).not.toHaveBeenCalled()
    // Queued on the never-abandon path, which is also what raises the
    // "N perce varakozik" alert once it ages past the threshold.
    expect(mockInsertPendingRetry).toHaveBeenCalledWith(
      DAILY_LIKE.name, 'satagent', expect.any(Number), 'busy',
    )
    // And visible as an explicit row, not an absent one.
    expect(mockAppendTaskRun).toHaveBeenCalledWith(DAILY_LIKE.name, 'satagent', 'queued-busy')
  })

  it('a skipIfBusy=true task drops the tick -- logged, but NOT queued', async () => {
    // KNOWN LIMITATION, pinned deliberately: skipIfBusy assumes "the next tick
    // is already on the way", which does not hold under saturation (it
    // persists until the session restarts). Escalating that is the
    // context-budget watchdog's job, not the scheduler's.
    await tickOnce([SHORT_CADENCE])
    expect(mockSendPrompt).not.toHaveBeenCalled()
    expect(mockInsertPendingRetry).not.toHaveBeenCalled()
    expect(mockAppendTaskRun).toHaveBeenCalledWith(SHORT_CADENCE.name, 'satagent', 'skipped')
  })

  it('an operator "Run now" against a saturated session queues instead of dropping', async () => {
    mockListScheduledTasks.mockReturnValue([SHORT_CADENCE])
    vi.resetModules()
    const { runScheduledTaskNow } = await import('../web/schedule-runner.js')
    const res = runScheduledTaskNow(SHORT_CADENCE.name)
    expect(res.ok).toBe(true)
    expect(res.result).toContain('busy')
    // Run-now ignores skipIfBusy on purpose: an explicit operator action must
    // land eventually, even against a saturated session.
    expect(mockInsertPendingRetry).toHaveBeenCalledWith(
      SHORT_CADENCE.name, 'satagent', expect.any(Number), 'busy',
    )
  })
})
