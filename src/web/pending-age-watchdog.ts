import { logger } from '../logger.js'
import { sanitizeAgentIdent } from '../prompt-safety.js'
import { decideAlertRoute } from '../alert-policy.js'
import { decideDialogEscalation, isPaneStalled, updatePaneProgress, parkedInputText, paneShowsContextLow, paneShowsContextSaturation, type DialogEscalationState, type PaneProgressState } from '../pane-state.js'
import { isTargetInBootGrace } from './message-router.js'

// In-process pending-age watchdog: does the inter-agent queue have rows that
// are not merely SLOW but STUCK, and who should hear about it?
//
// Extracted from channel-monitor's tick so the whole decision path can be
// replayed in a test with injected senders (audit AC-11): the 2026-07-31
// 16:00-16:51 sequence must produce ZERO owner-facing messages, and a genuine
// wedge exactly one. Nothing here touches tmux, the db or the network -- every
// side effect arrives as a callback.
//
// The watchdog reads the pending queue DIRECTLY because the escalation path it
// backstops IS agent_messages (2026-07-12: four messages sat pending 10+ min in
// both directions with nothing alarming, because the alarm would have travelled
// through the starved queue). That is why the OWNER path here never depends on
// an inter-agent message being DELIVERED -- only on one having been SENT. If
// the queue is genuinely wedged, the coordinator flag rots in it, the grace
// expires unanswered, and the owner alert goes out over the independent
// Telegram transport exactly as before the rework.

/** A pending inter-agent message, as the watchdog needs it. */
export interface PendingRow {
  id: number
  from_agent: string
  to_agent: string
  /** Epoch SECONDS (the agent_messages column unit). */
  created_at: number
}

export interface TargetProbe {
  /** Captured pane text, or null when it could not be read. */
  pane: string | null
  /** Age of the session's pane-leader process (ms), null when unknown. */
  procAgeMs: number | null
}

export interface DigestAppend {
  category: 'auto-fixed' | 'coordinator' | 'open' | 'muted'
  source: string
  summary: string
}

export interface WatchdogDeps {
  nowMs: number
  pending: PendingRow[]
  /** Which session name a target agent's pane lives under (identity for the
   * progress tracker, so two agents never share a hash history). */
  sessionFor(agent: string): string
  probeTarget(agent: string): TargetProbe
  /** Live claim holder for this item, or null when unclaimed. */
  liveClaimBy(itemKey: string, nowSec: number): string | null
  /** Claim/renew the item for the coordinator, TTL in seconds. */
  claimForCoordinator(itemKey: string, nowSec: number, ttlSec: number): void
  releaseClaim(itemKey: string): void
  /** Enqueue an inter-agent message to the coordinator. Throwing is expected
   * when the queue is broken; the caller decides what that means. */
  sendCoordinator(text: string): void
  /** Owner-facing Telegram. Rate-ceilinged + quiet-hours-buffered by the
   * caller (channel-monitor.sendAlert). */
  sendOwner(text: string): void
  appendDigest(entry: DigestAppend): void
  /** Emit-dedup gate shared with the other emitters (alert-policy claimEmit). */
  claimEmit(kind: string, key: string, dedupMs: number): boolean
}

export interface WatchdogOutcome {
  /** Rows past the age threshold (before the stall filter). */
  overThreshold: number
  /** ... of which the target pane is stalled (the alert-worthy set). */
  stalled: number
  routes: Array<'coordinator' | 'user-telegram' | 'digest' | 'log-only'>
}

export const SIGNAL_ID = 'queue-starving'

// A pending row must out-wait this before the watchdog looks at its target at
// all. Unchanged from the pre-audit design: it is the cheap pre-filter, NOT the
// alert criterion (that is the stall predicate below).
export const PENDING_AGE_THRESHOLD_MS = 3 * 60 * 1000
// Consecutive unchanged pane captures required to call a target stalled. Two
// sweeps = three identical captures ~2 min apart on the 60s monitor tick
// (audit P3). The 15-minute hard ceiling that used to re-include healthy-busy
// targets is DELETED, not tuned: it fired on a legitimate 20-minute working turn
// on a fleet whose own scripts document 45-minute turns.
export const PANE_STALL_SWEEPS = 2
// Two captures further apart than this are not comparable: the watchdog only
// samples a session while one of its messages is stuck, so a gap means the
// session was idle-and-fine in between, not frozen.
export const PANE_PROGRESS_MAX_GAP_MS = 5 * 60 * 1000
// A target whose claude process started less than this ago is booting, not
// wedged (2026-07-22 14:59 false alarm): its pane can sit still while MCP
// servers spawn.
export const BOOT_GRACE_MS = 5 * 60 * 1000
// How long the coordinator has to resolve or escalate before the owner is told
// he went silent (audit AC-5). Also the claim TTL, so the claim expires at the
// exact moment escalation becomes due: 2x the 5-min pending-uzenet-watchdog
// cadence, the audit's own worked example.
export const COORDINATOR_GRACE_MS = 10 * 60 * 1000
// Re-flag the coordinator about a still-stuck episode at most this often.
export const COORDINATOR_REFLAG_MS = 30 * 60 * 1000

interface EpisodeState {
  escalation: DialogEscalationState
  /** Items claimed for the coordinator during this episode. */
  claimed: Set<string>
  /** True once the coordinator was flagged at least once this episode. */
  flagged: boolean
  startedAt: number
}

// Module state. In-process by design: it tracks a LIVE episode, and a dashboard
// restart ends the episode along with the process that observed it. What must
// survive a restart -- the dedup stamps and the claim rows -- lives in the
// alert-state file and the db (that was the 2026-07-31 spam's other half: an
// in-memory dedup re-armed on every deploy).
let episode: EpisodeState | null = null
const paneProgress: Map<string, PaneProgressState> = new Map()
// Log-only throttle: the pass runs every tick while a row is over threshold, so
// the "everything is merely busy" line would otherwise repeat once a minute.
let lastSuppressedKey: string | null = null

/** Test-only: forget the live episode + pane history so cases stay independent. */
export function __resetPendingAgeWatchdogForTest(): void {
  episode = null
  paneProgress.clear()
  lastSuppressedKey = null
}

function itemKeyFor(row: PendingRow): string {
  return `msg:${row.id}`
}

function minutes(ms: number): number {
  return Math.floor(ms / 60000)
}

/**
 * One watchdog pass. Returns what it decided, for the caller's log and for the
 * replay tests; every side effect went through `deps`.
 */
export function runPendingAgeWatchdog(deps: WatchdogDeps): WatchdogOutcome {
  const { nowMs, pending } = deps
  const nowSec = Math.floor(nowMs / 1000)
  const outcome: WatchdogOutcome = { overThreshold: 0, stalled: 0, routes: [] }

  const overThreshold = pending
    .map((m) => ({ m, ageMs: nowMs - m.created_at * 1000 }))
    .filter((x) => x.ageMs > PENDING_AGE_THRESHOLD_MS)
    .sort((a, b) => b.ageMs - a.ageMs)
  outcome.overThreshold = overThreshold.length

  if (overThreshold.length === 0) {
    closeEpisode(deps, 'a sor kiurult')
    lastSuppressedKey = null
    return outcome
  }

  // One probe per distinct target session per pass; the progress counter needs
  // exactly one sample per sweep or its "unchanged across N sweeps" arithmetic
  // is meaningless.
  const probed = new Map<string, { stalled: boolean; wedge: boolean; procAgeMs: number | null }>()
  const classify = (agent: string): { stalled: boolean; wedge: boolean; procAgeMs: number | null } => {
    const session = deps.sessionFor(agent)
    const cached = probed.get(session)
    if (cached) return cached
    const probe = deps.probeTarget(agent)
    const next = updatePaneProgress(paneProgress.get(session), probe.pane, nowMs, PANE_PROGRESS_MAX_GAP_MS)
    if (next) paneProgress.set(session, next)
    else paneProgress.delete(session)
    const out = {
      stalled: isPaneStalled(next, PANE_STALL_SWEEPS),
      // A positive wedge signal (parked input, context ceiling) is stuck
      // regardless of pixels moving: a saturated session keeps redrawing while
      // silently dropping work (2026-07-12).
      wedge: probe.pane != null
        && (parkedInputText(probe.pane) != null || paneShowsContextLow(probe.pane) || paneShowsContextSaturation(probe.pane)),
      procAgeMs: probe.procAgeMs,
    }
    probed.set(session, out)
    return out
  }

  const stuck = overThreshold.filter((x) => {
    const t = classify(x.m.to_agent)
    // Boot grace: a just-(re)started target legitimately holds its inbox while
    // claude boots. A wedge signal still overrides it.
    if (!t.wedge && isTargetInBootGrace(t.procAgeMs, BOOT_GRACE_MS)) return false
    return t.wedge || t.stalled
  })
  outcome.stalled = stuck.length

  if (stuck.length === 0) {
    // Every over-threshold row's target is MOVING: that is latency, not
    // starvation, at any age (audit P3). This is the 16:44 case.
    const key = overThreshold.map((x) => x.m.id).join(',')
    if (key !== lastSuppressedKey) {
      lastSuppressedKey = key
      logger.info(
        { pending: overThreshold.length, oldestMin: minutes(overThreshold[0].ageMs) },
        'Pending-age watchdog: targets are progressing (pane moving) -- no alert at any age',
      )
    }
    // An episode whose targets started moving again resolved itself.
    closeEpisode(deps, 'a cel-agens ujra halad')
    outcome.routes.push('log-only')
    return outcome
  }
  lastSuppressedKey = null

  const setKey = stuck.map((x) => x.m.id).sort((a, b) => a - b).join(',')
  const top = stuck.slice(0, 5)
  // from_agent is caller-supplied (POST /api/messages, token-gated but readable
  // by every sub-agent), and this line travels into a coordinator prompt and,
  // via the digest, into the morning-briefing prompt. Sanitize it to the same
  // charset the router classifies on, so a hostile sender name cannot smuggle
  // instructions. Ids are numbers, ages are computed -- nothing else is input.
  const list = top
    .map((x) => `#${x.m.id} ${sanitizeAgentIdent(x.m.from_agent)}->${sanitizeAgentIdent(x.m.to_agent)} (${minutes(x.ageMs)}p)`)
    .join(', ')
  const oldestMin = minutes(stuck[0].ageMs)

  // AC-4: is one of these items already owned by ANOTHER emitter? If so this
  // pass may append to the claim, never page the owner.
  const foreignClaim = stuck
    .map((x) => ({ key: itemKeyFor(x.m), by: deps.liveClaimBy(itemKeyFor(x.m), nowSec) }))
    .find((c) => c.by !== null && c.by !== 'coordinator')

  if (!episode) {
    episode = { escalation: { wolfeFlaggedAt: null, gaborNotifiedAt: null }, claimed: new Set(), flagged: false, startedAt: nowMs }
  }
  // Peek the escalation decision; it is only COMMITTED below, and only when a
  // foreign claim is not suppressing this pass. Committing it under suppression
  // would advance the machine without sending anything -- burning this episode's
  // single owner-fallback (gaborNotifiedAt) on a message nobody received, so
  // that once the foreign claim expired the item would stay silent forever.
  const esc = decideDialogEscalation(episode.escalation, nowMs, {
    graceMs: COORDINATOR_GRACE_MS,
    dedupMs: COORDINATOR_REFLAG_MS,
  })

  const route = decideAlertRoute({
    needsHuman: false,
    coordinatorTracked: true,
    // The router's own remediation (stale-claim expiry, coordinator/hook wake
    // nudges, parked-input janitor) has been running against these rows on
    // every 5s tick since they were created -- by the time a row is 3+ minutes
    // old with a stalled target, remediation has been attempted and failed.
    remediationAttempted: true,
    remediationSucceeded: false,
    escalationCeilingHit: esc.action === 'fallback-gabor',
    claimedByOther: foreignClaim !== undefined,
  })

  logger.error(
    { stuck: stuck.length, oldestMin, route, escalation: esc.action, claimedBy: foreignClaim?.by ?? null },
    'Inter-agent message queue starving -- pending rows past age threshold with a stalled target',
  )

  if (route === 'digest') {
    // Someone else owns it: record the second sighting and stay quiet. The
    // escalation state is deliberately NOT committed (see the peek above), so
    // when the foreign claim expires this episode still has its full ladder --
    // coordinator flag first, owner fallback after the grace.
    deps.appendDigest({
      category: 'muted',
      source: SIGNAL_ID,
      summary: `${stuck.length} beragadt uzenet (legregebbi ${oldestMin}p), mar kovetve: ${foreignClaim?.by}. Kulon riasztas elnyomva.`,
    })
    outcome.routes.push('digest')
    return outcome
  }
  episode.escalation = esc.next

  if (esc.action === 'notify-wolfe') {
    // Dedup on the SET of stuck ids: the same backlog re-flags at most once per
    // window, a NEW id joining changes the key and flags immediately (a
    // worsening backlog must never be silenced by an earlier flag).
    if (deps.claimEmit(SIGNAL_ID, setKey, COORDINATOR_REFLAG_MS)) {
      for (const x of stuck) {
        const key = itemKeyFor(x.m)
        deps.claimForCoordinator(key, nowSec, Math.floor(COORDINATOR_GRACE_MS / 1000))
        episode.claimed.add(key)
      }
      episode.flagged = true
      deps.sendCoordinator(buildQueueCoordinatorFlag(stuck.length, oldestMin, list))
      deps.appendDigest({
        category: 'coordinator',
        source: SIGNAL_ID,
        summary: `${stuck.length} uzenet akadt (legregebbi ${oldestMin}p), a koordinator megkapta: ${list}`,
      })
      outcome.routes.push('coordinator')
    } else {
      outcome.routes.push('log-only')
    }
    return outcome
  }

  if (route === 'user-telegram') {
    // AC-5: the coordinator was told and neither resolved it nor escalated
    // within the grace window. This is the ONLY owner-facing path here, and it
    // fires at most once per episode (decideDialogEscalation's gaborNotifiedAt).
    const flaggedMinAgo = episode.escalation.wolfeFlaggedAt !== null
      ? minutes(nowMs - episode.escalation.wolfeFlaggedAt)
      : minutes(COORDINATOR_GRACE_MS)
    deps.sendOwner(buildQueueOwnerEscalation(stuck.length, oldestMin, list, flaggedMinAgo))
    deps.appendDigest({
      category: 'open',
      source: SIGNAL_ID,
      summary: `${stuck.length} uzenet beragadt (legregebbi ${oldestMin}p), a koordinator ${flaggedMinAgo}p-e nem reagalt -- Gabor ertesitve.`,
    })
    outcome.routes.push('user-telegram')
    return outcome
  }

  outcome.routes.push('log-only')
  return outcome
}

/** The episode ended (queue drained or targets resumed). Release the claims so
 * no item stays owned by a finished observation, and leave a digest line when
 * the coordinator had been pulled in -- "silent fixing" must still be visible. */
function closeEpisode(deps: WatchdogDeps, reason: string): void {
  if (!episode) return
  for (const key of episode.claimed) deps.releaseClaim(key)
  if (episode.flagged) {
    deps.appendDigest({
      category: 'auto-fixed',
      source: SIGNAL_ID,
      summary: `A beragadt uzenetsor feloldodott (${reason}) ${minutes(deps.nowMs - episode.startedAt)} perc utan, kulon beavatkozas nelkul.`,
    })
  }
  episode = null
}

/**
 * The coordinator flag. Same contract as the other [AUTOMATIKUS ...] flags in
 * channel-monitor: name the fact, name the remediation that already ran, name
 * the ONE action expected, and never leak a tmux session id or the literal
 * decision marker (the Stop hook false-detects it).
 */
export function buildQueueCoordinatorFlag(count: number, oldestMin: number, list: string): string {
  return (
    `[AUTOMATIKUS RIASZTAS] Az inter-agent uzenetsor akad: ${count} uzenet var, a legregebbi ${oldestMin} perce, ` +
    'es a cel-agens paneje NEM mozdul (nem dolgozik, csak all). Legidosebbek: ' + list + '. ' +
    'Az automatikus javitas mar futott ra (claim-lease ujrakezbesites, inbox-nudge, beragadt input takaritas) es nem oldotta meg. ' +
    'A te dolgod: nezd meg a dashboard uzenetsort es a cel-agens sessiont, oldd fel vagy inditsd ujra az erintett agenst. ' +
    `Ha ${Math.floor(COORDINATOR_GRACE_MS / 60000)} percen belul nem tortenik semmi, a rendszer Gabort is ertesiti.`
  )
}

/** The owner escalation. Human-friendly: no curl, no session id, no api path --
 * and it states WHY he is hearing about it (the coordinator went quiet), which
 * is the only thing that makes an owner-facing queue alert actionable. */
export function buildQueueOwnerEscalation(count: number, oldestMin: number, list: string, flaggedMinAgo: number): string {
  return (
    `⛔ Az inter-agent uzenetsor beragadt: ${count} uzenet all, a legregebbi ${oldestMin} perce (${list}). ` +
    `A koordinator ${flaggedMinAgo} perce megkapta a jelzest, de sem megoldani, sem tovabbadni nem tudta. ` +
    'Ez mar nem lassulas: valoszinuleg a koordinator maga is elakadt. Ha raersz, nezd meg.'
  )
}
