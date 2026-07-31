import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScheduledTask } from '../web/scheduled-tasks-io.js'

// End-to-end test of the host-suspend catch-up, driving the REAL runCheck loop.
//
// The 2026-07-31 incident is reproduced literally: the runner ticks normally at
// 06:00, the host then sleeps for three hours while the process stays alive
// (fake timers let the wall clock jump WITHOUT firing the 185 skipped
// intervals -- exactly what a suspend does), and the next tick has to notice.
//
// What this pins that a pure-function test cannot:
//   * a daily 08:00 slot swallowed by the sleep really does fire on resume,
//     and is recorded 'fired_late' rather than as a normal run;
//   * a */5 heartbeat with 37 swallowed slots fires ONCE, not 37 times;
//   * an evening slot from before the quiet band is NOT resurrected;
//   * the following normal tick does not replay anything;
//   * a resume INSIDE the quiet band fires nothing at all.

const mockAppendTaskRun = vi.fn()
const mockInsertPendingRetry = vi.fn()
const mockListPendingRetries = vi.fn(() => [] as unknown[])
const mockSendPrompt = vi.fn(() => 'landed')
const mockIsSessionReady = vi.fn(() => true)
const mockLoggerInfo = vi.fn()
const mockListScheduledTasks = vi.fn(() => [] as ScheduledTask[])

vi.mock('../logger.js', () => ({
  logger: { info: mockLoggerInfo, warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

// The runner persists its last-run map to store/schedule-last-run.json on every
// fire. Stub the writer so the suite never touches the operator's real store.
vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: vi.fn(),
}))

vi.mock('../db.js', () => ({
  appendTaskRun: (...a: unknown[]) => mockAppendTaskRun(...a),
  listPendingTaskRetries: () => mockListPendingRetries(),
  deletePendingTaskRetry: vi.fn(),
  updatePendingTaskRetry: vi.fn(() => true),
  insertPendingTaskRetryIfNew: (...a: unknown[]) => mockInsertPendingRetry(...a),
  markPendingTaskRetryAlert: vi.fn(() => false),
  clearPendingTaskRetryAlert: vi.fn(),
}))

vi.mock('../web/scheduled-tasks-io.js', () => ({
  listScheduledTasks: () => mockListScheduledTasks(),
  SCHEDULED_TASKS_DIR: '/tmp/marveen-gap-catchup-no-tasks-dir',
}))

vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (name: string) => `agent-${name}`,
  isAgentRunning: () => true,
  isSessionReadyForPrompt: () => mockIsSessionReady(),
  sendPromptToSession: (...a: unknown[]) => mockSendPrompt(...(a as [])),
  startAgentProcess: vi.fn(() => ({ ok: true })),
  sessionExistsOnHost: () => true,
  // null capture => the post-send resubmit loop sees nothing parked and stops.
  capturePane: () => null,
  sendEnterToSession: vi.fn(),
  clearStaleParkedInput: vi.fn(() => false),
}))

const TZ = 'Europe/Budapest'

// A task whose name cannot collide with anything in the operator's real
// store/schedule-last-run.json (which the runner reloads on start).
function task(overrides: Partial<ScheduledTask> & { name: string; schedule: string }): ScheduledTask {
  return {
    description: 'gap catch-up fixture',
    prompt: 'Do the thing.',
    agent: 'gapagent',
    enabled: true,
    createdAt: 0,
    type: 'heartbeat',
    // Pins the target session so the fire path needs no agent-config lookup.
    targetSession: 'gap-test-session',
    ...overrides,
  }
}

const DAILY_0800 = task({ name: 'catchup-e2e-daily-0800', schedule: '0 8 * * *' })
const HB_5MIN = task({ name: 'catchup-e2e-hb-5min', schedule: '*/5 6-21 * * *' })
const EVENING_2015 = task({ name: 'catchup-e2e-evening-2015', schedule: '15 20 * * *' })

// 06:00:00 local (CEST) -- the last healthy tick before the host slept.
const BEFORE_SLEEP = new Date('2026-07-31T04:00:00.000Z')
// 09:06:10 local; the pending interval then fires 55s later, at 09:07:05.
const AFTER_SLEEP = new Date('2026-07-31T07:06:10.000Z')
// 02:00:10 local -- a resume in the middle of the quiet band.
const AFTER_SLEEP_QUIET = new Date('2026-07-31T00:00:10.000Z')

async function loadRunner() {
  vi.resetModules()
  return await import('../web/schedule-runner.js')
}

function runsFor(name: string): string[] {
  return mockAppendTaskRun.mock.calls.filter(c => c[0] === name).map(c => String(c[2]))
}

describe('schedule runner: host-suspend catch-up', () => {
  let stop: NodeJS.Timeout | null = null

  beforeEach(() => {
    vi.stubEnv('SCHEDULER_TZ', TZ)
    vi.clearAllMocks()
    mockIsSessionReady.mockReturnValue(true)
    mockListPendingRetries.mockReturnValue([])
    vi.useFakeTimers()
  })

  afterEach(() => {
    if (stop) clearInterval(stop)
    stop = null
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('fires the slots the sleep swallowed -- once each -- and marks them late', async () => {
    mockListScheduledTasks.mockReturnValue([DAILY_0800, HB_5MIN, EVENING_2015])
    vi.setSystemTime(BEFORE_SLEEP)
    const { startScheduleRunner } = await loadRunner()
    stop = startScheduleRunner()

    // First tick, 06:00:05 local. Only the */5 heartbeat is due here.
    vi.advanceTimersByTime(5000)
    expect(runsFor(DAILY_0800.name)).toEqual([])
    mockAppendTaskRun.mockClear()
    mockSendPrompt.mockClear()
    mockLoggerInfo.mockClear()

    // The host sleeps. Wall clock jumps ~3h; NO interval fires meanwhile.
    vi.setSystemTime(AFTER_SLEEP)
    vi.advanceTimersByTime(60_000)

    // The 08:00 daily slot was inside the sleep -> caught up, flagged late.
    expect(runsFor(DAILY_0800.name)).toEqual(['fired_late'])
    // 37 heartbeat slots were inside the sleep -> exactly ONE fire.
    expect(runsFor(HB_5MIN.name)).toEqual(['fired_late'])
    // The 20:15 slot predates the quiet band -> stays missed.
    expect(runsFor(EVENING_2015.name)).toEqual([])
    expect(mockSendPrompt).toHaveBeenCalledTimes(2)

    // The gap is auditable: without this line a suspend leaves no trace at all.
    const summary = mockLoggerInfo.mock.calls.find(c =>
      String(c[1]).includes('Schedule tick gap detected (host suspend?)'),
    )
    expect(summary).toBeDefined()
    expect(summary?.[0]).toMatchObject({ gapMinutes: 187, catchUpFires: 2 })

    // The NEXT normal tick must not replay anything.
    mockSendPrompt.mockClear()
    mockAppendTaskRun.mockClear()
    vi.advanceTimersByTime(60_000)
    expect(mockSendPrompt).not.toHaveBeenCalled()
    expect(mockAppendTaskRun).not.toHaveBeenCalled()
  })

  it('waking inside the quiet band fires nothing and says so', async () => {
    mockListScheduledTasks.mockReturnValue([DAILY_0800, HB_5MIN, EVENING_2015])
    // Last healthy tick at 21:00 local the previous evening.
    vi.setSystemTime(new Date('2026-07-30T19:00:00.000Z'))
    const { startScheduleRunner } = await loadRunner()
    stop = startScheduleRunner()
    vi.advanceTimersByTime(5000)
    mockAppendTaskRun.mockClear()
    mockSendPrompt.mockClear()
    mockLoggerInfo.mockClear()

    vi.setSystemTime(AFTER_SLEEP_QUIET)
    vi.advanceTimersByTime(60_000)

    // 20:15 fell inside the gap, but the resume is at 02:00 -- night slots
    // stay missed rather than landing in a sleeping operator's chat.
    expect(mockSendPrompt).not.toHaveBeenCalled()
    expect(mockAppendTaskRun).not.toHaveBeenCalled()
    const quiet = mockLoggerInfo.mock.calls.find(c =>
      String(c[1]).includes('inside the quiet band'),
    )
    expect(quiet).toBeDefined()
  })

  it('an ordinary tick sequence logs no gap and fires on its own cadence', async () => {
    mockListScheduledTasks.mockReturnValue([HB_5MIN])
    // 09:00:15 local -> first tick 09:00:20, next ticks 09:01:20, 09:02:20...
    // Deliberately mid-minute: cron-parser's prev() is exclusive, so a tick
    // landing exactly ON a slot boundary reads the PREVIOUS slot and would be
    // classed late by the (pre-existing) first-run window.
    vi.setSystemTime(new Date('2026-07-31T07:00:15.000Z'))
    const { startScheduleRunner } = await loadRunner()
    stop = startScheduleRunner()
    vi.advanceTimersByTime(5000)
    expect(runsFor(HB_5MIN.name)).toEqual(['fired']) // 09:00:00 slot, on time
    expect(mockSendPrompt).toHaveBeenCalledTimes(1)

    mockSendPrompt.mockClear()
    for (let i = 0; i < 4; i++) vi.advanceTimersByTime(60_000) // 09:01..09:04
    expect(mockSendPrompt).not.toHaveBeenCalled()
    vi.advanceTimersByTime(60_000) // 09:05
    expect(mockSendPrompt).toHaveBeenCalledTimes(1)
    // Nothing was late, so no 'fired_late' rows and no gap log.
    expect(runsFor(HB_5MIN.name)).toEqual(['fired', 'fired'])
    expect(
      mockLoggerInfo.mock.calls.some(c => String(c[1]).includes('Schedule tick gap')),
    ).toBe(false)
  })
})
