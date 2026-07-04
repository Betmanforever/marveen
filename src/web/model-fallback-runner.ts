import { execFileSync, execFile } from 'node:child_process'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
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
  DEFAULT_MODEL,
} from './agent-config.js'
import {
  agentRunState,
  agentSessionName,
  restartAgentProcess,
  capturePane,
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
  /** The exact failure line already acted on (audit R1): the --continue replay
   * can keep showing it indefinitely; an identical line never re-triggers. */
  line: string | null
}
const downgraded = new Map<string, DowngradeRecord>()

// Post-switch cooldown (audit C1): the respawn uses --continue, so the OLD
// error banner can re-render from the replayed transcript right after a
// switch. Without damping, one real failure would cascade the agent down the
// whole chain in successive sweeps. A genuine failure of the fallback model
// still walks one more step -- just after the cooldown, not instantly.
const POST_SWITCH_COOLDOWN_MS = 10 * 60_000

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

function maybeProbePreferred(name: string, record: DowngradeRecord, nowMs: number): void {
  if (!record.sticky || probeConfirmed.has(name) || probeInFlight.has(name)) return
  if (!record.from.startsWith('claude-')) return
  if (name !== MAIN_AGENT_ID && readAgentAuthMode(name) === 'api') return
  // First probe a full interval after the switch (lastProbeAt seeds from the
  // switch time), then hourly.
  if (nowMs - (lastProbeAt.get(name) ?? record.at) < PROBE_INTERVAL_MS) return
  probeInFlight.add(name)
  lastProbeAt.set(name, nowMs)
  execFile(
    CLAUDE_BIN,
    ['-p', 'Reply with exactly: ok', '--model', record.from, '--max-turns', '1'],
    { timeout: PROBE_TIMEOUT_MS },
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

const MAIN_SETTINGS_PATH = join(PROJECT_ROOT, '.claude', 'settings.json')

function readMainModel(): string {
  try {
    const cfg = JSON.parse(readFileSync(MAIN_SETTINGS_PATH, 'utf-8'))
    return resolveModelId((cfg && typeof cfg.model === 'string' && cfg.model) || DEFAULT_MODEL)
  } catch {
    return DEFAULT_MODEL
  }
}

function writeMainModel(model: string): void {
  let cfg: Record<string, unknown> = {}
  try { cfg = JSON.parse(readFileSync(MAIN_SETTINGS_PATH, 'utf-8')) } catch {}
  cfg.model = model
  atomicWriteFileSync(MAIN_SETTINGS_PATH, JSON.stringify(cfg, null, 2))
}

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

  // Post-switch cooldown: right after a switch the replayed transcript can
  // still show the old error -- ignore all switch signals until it settles.
  const record0 = downgraded.get(name)
  if (record0 && nowMs - record0.at < POST_SWITCH_COOLDOWN_MS) return

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
  // re-triggers -- the replayed transcript can show it indefinitely (R1).
  let rawAccessFailure = detectsModelAccessFailure(pane)
  if (rawAccessFailure && record0?.line && rawAccessFailure === record0.line) rawAccessFailure = null
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
  // be invisible to the audit trail.
  try {
    logConfigChange(`agent.${name}.model`, currentModel, action.model, 'model-fallback')
  } catch (err) {
    logger.warn({ err, name }, 'model-fallback: config_change_log write failed')
  }
  // State update BEFORE the restart attempt (audit R2): a throwing restart
  // must still arm the cooldown/sticky record, or the next sweep would read
  // the new model as "current" and walk the chain one step further.
  const wasStickyRevert = action.kind === 'revert' && (record?.sticky ?? false)
  if (action.kind === 'downgrade') {
    // A repeat downgrade (chain walk) keeps the ORIGINAL from-model as the
    // revert target; stickiness escalates but never de-escalates.
    downgraded.set(name, {
      at: nowMs,
      from: record?.from ?? currentModel,
      sticky: action.sticky || (record?.sticky ?? false),
      line: accessFailure ?? record?.line ?? null,
    })
    pendingAccess.delete(name)
    probeConfirmed.delete(name)
    lastProbeAt.delete(name)
  } else {
    downgraded.delete(name)
    probeConfirmed.delete(name)
    lastProbeAt.delete(name)
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
