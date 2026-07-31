import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from './config.js'
import { atomicWriteFileSync } from './web/atomic-write.js'

// Fleet-wide alert routing policy: auto-remediation first, the coordinator
// second, the owner last.
//
// Gabor's 2026-07-31 order (card 8bcbd8fe): "Marveen must have a flowless
// operation with silent error and fallout fixing authomatisation" -- log and
// aggregate what the fleet repairs by itself, and page him ONLY when the
// automation is stuck or a human decision is needed. The independent audit
// that followed (projects/_audit/2026-07-31-alerting-system-audit.md) found 26
// of 40 autonomous emitters violating that policy, and three alerts in six
// minutes that day of which zero needed a human: two were measurement bugs and
// the third was about an item the coordinator's own watchdog was already
// tracking.
//
// This module owns the ONE routing decision, the ONE persistent dedup and the
// ONE owner-facing rate ceiling those paths share (audit AC-2, AC-4, AC-8).
// Transports stay with the callers -- the dashboard sends via createAgentMessage
// / sendAlert, the host scripts via /api/messages or notify.sh -- so this module
// keeps no db, tmux or network dependency.

/**
 * Where a finding goes.
 *
 *   log-only       -- a repeat inside its dedup window. Logged by the caller,
 *                     nothing else. NEVER the answer for a NEW finding:
 *                     decideAlertRoute cannot return it, because silently
 *                     dropping a first sighting is how a control stops being
 *                     one. It is the caller's route when shouldEmit() is false.
 *   digest         -- collected into the daily summary. The default for
 *                     anything the fleet handled or is still handling itself.
 *   coordinator    -- one inter-agent message to the main agent NOW. Routine
 *                     triage is his job, not the owner's (audit AC-2).
 *   user-telegram  -- the owner's phone. Reserved for "the automation is stuck"
 *                     and "a human has to decide".
 */
export type AlertRoute = 'log-only' | 'digest' | 'coordinator' | 'user-telegram'

export interface AlertFacts {
  /** A human decision is REQUIRED (no automation can resolve it). */
  needsHuman: boolean
  /** The coordinator can triage and resolve this class of finding. */
  coordinatorTracked: boolean
  /** Auto-remediation ran for this finding (not merely available). */
  remediationAttempted: boolean
  /** ... and the finding is gone because of it. */
  remediationSucceeded: boolean
  /**
   * The caller's escalation ceiling has been passed WITH the automation still
   * not recovering -- for the pending-age watchdog: the coordinator was flagged
   * and neither remediated nor escalated within the grace window (audit AC-5).
   * The policy decides what such a state is worth; the caller owns the evidence.
   */
  escalationCeilingHit: boolean
  /**
   * ANOTHER emitter holds a live claim on this exact item (audit AC-4). No path
   * may page the owner about an item the coordinator's own watchdog is already
   * tracking -- it may only append. Overrides everything except needsHuman,
   * which is by definition not something a claim can absorb.
   */
  claimedByOther?: boolean
}

/**
 * The routing decision, in priority order:
 *
 *   1. Auto-remediation already fixed it -> 'digest'. History; the owner never
 *      needs it in real time, but it stays visible in the morning summary so
 *      "silent fixing" does not become "silent hiding".
 *   2. A human decision is required -> 'user-telegram', regardless of anything
 *      else. The one case neither a claim nor a quiet window may swallow.
 *   3. Another emitter already claims the item -> 'digest' (audit AC-4). This is
 *      what made today's episode produce three messages about one fact.
 *   4. Escalation ceiling hit AND remediation was tried AND it did not work ->
 *      'user-telegram'. The three together are the definition of "the
 *      automation is stuck"; any two are not (a ceiling with no remediation
 *      attempt is just a slow first sighting, and a ceiling with a SUCCESSFUL
 *      remediation was caught by rule 1).
 *   5. The coordinator can handle it -> 'coordinator'.
 *   6. Otherwise -> 'digest' (never a silent drop).
 */
export function decideAlertRoute(f: AlertFacts): AlertRoute {
  if (f.remediationSucceeded) return 'digest'
  if (f.needsHuman) return 'user-telegram'
  if (f.claimedByOther) return 'digest'
  if (f.escalationCeilingHit && f.remediationAttempted && !f.remediationSucceeded) return 'user-telegram'
  if (f.coordinatorTracked) return 'coordinator'
  return 'digest'
}

// ---- persistent alert state --------------------------------------------------
//
// ONE file for the whole policy: per-emitter dedup stamps, the owner-facing
// send ledger behind the rate ceiling, and the rolling digest buffer. The
// dashboard watchdog's dedup used to be a single in-memory variable, so every
// restart (and every deploy is one) re-armed alerts the owner had already read;
// each host timer had its own state file with its own key format. A shared file
// also lets a host script see what the dashboard already emitted.

export const ALERT_STATE_PATH = join(STORE_DIR, 'alert-state.json')

// Emit stamps older than this are pruned on write. Bounds the file for keys
// that never repeat (a stuck-set key contains message ids, so it is unique per
// episode); far longer than any dedup window in use.
const DEDUP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export interface AlertState {
  /** `<kind>:<key>` -> epoch ms of the last emission. */
  emits: Record<string, number>
  /** Epoch ms of every owner-facing send inside the rate-ceiling window. */
  ownerSends: number[]
  /** Epoch ms of every FATAL-class owner send; separate ledger, own ceiling. */
  fatalSends: number[]
  /** Epoch ms of the last rate-breaker notice (at most one per hour window). */
  lastBreakerAt: number | null
  /** Rolling 24h digest buffer (audit AC-7). */
  digest: DigestEntry[]
  /** Entries dropped once the digest buffer hit its cap; counted, not silent. */
  digestDropped: number
}

export const EMPTY_ALERT_STATE: AlertState = {
  emits: {}, ownerSends: [], fatalSends: [], lastBreakerAt: null, digest: [], digestDropped: 0,
}

function entryKey(kind: string, key: string): string {
  return `${kind}:${key}`
}

/** Read the store. A missing/corrupt file reads as empty -- fail-LOUD: with no
 * memory of a previous emission the next finding alerts, which is the safe
 * direction for a control. */
export function loadAlertState(path: string = ALERT_STATE_PATH): AlertState {
  try {
    if (!existsSync(path)) return { ...EMPTY_ALERT_STATE, emits: {}, ownerSends: [], fatalSends: [], digest: [] }
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<AlertState>
    const emits: Record<string, number> = {}
    for (const [k, v] of Object.entries(raw?.emits ?? {})) {
      if (typeof v === 'number' && Number.isFinite(v)) emits[k] = v
    }
    const ownerSends = Array.isArray(raw?.ownerSends)
      ? raw.ownerSends.filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
      : []
    const fatalSends = Array.isArray(raw?.fatalSends)
      ? raw.fatalSends.filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
      : []
    const digest = Array.isArray(raw?.digest)
      ? raw.digest.filter((e): e is DigestEntry => !!e && typeof e.ts === 'number' && typeof e.summary === 'string')
      : []
    const breaker = raw?.lastBreakerAt
    return {
      emits,
      ownerSends,
      fatalSends,
      lastBreakerAt: typeof breaker === 'number' && Number.isFinite(breaker) ? breaker : null,
      digest,
      digestDropped: typeof raw?.digestDropped === 'number' ? raw.digestDropped : 0,
    }
  } catch {
    return { ...EMPTY_ALERT_STATE, emits: {}, ownerSends: [], fatalSends: [], digest: [] }
  }
}

export function saveAlertState(state: AlertState, path: string = ALERT_STATE_PATH): void {
  atomicWriteFileSync(path, JSON.stringify(state, null, 2))
}

/**
 * Pure decision: may this finding be emitted now? True on a first sighting and
 * once `dedupMs` has elapsed since the last emission of the SAME key. A
 * future-dated stamp (clock skew / NTP correction) counts as "emit now" rather
 * than stalling the delta negative, mirroring the router's decide* guards.
 *
 * The KEY carries the re-arm semantics, so pick it to identify the EPISODE:
 * the stuck message ids for a starving queue, the missed ritual names for a
 * ritual gap. A new id joining the set changes the key and emits immediately --
 * a worsening backlog must never be silenced by an earlier alert.
 */
export function shouldEmit(
  state: AlertState,
  kind: string,
  key: string,
  nowMs: number,
  dedupMs: number,
): boolean {
  const last = state.emits[entryKey(kind, key)]
  if (last === undefined) return true
  if (nowMs < last) return true
  return nowMs - last >= dedupMs
}

/** Record an emission (and prune stale stamps). Returns a NEW state. */
export function markEmitted(state: AlertState, kind: string, key: string, nowMs: number): AlertState {
  const emits: Record<string, number> = {}
  for (const [k, ts] of Object.entries(state.emits)) {
    if (nowMs - ts < DEDUP_RETENTION_MS) emits[k] = ts
  }
  emits[entryKey(kind, key)] = nowMs
  return { ...state, emits }
}

/**
 * load -> decide -> (on true) mark + save, in one call. For callers with no
 * other reason to hold the state; the pure pair above is there for callers that
 * make several decisions off ONE read (and for tests).
 */
export function claimEmit(
  kind: string,
  key: string,
  nowMs: number,
  dedupMs: number,
  path: string = ALERT_STATE_PATH,
): boolean {
  const state = loadAlertState(path)
  if (!shouldEmit(state, kind, key, nowMs, dedupMs)) return false
  saveAlertState(markEmitted(state, kind, key, nowMs), path)
  return true
}

// ---- owner-facing rate ceiling (audit AC-8) ----------------------------------
//
// A hard cap on how much of the owner's attention the fleet may spend, ACROSS
// emitters. Without it every routing fix is one bad detector away from being
// undone: today three emitters produced three messages about one fact, and the
// owner's response was to discount the class ("This is non-sense"), which is the
// failure mode every one of these detectors exists to prevent.
//
// The breach is never silent: the overflow lands in the digest and ONE breaker
// notice goes out per window, because a ceiling that hides its own operation
// converts a spam problem into a silence problem (audit section 8).

export const OWNER_SENDS_PER_HOUR = 3
export const OWNER_SENDS_PER_DAY = 10
export const OWNER_HOUR_MS = 60 * 60 * 1000
export const OWNER_DAY_MS = 24 * 60 * 60 * 1000

// FATAL class (wolfe decision, 2026-07-31, card 8bcbd8fe follow-up to the
// audit's section-8 silence warning): alerts whose suppression converts a spam
// problem into a silence problem -- coordinator-dead escalations, channel
// FATAL -- are EXEMPT from the global ceiling but get their own, higher one.
// Never unlimited: a broken fatal-class emitter looping at full rate is still
// bounded, and every suppression it does hit lands in the digest like any
// other, so the muting itself stays measurable.
export const FATAL_SENDS_PER_HOUR = 6
export const FATAL_SENDS_PER_DAY = 20

export type CeilingVerdict = 'allow' | 'hour-ceiling' | 'day-ceiling'

/**
 * Pure decision: may one more owner-facing alert go out now? Counts the sends
 * inside each rolling window; strictly-less-than, so the Nth send is allowed and
 * the N+1th is not.
 *
 * A stamp dated in the FUTURE beyond the window is ignored, not counted. It is
 * not a real send -- it is a clock jump (or a corrupt file), and counting it
 * would gag the owner FOREVER, since a future stamp never leaves a
 * `ts > now - window` filter. A ceiling that can silence itself permanently is
 * the silence failure the audit's section 8 warns about, and it is strictly
 * worse than the spam it replaces.
 */
export function decideOwnerSendAllowance(
  ownerSends: number[],
  nowMs: number,
  perHour = OWNER_SENDS_PER_HOUR,
  perDay = OWNER_SENDS_PER_DAY,
): CeilingVerdict {
  const inWindow = (ts: number, windowMs: number): boolean => ts > nowMs - windowMs && ts <= nowMs + windowMs
  const inHour = ownerSends.filter((ts) => inWindow(ts, OWNER_HOUR_MS)).length
  const inDay = ownerSends.filter((ts) => inWindow(ts, OWNER_DAY_MS)).length
  if (inHour >= perHour) return 'hour-ceiling'
  if (inDay >= perDay) return 'day-ceiling'
  return 'allow'
}

/** Record an owner-facing send in the given ledger ('owner' or 'fatal' -- the
 * two ceilings must not consume each other's budget), dropping stamps outside
 * the day window in EITHER direction (see decideOwnerSendAllowance on
 * future-dated stamps). */
export function recordOwnerSend(state: AlertState, nowMs: number, ledger: 'owner' | 'fatal' = 'owner'): AlertState {
  const prune = (arr: number[]): number[] => arr.filter((ts) => ts > nowMs - OWNER_DAY_MS && ts <= nowMs + OWNER_DAY_MS)
  if (ledger === 'fatal') return { ...state, fatalSends: [...prune(state.fatalSends), nowMs] }
  return { ...state, ownerSends: [...prune(state.ownerSends), nowMs] }
}

/**
 * Pure decision: is a breaker notice due? At most one per hour window, so a
 * storm produces exactly one "further alerts are muted" line rather than one
 * per suppressed alert.
 */
export function shouldSendBreakerNotice(lastBreakerAt: number | null, nowMs: number): boolean {
  if (lastBreakerAt === null) return true
  if (nowMs < lastBreakerAt) return true
  return nowMs - lastBreakerAt >= OWNER_HOUR_MS
}

/** The one visible line that says the ceiling is engaged. */
export function buildBreakerNotice(verdict: CeilingVerdict, mutedCount: number, fatal = false): string {
  const perDay = fatal ? FATAL_SENDS_PER_DAY : OWNER_SENDS_PER_DAY
  const perHour = fatal ? FATAL_SENDS_PER_HOUR : OWNER_SENDS_PER_HOUR
  const cls = fatal ? 'FATAL-osztaly, ' : ''
  const which = verdict === 'day-ceiling'
    ? `${cls}napi plafon: ${perDay}`
    : `${cls}orankenti plafon: ${perHour}`
  return `🔇 ${mutedCount} tovabbi riasztas elnemitva (${which}). A tetelek a napi osszesitobe kerulnek, nem vesznek el.`
}

// ---- rolling digest (audit AC-7) ---------------------------------------------
//
// The aggregation half of the card, in the shape the audit specified: four
// counted classes, delivered INSIDE the morning briefing rather than as a
// separate message, capped, and absent entirely on a zero-finding day. It
// generalises the quiet-hours buffer next door in channel-monitor
// (bufferQuietAlert/buildQuietAlertSummary): same discipline -- a one-off event
// is BUFFERED rather than dropped, kept oldest-first past the cap, overflow
// counted -- but on a 24h window and persisted, so a dashboard restart does not
// erase the night.

/** auto-fixed = the fleet repaired it; coordinator = mr-wolfe was handed it;
 * open = still unresolved (the only class that may also alert separately);
 * muted = suppressed as a duplicate or by the rate ceiling. */
export type DigestCategory = 'auto-fixed' | 'coordinator' | 'open' | 'muted'

export interface DigestEntry {
  /** Epoch ms. */
  ts: number
  category: DigestCategory
  /** Which control produced it (queue-starving, inbox-starvation, ...). */
  source: string
  /** One line, already human-readable. */
  summary: string
}

export const DIGEST_WINDOW_MS = 24 * 60 * 60 * 1000
/** Individual lines in one digest section (audit AC-7); the rest are counted. */
export const DIGEST_MAX_LINES = 15
/** Hard cap on buffered entries, so a stuck loop cannot grow the file all night.
 * Oldest are kept (they carry the root cause), overflow is counted. */
export const DIGEST_BUFFER_MAX = 200

/** Append one entry to the rolling buffer, dropping anything past the window. */
export function bufferDigestEntry(state: AlertState, entry: DigestEntry): AlertState {
  const kept = state.digest.filter((e) => entry.ts - e.ts < DIGEST_WINDOW_MS)
  if (kept.length >= DIGEST_BUFFER_MAX) {
    return { ...state, digest: kept, digestDropped: state.digestDropped + 1 }
  }
  return { ...state, digest: [...kept, entry], digestDropped: state.digestDropped }
}

export interface DigestCounts {
  autoFixed: number
  coordinator: number
  open: number
  muted: number
}

export function countDigest(entries: DigestEntry[]): DigestCounts {
  const c: DigestCounts = { autoFixed: 0, coordinator: 0, open: 0, muted: 0 }
  for (const e of entries) {
    if (e.category === 'auto-fixed') c.autoFixed++
    else if (e.category === 'coordinator') c.coordinator++
    else if (e.category === 'open') c.open++
    else c.muted++
  }
  return c
}

/**
 * Render the morning-briefing section, or null when there is nothing to report.
 * A zero-finding day produces NO section at all (audit AC-7) -- an empty report
 * is still an interruption, and the fleet being quiet is the expected state.
 *
 * Counts first (the shape of the day at a glance), then the individual lines
 * capped at `max` with the overflow counted. ASCII-only Hungarian, matching
 * every other machine-emitted alert string in this codebase.
 */
export function buildDigestSection(
  entries: DigestEntry[],
  dropped = 0,
  max = DIGEST_MAX_LINES,
): string | null {
  if (entries.length === 0) return null
  const c = countDigest(entries)
  // Open items first: they are the only class that may still need a decision.
  const ordered = [...entries].sort((a, b) => {
    const rank = (e: DigestEntry): number => (e.category === 'open' ? 0 : 1)
    return rank(a) - rank(b) || a.ts - b.ts
  })
  const shown = ordered.slice(0, max)
  const lines = shown.map((e) => {
    const hhmm = new Date(e.ts).toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Budapest' })
    return `  • ${hhmm} [${e.source}] ${e.summary}`
  })
  if (ordered.length > shown.length) lines.push(`  • (+${ordered.length - shown.length} tovabbi tetel)`)
  if (dropped > 0) lines.push(`  • (+${dropped} tetel nem fert a pufferbe)`)
  return [
    'Ejszaka / elmult 24 ora (automatikus riasztas-osszesito):',
    `  Automatikusan javitva: ${c.autoFixed}`,
    `  Koordinator kezelte:   ${c.coordinator}`,
    `  Nyitva maradt:         ${c.open}`,
    `  Elnemitva (duplikatum vagy plafon): ${c.muted}`,
    ...lines,
  ].join('\n')
}

/**
 * The digest section for the morning briefing. `consume` clears the buffer, so
 * the same finding is never reported twice; the caller (the briefing endpoint)
 * passes it only when it will actually deliver the text.
 */
export function renderDigest(
  nowMs: number,
  opts: { consume?: boolean; path?: string } = {},
): { section: string | null; counts: DigestCounts } {
  const path = opts.path ?? ALERT_STATE_PATH
  const state = loadAlertState(path)
  const fresh = state.digest.filter((e) => nowMs - e.ts < DIGEST_WINDOW_MS)
  const section = buildDigestSection(fresh, state.digestDropped)
  if (opts.consume) {
    saveAlertState({ ...state, digest: [], digestDropped: 0 }, path)
  }
  return { section, counts: countDigest(fresh) }
}
