import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'

// The monitor's owner alerts under the fleet-wide quiet hours (22:00-06:00
// Europe/Budapest, Gabor's 2026-07-30 standing rule).
//
// sendAlert has ~25 call sites, so the window is enforced inside it. A monitor
// alert is a one-off EVENT (unlike the heartbeat filter's recomputed state), so
// overnight it must be BUFFERED, not dropped: the first non-quiet path -- a new
// alert, or the monitor tick -- sends one summary of the night and empties the
// buffer exactly once.

vi.mock('../notify.js', () => ({
  notifyChannel: vi.fn(async () => {}),
  notifyTelegram: vi.fn(async () => {}),
}))

// sendAlert also consults the persistent alert state for the owner-facing rate
// ceiling (audit AC-8). Stub ONLY its file I/O -- the decisions stay real --
// so these cases neither write the live store/alert-state.json (they run under
// fake timers, so their stamps would be nonsense) nor inherit a ceiling from a
// previous run. The ceiling's own behaviour is covered in alert-policy.test.ts
// and by the dedicated case at the bottom of this file.
let fakeAlertState = { emits: {}, ownerSends: [] as number[], lastBreakerAt: null as number | null, digest: [] as unknown[], digestDropped: 0 }
vi.mock('../alert-policy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../alert-policy.js')>()
  return {
    ...actual,
    loadAlertState: () => fakeAlertState,
    saveAlertState: (s: typeof fakeAlertState) => { fakeAlertState = s },
  }
})

const { notifyChannel } = await import('../notify.js')
const {
  sendAlert,
  flushQuietAlerts,
  bufferQuietAlert,
  buildQuietAlertSummary,
  EMPTY_QUIET_ALERT_BUFFER,
} = await import('../web/channel-monitor.js')

const sent = notifyChannel as unknown as ReturnType<typeof vi.fn>

// Nyari idoszamitas (CEST = UTC+2).
const at = (budapestHour: number, minute = 0): Date =>
  new Date(Date.UTC(2026, 6, 15, budapestHour - 2, minute))

vi.useFakeTimers({ toFake: ['Date'] })

beforeEach(() => {
  // Drain any buffer a previous test left behind, then start from zero calls.
  vi.setSystemTime(at(12))
  flushQuietAlerts()
  sent.mockClear()
  fakeAlertState = { emits: {}, ownerSends: [], lastBreakerAt: null, digest: [], digestDropped: 0 }
})

afterAll(() => {
  vi.useRealTimers()
})

describe('sendAlert -- csendes sav', () => {
  it('csendes oraban NEM kuld, gyujt', () => {
    vi.setSystemTime(at(3))
    sendAlert('⚠️ elso')
    vi.setSystemTime(at(4, 30))
    sendAlert('⛔ masodik')
    expect(sent).not.toHaveBeenCalled()
  })

  it('nem-csendes oraban azonnal kuld, es nem gyujt', () => {
    vi.setSystemTime(at(10))
    sendAlert('⚠️ nappali')
    expect(sent).toHaveBeenCalledTimes(1)
    expect(sent.mock.calls[0][0]).toBe('⚠️ nappali')
  })

  it('reggel az elso riasztas ELE megy az ejszakai osszegzo, egyszer', () => {
    vi.setSystemTime(at(23, 14))
    sendAlert('⚠️ ejjeli baj')
    vi.setSystemTime(at(7))
    sendAlert('⚠️ reggeli baj')

    expect(sent).toHaveBeenCalledTimes(2)
    const [summary, fresh] = sent.mock.calls.map((c) => c[0] as string)
    expect(summary).toContain('Ejszakai osszegzes')
    expect(summary).toContain('22:00-06:00')
    expect(summary).toContain('⚠️ ejjeli baj')
    expect(summary).toMatch(/23:14/)
    expect(fresh).toBe('⚠️ reggeli baj')

    // A puffer kiurult: a kovetkezo riasztas mar nem huzza magaval az osszegzot.
    sendAlert('⚠️ harmadik')
    expect(sent).toHaveBeenCalledTimes(3)
    expect(sent.mock.calls[2][0]).toBe('⚠️ harmadik')
  })
})

describe('flushQuietAlerts', () => {
  it('csendes savban no-op (a gyujto erintetlen marad)', () => {
    vi.setSystemTime(at(2))
    sendAlert('⚠️ hajnali')
    flushQuietAlerts()
    expect(sent).not.toHaveBeenCalled()

    // 06:00 utan ugyanaz a bejegyzes kimegy -> tenyleg megmaradt.
    vi.setSystemTime(at(6, 5))
    flushQuietAlerts()
    expect(sent).toHaveBeenCalledTimes(1)
    expect(sent.mock.calls[0][0]).toContain('⚠️ hajnali')
  })

  it('idempotens: a masodik hivas mar nem duplaz', () => {
    vi.setSystemTime(at(1))
    sendAlert('⚠️ egy')
    vi.setSystemTime(at(6, 5))
    flushQuietAlerts()
    flushQuietAlerts()
    expect(sent).toHaveBeenCalledTimes(1)
  })

  it('ures puffer eseten nem kuld semmit', () => {
    vi.setSystemTime(at(9))
    flushQuietAlerts()
    expect(sent).not.toHaveBeenCalled()
  })
})

describe('bufferQuietAlert / buildQuietAlertSummary (tiszta reszek)', () => {
  it('a plafonig gyujt, azon tul csak szamol', () => {
    let state = EMPTY_QUIET_ALERT_BUFFER
    for (let i = 0; i < 5; i++) {
      state = bufferQuietAlert(state, { ts: at(0, i).getTime(), text: `riasztas-${i}` }, 3)
    }
    expect(state.entries.map((e) => e.text)).toEqual(['riasztas-0', 'riasztas-1', 'riasztas-2'])
    expect(state.dropped).toBe(2)
    expect(EMPTY_QUIET_ALERT_BUFFER.entries).toHaveLength(0) // a helper nem mutal
  })

  it('az osszegzo idobelyeggel listaz es megnevezi az eldobasokat', () => {
    const state = {
      entries: [{ ts: at(23, 5).getTime(), text: '⚠️ elso' }, { ts: at(2, 40).getTime(), text: '⛔ masodik' }],
      dropped: 7,
    }
    const msg = buildQuietAlertSummary(state, 50)
    expect(msg).not.toBeNull()
    expect(msg).toContain('2 riasztas volt elnyomva')
    expect(msg).toMatch(/23:05 -- ⚠️ elso/)
    expect(msg).toMatch(/02:40 -- ⛔ masodik/)
    expect(msg).toContain('+7 tovabbi riasztas nem fert a pufferbe, plafon: 50')
  })

  it('ures gyujtore null (nincs mit kuldeni)', () => {
    expect(buildQuietAlertSummary(EMPTY_QUIET_ALERT_BUFFER)).toBeNull()
  })
})

describe('sendAlert -- owner-facing rate ceiling (audit AC-8)', () => {
  it('lets 3 through per hour, mutes the rest into the digest, and says so ONCE', () => {
    vi.setSystemTime(at(10))
    for (let i = 0; i < 20; i++) sendAlert(`⚠️ riasztas ${i}`)

    // 3 real alerts + exactly 1 breaker notice.
    expect(sent).toHaveBeenCalledTimes(4)
    const texts = sent.mock.calls.map((c) => c[0] as string)
    expect(texts.slice(0, 3)).toEqual(['⚠️ riasztas 0', '⚠️ riasztas 1', '⚠️ riasztas 2'])
    expect(texts[3]).toContain('elnemitva')

    // Nothing was lost: the other 17 are in the digest buffer.
    expect(fakeAlertState.digest).toHaveLength(17)
    expect(fakeAlertState.ownerSends).toHaveLength(3)
  })

  it('a quiet-hours alert never touches the ceiling (it is buffered, not sent)', () => {
    vi.setSystemTime(at(2))
    for (let i = 0; i < 20; i++) sendAlert(`⚠️ ejjeli ${i}`)
    expect(sent).not.toHaveBeenCalled()
    expect(fakeAlertState.ownerSends).toHaveLength(0)
    // The night still leaves exactly ONE morning summary, ceiling untouched.
    vi.setSystemTime(at(7))
    flushQuietAlerts()
    expect(sent).toHaveBeenCalledTimes(1)
  })
})
