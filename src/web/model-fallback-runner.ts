import { execFileSync, execFile } from 'node:child_process'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { logger } from '../logger.js'
import { MAIN_AGENT_ID, SERVICE_ID, PROJECT_ROOT } from '../config.js'
import { resolveFromPath } from '../platform.js'
import { atomicWriteFileSync } from './atomic-write.js'
import {
  listAgentNames,
  readAgentRemoteHost,
  readAgentModel,
  writeAgentModel,
  readAgentAuthMode,
  resolveModelId,
  readMainModel,
  writeMainModel,
  DEFAULT_MODEL,
} from './agent-config.js'
import {
  agentRunState,
  agentSessionName,
  restartAgentProcess,
  capturePane,
  FLEET_OAUTH_TOKEN_PATH,
  hasFleetOauthToken,
} from './agent-process.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
import { paneLooksIdle } from '../pane-state.js'
import { readModelFallbackConfig } from './model-fallback-store.js'
import {
  detectsUsageLimit, detectsModelAccessFailure, decideModelAction,
  detectsUnrecognizedApiError, sanitizeFailureSnippet,
} from '../model-fallback.js'
import { logConfigChange, createAgentMessage } from '../db.js'

// Drives the model-fallback-on-limit feature (see src/model-fallback.ts for the
// why and the pure decision logic). Mirrors the auto-restart runner: a 60s
// sweep, offset from the other watchers so tmux calls do not pile onto one tick.
//
// Per agent each tick: capture the pane, detect a plan usage-limit banner, ask
// the pure decision function what to do, and -- only when the pane is idle --
// rewrite the agent's model and respawn the session (keeping the conversation)
// so the new model takes effect. A revert climbs back to the primary once the
// agent has been limit-free past the configured window.

const INITIAL_DELAY_MS = 50_000
const INTERVAL_MS = 60_000

// agent name -> downgrade record. Absent => currently on its own primary.
//   at:     when the (first) downgrade happened (ms)
//   from:   the model the agent ran before -- the revert target, so a mixed
//           fleet (fable primary here, opus primary there) reverts each agent
//           to ITS OWN model, not to the global chain[0]
//   sticky: access-failure driven -- never auto-revert (permanent error class)
// In-memory: a dashboard restart loses this, so a downgraded agent would not be
// auto-reverted until the next downgrade cycle. Acceptable; the agent keeps
// working on the fallback model, and the operator can revert manually.
interface DowngradeRecord {
  at: number
  from: string
  sticky: boolean
}
const downgraded = new Map<string, DowngradeRecord>()

// Post-switch cooldown (audit C1): the respawn uses --continue, so the OLD
// error banner can re-render from the replayed transcript right after a
// switch. Applies to BOTH directions (audit C-A): a revert must get the same
// damping, or the replayed line re-downgrades minutes after a revert.
const POST_SWITCH_COOLDOWN_MS = 10 * 60_000
const lastSwitchAt = new Map<string, number>()

// Handled-line tombstone (audit R1 + C-A): the exact failure line already
// acted on never re-triggers, and -- crucially -- the tombstone SURVIVES the
// revert (it is not part of the downgrade record). It is cleared only after
// the line has been absent from the pane for several consecutive sweeps, so a
// replay that still shows the old line cannot restart the loop. A genuinely
// NEW failure produces a different line (fresh timestamp-free wording is rare
// but possible; the flap-breaker below caps that residual case).
interface HandledLine { line: string; missingSweeps: number; expiresAt?: number }
const handledLine = new Map<string, HandledLine>()
const HANDLED_LINE_CLEAR_SWEEPS = 3
// After a revert the tombstone is time-boxed (audit T1): a byte-identical
// REAL new failure must eventually re-trigger -- otherwise a probe false
// positive would leave the agent stuck on a dead model behind a silent
// tombstone. Past the TTL the flap-breaker (C-B) handles a recurrence loudly.
const TOMBSTONE_REVERT_TTL_MS = 45 * 60_000

// Two-tick confirmation (audit F3): an access failure must be visible in two
// CONSECUTIVE sweeps before acting. A transient render (an agent cat-ing a
// file that quotes an error line, a scrolling build log) disappears by the
// next tick; a real API failure banner stays. agent -> first-sighting ms.
const pendingAccess = new Map<string, number>()
const PENDING_MIN_AGE_MS = 45_000
const PENDING_MAX_AGE_MS = 5 * 60_000

// Rate-limit for the unrecognized-error telemetry log (audit F8), per agent.
const lastUnrecognizedLogAt = new Map<string, number>()

// --- Reset-trigger probe (Gabor, 2026-07-04): sticky means "no TIMER revert",
// not "never revert". While a sticky downgrade is active, probe the preferred
// model hourly with a minimal headless call; when it succeeds (quota reset,
// usage credit added), the next sweep reverts through the normal action path
// (idle guard, audit row, restart, announce). Cost: one one-word prompt per
// hour per downgraded agent, zero when nothing is downgraded. The probe runs
// under the DASHBOARD's own auth (the owner's shared subscription), which is
// exactly the entitlement shared-auth agents use -- dedicated-API-key agents
// are skipped (their entitlement is a different account; manual revert there).
const CLAUDE_BIN = resolveFromPath('claude')
const PROBE_INTERVAL_MS = 60 * 60_000
const PROBE_TIMEOUT_MS = 120_000
const probeInFlight = new Set<string>()
const lastProbeAt = new Map<string, number>()
const probeConfirmed = new Set<string>()
let probeAuthWarned = false

// Flap-breaker (audit C-B): probe-driven reverts are counted per agent within
// a 24h window. The probe interval doubles per revert (1h -> 2h -> 4h), and
// after MAX_PROBE_REVERTS the auto-revert is disabled for that agent -- an
// intermittently failing model (gradual rollout, flaky entitlement) must not
// bounce an agent between models forever. Disabling is announced ONCE; from
// there climbing back is an operator decision.
interface StickyRevertHistory { count: number; lastRevertAt: number; capNotified: boolean }
const stickyRevertHistory = new Map<string, StickyRevertHistory>()
const FLAP_WINDOW_MS = 24 * 3_600_000
const MAX_PROBE_REVERTS = 2

function maybeProbePreferred(name: string, record: DowngradeRecord, nowMs: number): void {
  if (!record.sticky || probeConfirmed.has(name) || probeInFlight.has(name)) return
  if (!record.from.startsWith('claude-')) return
  if (name !== MAIN_AGENT_ID && readAgentAuthMode(name) === 'api') return
  const hist = stickyRevertHistory.get(name)
  if (hist && nowMs - hist.lastRevertAt > FLAP_WINDOW_MS) stickyRevertHistory.delete(name)
  const activeHist = stickyRevertHistory.get(name)
  if (activeHist && activeHist.count >= MAX_PROBE_REVERTS) {
    if (!activeHist.capNotified) {
      activeHist.capNotified = true
      announceSwitch(name, record.from, readModelFor(name), 'flap-stop',
        `A preferalt modell (${record.from}) 24 oran belul tobbszor visszavaltas utan ujra elhasalt -- az automatikus visszavaltast ennel az agentnel KIKAPCSOLTAM. A visszaallitas manualis dontes.`)
    }
    return
  }
  // First probe a full interval after the switch, then hourly -- doubled per
  // prior revert within the flap window.
  const interval = PROBE_INTERVAL_MS * 2 ** Math.min(activeHist?.count ?? 0, 3)
  if (nowMs - (lastProbeAt.get(name) ?? record.at) < interval) return
  // Auth: the dashboard host has NO ~/.claude/.credentials.json (verified on
  // this install) -- without the fleet OAuth token env every probe would die
  // as "Not logged in" and silently read as "model unusable". Inject the same
  // token the spawn path uses; without the token file, probing is impossible
  // and the sticky revert stays a manual operation (warn once per boot).
  if (!hasFleetOauthToken()) {
    if (!probeAuthWarned) {
      probeAuthWarned = true
      logger.warn('model-fallback: no fleet OAuth token (store/.claude-oauth-token) -- reset-trigger probe disabled, sticky revert is manual')
    }
    return
  }
  let oauthToken: string
  try {
    oauthToken = readFileSync(FLEET_OAUTH_TOKEN_PATH, 'utf-8').trim()
  } catch (err) {
    logger.warn({ err }, 'model-fallback: fleet OAuth token unreadable, probe skipped')
    return
  }
  probeInFlight.add(name)
  lastProbeAt.set(name, nowMs)
  execFile(
    CLAUDE_BIN,
    // Bare probe (audit P3): neutral cwd so no project CLAUDE.md is loaded,
    // and strict empty MCP config so no MCP servers spin up -- the point is a
    // one-word entitlement check on the expensive model, not a real session.
    // NOTE: the CLI rejects a bare '{}' ("mcpServers: expected record") --
    // the empty-server form MUST be {"mcpServers":{}} (verified on 2.1.201).
    ['-p', 'Reply with exactly: ok', '--model', record.from, '--max-turns', '1',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'],
    {
      timeout: PROBE_TIMEOUT_MS,
      cwd: tmpdir(),
      env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: oauthToken },
    },
    (err) => {
      probeInFlight.delete(name)
      if (!err) {
        probeConfirmed.add(name)
        logger.info({ name, model: record.from }, 'model-fallback: probe OK, preferred model usable again')
      } else {
        // Transient failures (network) just delay the revert by one interval.
        logger.debug({ name, model: record.from }, 'model-fallback: probe failed, preferred model still unusable')
      }
    },
  )
}

// Every switch is announced to the main agent, which relays it to the owner
// on Telegram. (The config_change_log audit row is written separately, right
// after the model write, so a failed restart can never hide the change -- the
// monthly model-eval needs that assignment history for correct attribution.)
function announceSwitch(name: string, from: string, to: string, kind: string, detail: string): void {
  if (name === MAIN_AGENT_ID) return // the main agent IS the relay; log only
  try {
    createAgentMessage(
      'model-fallback',
      MAIN_AGENT_ID,
      `AUTO MODEL FALLBACK (${kind}): ${name} agent modellje atallitva: ${from} -> ${to}. ${detail} Jelezd Gabornak Telegramon.`,
    )
  } catch (err) {
    logger.warn({ err, name }, 'model-fallback: main-agent notify failed')
  }
}

// readMainModel/writeMainModel moved to agent-config.ts so the PUT
// /api/agents/:name handler shares the same main-agent settings.json path
// (card: dashboard model edit was a silent no-op for the main agent).

function readModelFor(name: string): string {
  return name === MAIN_AGENT_ID ? readMainModel() : readAgentModel(name)
}

function writeModelFor(name: string, model: string): void {
  if (name === MAIN_AGENT_ID) writeMainModel(model)
  else writeAgentModel(name, model)
}

function sessionFor(name: string): string {
  return name === MAIN_AGENT_ID ? MAIN_CHANNELS_SESSION : agentSessionName(name)
}

function restartFor(name: string): void {
  if (name === MAIN_AGENT_ID) {
    // The main channels session is launchd-managed; a kickstart re-reads
    // .claude/settings.json (and thus the new model) on relaunch. KeepAlive
    // brings it straight back. channels.sh always starts fresh for main, so a
    // conversation is not preserved here -- the model swap is what matters.
    const uid = typeof process.getuid === 'function' ? process.getuid() : ''
    execFileSync('/bin/launchctl', ['kickstart', '-k', `gui/${uid}/com.${SERVICE_ID}.channels`], { timeout: 10_000 })
  } else {
    // 'continue' (fresh: false) re-spawns with --continue so the conversation
    // survives the model swap.
    restartAgentProcess(name, { fresh: false })
  }
}

function checkAgent(name: string, nowMs: number, revertAfterMs: number, chain: string[]): void {
  // Main-agent restarts go through launchctl (macOS-only). On other platforms
  // we could write the new model but NOT restart the session -- a silent
  // settings.json drift (audit C2). Skip the main agent entirely there; its
  // model stays operator-managed. Sub-agents are fully covered everywhere.
  if (name === MAIN_AGENT_ID && process.platform !== 'darwin') return
  // Sub-agents must be up; the main session is launchd-managed (always present).
  if (name !== MAIN_AGENT_ID && agentRunState(name) !== 'running') return

  const session = sessionFor(name)
  const host = name === MAIN_AGENT_ID ? null : readAgentRemoteHost(name)
  const pane = capturePane(session, host)
  if (pane == null) return

  // Post-switch cooldown, BOTH directions (C1 + C-A): right after a downgrade
  // OR a revert the replayed transcript can still show the old error --
  // ignore all switch signals until it settles.
  if (nowMs - (lastSwitchAt.get(name) ?? 0) < POST_SWITCH_COOLDOWN_MS) return

  // Handled-line tombstone upkeep (C-A): the tombstone outlives the downgrade
  // record; clear it only after the line has been gone for several sweeps.
  const tomb = handledLine.get(name)
  if (tomb) {
    if (tomb.expiresAt && nowMs > tomb.expiresAt) handledLine.delete(name)
    else if (pane.includes(tomb.line)) tomb.missingSweeps = 0
    else if (++tomb.missingSweeps >= HANDLED_LINE_CLEAR_SWEEPS) handledLine.delete(name)
  }

  // Telemetry (F8): surface API-error wordings we do not recognize, so the
  // cause patterns can be extended from evidence (the exact text of future
  // entitlement changes is unknown in advance). Log-only, once per 30 min.
  const unrecognized = detectsUnrecognizedApiError(pane)
  if (unrecognized && nowMs - (lastUnrecognizedLogAt.get(name) ?? 0) > 30 * 60_000) {
    lastUnrecognizedLogAt.set(name, nowMs)
    logger.info({ name, line: unrecognized }, 'model-fallback: unrecognized API error wording (no action)')
  }

  const limitDetected = detectsUsageLimit(pane)
  // Two-tick confirmation for the permanent class: act only when the failure
  // was already visible on the previous sweep and is still visible now. An
  // already-handled line (identical to the one we switched on) never
  // re-triggers -- the replayed transcript can show it indefinitely (R1/C-A).
  let rawAccessFailure = detectsModelAccessFailure(pane)
  if (rawAccessFailure && handledLine.get(name)?.line === rawAccessFailure) rawAccessFailure = null
  let accessFailure: string | null = null
  if (rawAccessFailure) {
    const firstSeen = pendingAccess.get(name)
    if (firstSeen && nowMs - firstSeen >= PENDING_MIN_AGE_MS && nowMs - firstSeen <= PENDING_MAX_AGE_MS) {
      accessFailure = rawAccessFailure
    } else if (!firstSeen || nowMs - firstSeen > PENDING_MAX_AGE_MS) {
      pendingAccess.set(name, nowMs)
    }
  } else {
    pendingAccess.delete(name)
  }
  const currentModel = readModelFor(name)
  const record = downgraded.get(name) ?? null
  if (record?.sticky) maybeProbePreferred(name, record, nowMs)
  const action = decideModelAction({
    limitDetected,
    accessFailure,
    currentModel,
    chain,
    downgradedAt: record?.at ?? null,
    downgradedFrom: record?.from ?? null,
    downgradeSticky: record?.sticky ?? false,
    preferredUsable: probeConfirmed.has(name),
    now: nowMs,
    revertAfterMs,
  })
  if (action.kind === 'none') return

  // Downgrade may run on a limit-paused pane (which reads idle); revert must not
  // cut a live turn. Both go through restart, so require idle for both.
  if (!paneLooksIdle(pane)) {
    logger.info({ name, action: action.kind }, 'model-fallback: action due but pane busy, deferring')
    return
  }

  try {
    writeModelFor(name, action.model)
  } catch (err) {
    logger.warn({ err, name }, 'model-fallback: model write failed, no switch')
    return
  }
  // Audit row IMMEDIATELY after the write (audit C2): if anything below
  // throws, the on-disk model has already changed -- that drift must never
  // be invisible to the audit trail. The actor carries the cause as a suffix
  // (model-fallback:usage-limit|model-access|revert) so the weekly report and
  // the monthly model-eval can classify events without guessing.
  const auditActor = action.kind === 'downgrade'
    ? `model-fallback:${action.cause}`
    : 'model-fallback:revert'
  try {
    logConfigChange(`agent.${name}.model`, currentModel, action.model, auditActor)
  } catch (err) {
    logger.warn({ err, name }, 'model-fallback: config_change_log write failed')
  }
  // State update BEFORE the restart attempt (audit R2): a throwing restart
  // must still arm the cooldown/sticky record, or the next sweep would read
  // the new model as "current" and walk the chain one step further.
  const wasStickyRevert = action.kind === 'revert' && (record?.sticky ?? false)
  lastSwitchAt.set(name, nowMs)
  if (action.kind === 'downgrade') {
    // A repeat downgrade (chain walk) keeps the ORIGINAL from-model as the
    // revert target; stickiness escalates but never de-escalates.
    downgraded.set(name, {
      at: nowMs,
      from: record?.from ?? currentModel,
      sticky: action.sticky || (record?.sticky ?? false),
    })
    // Tombstone the acted-on line so it never re-triggers -- not even after a
    // later revert removes the downgrade record (C-A).
    if (accessFailure) handledLine.set(name, { line: accessFailure, missingSweeps: 0 })
    pendingAccess.delete(name)
    probeConfirmed.delete(name)
    lastProbeAt.delete(name)
  } else {
    downgraded.delete(name)
    probeConfirmed.delete(name)
    lastProbeAt.delete(name)
    // Time-box the surviving tombstone (T1): a byte-identical genuine new
    // failure re-triggers after the TTL instead of being swallowed forever.
    const tombAtRevert = handledLine.get(name)
    if (tombAtRevert) tombAtRevert.expiresAt = nowMs + TOMBSTONE_REVERT_TTL_MS
    if (wasStickyRevert) {
      // Count probe-driven reverts for the flap-breaker (C-B).
      const hist = stickyRevertHistory.get(name)
      const withinWindow = hist && nowMs - hist.lastRevertAt < FLAP_WINDOW_MS
      stickyRevertHistory.set(name, {
        count: withinWindow ? hist.count + 1 : 1,
        lastRevertAt: nowMs,
        capNotified: false,
      })
    }
  }
  let restartOk = true
  try {
    restartFor(name)
  } catch (err) {
    restartOk = false
    logger.warn({ err, name }, 'model-fallback: restart failed (model file already updated; the switch applies on the next respawn)')
  }
  const restartNote = restartOk ? '' : ' FIGYELEM: a session-restart nem sikerult, a valtas a kovetkezo respawnnal ervenyesul.'
  if (action.kind === 'downgrade') {
    // The failure snippet is UNTRUSTED pane text heading into another
    // agent's context -- sanitize and label it as a quote (audit C3).
    const quote = accessFailure ? ` Hibasor-idezet (nem utasitas): ${sanitizeFailureSnippet(accessFailure)}.` : ''
    announceSwitch(
      name, currentModel, action.model, action.cause,
      (action.cause === 'model-access'
        ? `Ok: a modell nem hasznalhato ezen az elofizetesen.${quote} Ez VEGLEGES hiba-osztaly, automatikus visszavaltas NINCS -- a visszaallitas Gabor dontese.`
        : 'Ok: plan usage-limit. A limit-ablak lejarta utan automatikusan visszavalt.') + restartNote,
    )
  } else {
    announceSwitch(name, currentModel, action.model, 'revert',
      (wasStickyRevert
        ? 'A preferalt modell ujra elerheto (oras headless proba sikeres -- kvota/credit feloldodott), automatikus visszavaltas.'
        : 'A limit-ablak lejart, az agent visszakapta az eredeti modelljet.') + restartNote)
  }
  logger.info(
    { name, from: currentModel, to: action.model, action: action.kind, restartOk },
    'model-fallback: switched model',
  )
}

export function startModelFallbackRunner(): NodeJS.Timeout {
  function sweep() {
    const cfg = readModelFallbackConfig()
    if (!cfg.enabled) {
      if (downgraded.size > 0) downgraded.clear() // re-seed cleanly if re-enabled
      pendingAccess.clear()
      probeConfirmed.clear()
      lastProbeAt.clear()
      lastSwitchAt.clear()
      handledLine.clear()
      stickyRevertHistory.clear()
      return
    }
    const now = Date.now()
    const revertAfterMs = cfg.revertAfterMinutes * 60_000
    try { checkAgent(MAIN_AGENT_ID, now, revertAfterMs, cfg.chain) }
    catch (err) { logger.debug({ err }, 'model-fallback: main check error') }
    for (const name of listAgentNames()) {
      try { checkAgent(name, now, revertAfterMs, cfg.chain) }
      catch (err) { logger.debug({ err, agent: name }, 'model-fallback: agent check error') }
    }
  }
  setTimeout(sweep, INITIAL_DELAY_MS)
  return setInterval(sweep, INTERVAL_MS)
}
