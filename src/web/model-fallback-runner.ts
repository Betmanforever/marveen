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
  agentDir,
  DEFAULT_MODEL,
} from './agent-config.js'
import {
  agentRunState,
  agentSessionName,
  restartAgentProcess,
  capturePane,
  getAgentRunningSince,
  getSessionCreatedAt,
  FLEET_OAUTH_TOKEN_PATH,
  hasFleetOauthToken,
} from './agent-process.js'
import { resolveAgentConfigDir } from './claude-plans.js'
import { readBootModelSample } from './active-model.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
import { paneLooksIdle } from '../pane-state.js'
import { readModelFallbackConfig } from './model-fallback-store.js'
import {
  detectsUsageLimit, detectsModelAccessFailure, decideModelAction,
  detectsUnrecognizedApiError, sanitizeFailureSnippet, isQuietHour,
  deriveMeasuredModel, advanceDriftStreak, decideDriftAction,
  decideMidSessionDriftAction, normalizeModelId,
  DRIFT_SAMPLE_ROWS, MIN_MIDSESSION_DRIFT_SWEEPS, type ModelDriftStreak,
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

// Startup burst (card b0c90a8a). The 50s first tick left the dashboard's own
// restart window uncovered: on 2026-07-31 the dashboard was down 15:01:01 to
// 15:02:06 and the main agent came back on the WRONG model at 15:01:30, with
// neither this runner nor the channel-monitor's credit-dialog branch alive to
// notice. Two extra sweeps put the first drift measurement at ~10s and the
// earliest correction at ~25s (MIN_DRIFT_SWEEPS consecutive sightings), so the
// blind window closes instead of running until someone spots it by hand.
// Offsets picked to miss the other watchers' ticks (auto-restart 40s,
// stuck-tool-call 35s) so the boot does not pile tmux calls onto one moment.
const STARTUP_SWEEP_DELAYS_MS = [10_000, 25_000]

// agent name -> downgrade record. Absent => currently on its own primary.
//   at:     when the (first) downgrade happened (ms)
//   from:   the model the agent ran before -- the revert target, so a mixed
//           fleet (fable primary here, opus primary there) reverts each agent
//           to ITS OWN model, not to the global chain[0]
//   sticky: access-failure driven -- never auto-revert (permanent error class)
// Mirrored to disk on every mutation and reloaded at boot. While this map was
// in-memory only, a dashboard restart erased it and a downgraded agent NEVER
// auto-reverted: with no record the revert branch is unreachable, so the agent
// kept running on the fallback model until someone noticed (2026-07-06: an
// agent sat on haiku overnight and had to be restored by hand).
interface DowngradeRecord {
  at: number
  from: string
  sticky: boolean
}
const downgraded = new Map<string, DowngradeRecord>()

// Only the downgrade records are persisted. The short-lived maps below
// (cooldown, tombstone, pending-access, probe bookkeeping) are deliberately
// left in memory: each is at most a few sweeps' worth of state, and losing it
// costs one round of re-detection -- cheap next to the risk of resurrecting a
// stale tombstone or cooldown that suppresses a real signal after a restart.
const STATE_PATH = join(PROJECT_ROOT, 'store', 'model-fallback-state.json')

// Longest model id accepted back from the state file. `from` is written into
// the agent's config on revert and handed to the probe as --model, so it gets
// the same type+bounds check as any other store-sourced value.
const MAX_MODEL_ID_LEN = 200

/**
 * Reload the downgrade records left by a previous dashboard process. Fail-open
 * like every other store reader (see model-fallback-store.ts): a missing,
 * unreadable or malformed file just means "nothing is downgraded" -- worst
 * case we lose one auto-revert, which is the pre-existing behaviour.
 */
function loadDowngradeState(): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(STATE_PATH, 'utf-8'))
  } catch {
    return
  }
  const root = (parsed && typeof parsed === 'object') ? parsed as Record<string, unknown> : {}
  const raw = (root.downgraded && typeof root.downgraded === 'object')
    ? root.downgraded as Record<string, unknown>
    : {}
  let restored = 0
  for (const [name, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object') continue
    const rec = value as Record<string, unknown>
    const { at, from } = rec
    if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) continue
    if (typeof from !== 'string' || !from.trim() || from.length > MAX_MODEL_ID_LEN) continue
    downgraded.set(name, { at, from, sticky: rec.sticky === true })
    restored++
  }
  if (restored > 0) logger.info({ restored }, 'model-fallback: downgrade state restored from disk')
}

/**
 * Mirror the records to disk. Called after EVERY mutation (including the
 * enabled=false reset) so a crash between the model write and the next sweep
 * cannot lose a record that the auto-revert depends on.
 */
function persistDowngradeState(): void {
  const out: Record<string, DowngradeRecord> = {}
  for (const [name, rec] of downgraded) out[name] = rec
  try {
    atomicWriteFileSync(STATE_PATH, JSON.stringify({ downgraded: out }, null, 2))
  } catch (err) {
    logger.warn({ err }, 'model-fallback: downgrade state persist failed')
  }
}

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
// Throttle for the cascade-guard hold log (audit P3), per agent.
const lastCascadeLogAt = new Map<string, number>()

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

// --- Unintended model drift (card b0c90a8a) ---
//
// Sustained-drift bookkeeping. Two CONSECUTIVE sweeps must measure the same
// wrong model before anything restarts: the correction costs a session
// restart, and a single sample can be a young session whose first turns have
// not landed yet. See advanceDriftStreak for why an unmeasurable sweep clears
// the streak instead of carrying it.
const MIN_DRIFT_SWEEPS = 2
const driftStreaks = new Map<string, ModelDriftStreak>()

// Flap-breaker, same shape as the probe-revert one (audit C-B): a drift
// correction restarts the agent so the credit dialog is answered by the live
// channel-monitor. If that branch is itself broken the corrected session
// drifts straight back, and an uncapped loop would restart the agent forever.
// After MAX_DRIFT_CORRECTIONS inside FLAP_WINDOW_MS the auto-correction stops
// for that agent and says so ONCE; from there it is an operator decision.
const MAX_DRIFT_CORRECTIONS = 2
interface DriftCorrectHistory { count: number; lastAt: number; capNotified: boolean }
const driftCorrectHistory = new Map<string, DriftCorrectHistory>()

// Mid-session variant (scope decision 2026-07-31 16:2x): a separate streak
// built from latestModel, alert-only (see decideMidSessionDriftAction for the
// audit R2 asymmetry). The latch remembers which wrong model was announced so
// one episode pages exactly once; it clears the moment the session is seen
// back on its configured model, so a LATER second drift alerts again.
const latestDriftStreaks = new Map<string, ModelDriftStreak>()
const midDriftAlerted = new Map<string, string>()

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
function announceSwitch(
  name: string, from: string, to: string, kind: string, detail: string,
  opts: { notifyMain?: boolean } = {},
): void {
  // The main agent IS the relay, so a switch it lives through needs no message
  // -- log only. `notifyMain` is the one exception: a drift correction respawns
  // the main session FRESH (channels.sh does not --continue), so the agent that
  // comes back has no memory of the switch at all. The queue is durable, so the
  // message survives the restart and is read on the next inbox drain.
  if (name === MAIN_AGENT_ID && !opts.notifyMain) return
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

function tryResolveFromPath(bin: string): string | null {
  try { return resolveFromPath(bin) } catch { return null }
}

// systemd --user unit that owns the main channels session on Linux.
// install-linux.sh names it "${SERVICE_ID}-channels" (install-linux.sh:1173),
// verified live on this host: SERVICE_ID=mr-wolfe -> mr-wolfe-channels.service.
const MAIN_CHANNELS_UNIT = `${SERVICE_ID}-channels.service`

// Resolved once, tolerantly: a Linux box without systemd (or without systemctl
// on PATH) has no way to respawn the main session. Writing the model there
// without a restart would be a silent settings.json drift (audit C2), so
// checkAgent skips the main agent instead -- see mainAgentRestartSupported.
const SYSTEMCTL_BIN = process.platform === 'linux' ? tryResolveFromPath('systemctl') : null

/**
 * True when this platform can actually respawn the main channels session.
 * Both transports re-run scripts/channels.sh, which reads the main agent's
 * model from the repo-root .claude/settings.json and passes it as --model
 * (channels.sh:204-222) before re-creating the tmux session (channels.sh:368-370)
 * -- so a plain restart is what applies the new model.
 */
function mainAgentRestartSupported(): boolean {
  if (process.platform === 'darwin') return true
  return process.platform === 'linux' && SYSTEMCTL_BIN !== null
}

function restartFor(name: string): void {
  if (name === MAIN_AGENT_ID) {
    // channels.sh always starts FRESH for main (kill-session + new-session, no
    // --continue), so the main agent's conversation is NOT preserved across a
    // model switch -- the model swap is what matters here.
    if (process.platform === 'darwin') {
      // launchd-managed; a kickstart re-reads .claude/settings.json (and thus
      // the new model) on relaunch. KeepAlive brings it straight back.
      const uid = typeof process.getuid === 'function' ? process.getuid() : ''
      execFileSync('/bin/launchctl', ['kickstart', '-k', `gui/${uid}/com.${SERVICE_ID}.channels`], { timeout: 10_000 })
    } else if (SYSTEMCTL_BIN) {
      // systemd --user; Restart=always brings the session back. Longer timeout
      // than launchctl because the unit's ExecStartPre rebuilds the native
      // modules before channels.sh runs.
      execFileSync(SYSTEMCTL_BIN, ['--user', 'restart', MAIN_CHANNELS_UNIT], { timeout: 15_000 })
    } else {
      // checkAgent gates on mainAgentRestartSupported(), so this is reachable
      // only if systemctl disappeared mid-run. Throw rather than no-op: the
      // caller logs it and announces that the switch applies on the next
      // respawn, instead of silently reporting a restart that never happened.
      throw new Error(`no main-agent restart transport on platform ${process.platform}`)
    }
  } else {
    // 'continue' (fresh: false) re-spawns with --continue so the conversation
    // survives the model swap.
    restartAgentProcess(name, { fresh: false })
  }
}

/**
 * Where this agent's live session log and its boot boundary are. The config
 * dir must come from resolveAgentConfigDir -- since the per-agent
 * CLAUDE_CONFIG_DIR migration a sub-agent's transcripts are NOT under ~/.claude
 * (that is why sub-agent token logging silently stopped on 2026-07-08), and
 * reading the wrong projects dir would report a permanent false "unmeasurable".
 */
function transcriptSourceFor(name: string): { workingDir: string; configDir?: string; since: number | null } {
  if (name === MAIN_AGENT_ID) {
    return {
      workingDir: PROJECT_ROOT,
      since: getSessionCreatedAt(MAIN_CHANNELS_SESSION),
    }
  }
  return {
    workingDir: agentDir(name),
    configDir: resolveAgentConfigDir(name).configDir ?? undefined,
    since: getAgentRunningSince(name),
  }
}

/**
 * Detect and undo an UNINTENDED model drift (card b0c90a8a, 2026-07-31): the
 * agent is answering on a model it was never configured for, with nothing in
 * the pane to see. Called only when the pane-based logic has nothing to do, so
 * the deliberate fallback path always keeps precedence.
 *
 * The correction is a RESTART, not a model write: the configured value on disk
 * is already right (verified in the incident -- the respawn passed the correct
 * --model and the credit gate overrode it anyway). Respawning with the
 * dashboard alive means the channel-monitor's credit-dialog branch is there to
 * answer the gate with the configured model this time.
 */
function checkModelDrift(
  name: string, pane: string, nowMs: number, limitSignal: boolean, hasActiveDowngrade: boolean,
): void {
  // A remote agent's transcripts live on the laptop, not on this filesystem;
  // scanning here would read "unmeasurable" forever (harmless) or, worse, a
  // stale local dir of the same name. Skip explicitly.
  if (name !== MAIN_AGENT_ID && readAgentRemoteHost(name)) return
  const src = transcriptSourceFor(name)
  if (src.since === null) return
  const configured = readModelFor(name)
  const sample = readBootModelSample(src.workingDir, src.since, src.configDir, DRIFT_SAMPLE_ROWS)
  const measured = deriveMeasuredModel(sample.bootModels)
  const streak = advanceDriftStreak(driftStreaks.get(name) ?? null, measured, configured)
  if (streak) driftStreaks.set(name, streak)
  else driftStreaks.delete(name)

  // Mid-session check BEFORE the boot path's early returns: it must run on
  // every sweep, and its own boot-drift guard keeps the two paths disjoint.
  checkMidSessionDrift(name, sample.latestModel, measured, configured, limitSignal, hasActiveDowngrade)

  const decision = decideDriftAction({
    streak,
    latestModel: sample.latestModel,
    configuredModel: configured,
    hasActiveDowngrade,
    limitSignal,
    minSweeps: MIN_DRIFT_SWEEPS,
  })
  if (decision.kind === 'none') return

  // Flap cap before any restart cost, so a broken credit-dialog branch cannot
  // turn this into a restart loop.
  const stale = driftCorrectHistory.get(name)
  if (stale && nowMs - stale.lastAt > FLAP_WINDOW_MS) driftCorrectHistory.delete(name)
  const hist = driftCorrectHistory.get(name)
  if (hist && hist.count >= MAX_DRIFT_CORRECTIONS) {
    if (!hist.capNotified) {
      hist.capNotified = true
      logger.warn({ name, measured: decision.measured, configured },
        'model-fallback: drift correction cap reached, auto-correction disabled for this agent')
      announceSwitch(name, decision.measured, configured, 'drift-stop',
        `Az agent 24 oran belul tobbszor visszasodrodott a konfiguralt modellrol (${configured}) erre: ${decision.measured}. Az automatikus drift-korrekciot ennel az agentnel KIKAPCSOLTAM -- a modell-kapu (credit-dialogus) valoszinuleg nem oldodik meg magatol. A visszaallitas manualis dontes.`,
        { notifyMain: true })
    }
    return
  }

  // Same quiet-hours rule as the rest of the sweep (audit 2026-07-31, P2): the
  // main agent's Linux restart is a FRESH spawn, so an unattended 03:00
  // correction would wipe Mr. Wolfe's conversation -- and during quiet hours no
  // traffic depends on him, so the wrong model has no consumer until 06:00
  // anyway. Sub-agent corrections are NOT deferred: same reasoning as a
  // downgrade, they free an agent that is silently running below spec.
  if (isQuietHour(new Date(nowMs).getHours()) && name === MAIN_AGENT_ID) {
    logger.info({ name, measured: decision.measured, configured },
      'model-fallback: drift correction due but quiet hours, deferring')
    return
  }
  if (!paneLooksIdle(pane)) {
    logger.info({ name, measured: decision.measured, configured },
      'model-fallback: drift correction due but pane busy, deferring')
    return
  }

  // Audit row BEFORE the restart, mirroring the switch path: old = what it was
  // ACTUALLY running, new = the configured value it is being put back on. This
  // is also what keeps scripts/check-model-drift.sh's unlogged-switch detector
  // quiet about a boundary this runner explains.
  try {
    logConfigChange(`agent.${name}.model`, decision.measured, configured, 'model-fallback:drift-autocorrect')
  } catch (err) {
    logger.warn({ err, name }, 'model-fallback: drift config_change_log write failed')
  }
  driftStreaks.delete(name)
  driftCorrectHistory.set(name, {
    count: (hist?.count ?? 0) + 1,
    lastAt: nowMs,
    capNotified: false,
  })
  // Arm the shared post-switch cooldown: the respawned session needs time to
  // write its first turns before any detector reads this agent again.
  lastSwitchAt.set(name, nowMs)

  let restartOk = true
  try {
    restartFor(name)
  } catch (err) {
    restartOk = false
    logger.warn({ err, name }, 'model-fallback: drift-correcting restart failed')
  }
  announceSwitch(name, decision.measured, configured, 'drift-autocorrect',
    `Ok: az agent tartosan a KONFIGURALT modell helyett mason futott (mert: ${decision.measured}, konfiguralt: ${configured}). Ez NEM szandekolt fallback, hanem drift -- valoszinuleg egy modell-kredit dialogus dolt el csendben a restart-ablakban -- ezert session-restarttal visszaallitottam a konfiguraltra.`
    + (restartOk ? '' : ' FIGYELEM: a session-restart nem sikerult, a drift TOVABBRA IS fennall.'),
    { notifyMain: true })
  logger.info({ name, measured: decision.measured, configured, restartOk },
    'model-fallback: corrected unintended model drift')
}

/**
 * Alert (never restart) on a session that booted RIGHT and slid off its model
 * later -- the variant the boot rows cannot see (measured 2026-07-31 10:37,
 * neo, fable-5 -> opus-4-8 mid-session, unnoticed for 5+ hours). Alert-only is
 * the audit's R2 condition: past the boot window a restart destroys a working
 * context, so the fix stays a human decision (/model in the session, or a
 * restart they choose to take).
 */
function checkMidSessionDrift(
  name: string, latestModel: string | null, bootMeasured: string | null,
  configured: string, limitSignal: boolean, hasActiveDowngrade: boolean,
): void {
  const streak = advanceDriftStreak(latestDriftStreaks.get(name) ?? null, latestModel, configured)
  if (streak) latestDriftStreaks.set(name, streak)
  else latestDriftStreaks.delete(name)
  // Seen back on the configured model: the episode is over, re-arm the latch.
  // An UNMEASURABLE sweep does not re-arm -- a scan hiccup mid-episode would
  // otherwise page a second time for the same drift.
  if (latestModel && normalizeModelId(latestModel) === normalizeModelId(configured)) {
    midDriftAlerted.delete(name)
  }
  const alreadyAlerted =
    streak !== null && midDriftAlerted.get(name) === normalizeModelId(streak.model)
  const decision = decideMidSessionDriftAction({
    streak,
    bootMeasured,
    configuredModel: configured,
    hasActiveDowngrade,
    limitSignal,
    minSweeps: MIN_MIDSESSION_DRIFT_SWEEPS,
    alreadyAlerted,
  })
  if (decision.kind === 'none') return

  midDriftAlerted.set(name, normalizeModelId(decision.measured))
  logger.warn({ name, measured: decision.measured, configured },
    'model-fallback: mid-session model drift detected, alerting (no auto-restart past boot window)')
  announceSwitch(name, decision.measured, configured, 'drift-alert',
    `Ok: az agent menet KOZBEN sodrodott le a konfiguralt modellrol (mert: ${decision.measured}, konfiguralt: ${configured}), a session indulasa meg a helyes modellen tortent. Automatikus restartot ilyenkor NEM inditok (elo munkakontextust torolne -- audit-feltetel, 2026-07-31 R2). A helyreallitas kezi dontes: /model a sessionben, vagy restart a dashboardrol.`,
    { notifyMain: true })
}

function checkAgent(name: string, nowMs: number, revertAfterMs: number, chain: string[]): void {
  // Main-agent restarts go through launchctl (macOS) or systemd --user
  // (Linux). Where neither transport exists we could write the new model but
  // NOT restart the session -- a silent settings.json drift (audit C2). Skip
  // the main agent entirely there; its model stays operator-managed. Sub-agents
  // are fully covered everywhere.
  if (name === MAIN_AGENT_ID && !mainAgentRestartSupported()) return
  // Sub-agents must be up; the main session is service-managed (launchd
  // KeepAlive / systemd Restart=always), so it is always present.
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
  if (action.kind === 'none') {
    // Cascade-guard observability (audit 2026-07-31, P3): the guard's skip is
    // deliberate but must not be invisible -- a persistent limit banner over a
    // fresh downgrade record is exactly the 07-05 pattern being suppressed.
    // Once per 30 min per agent, so a whole limit window logs 1-2 lines.
    if (limitDetected && record && nowMs - record.at < revertAfterMs
      && nowMs - (lastCascadeLogAt.get(name) ?? 0) > 30 * 60_000) {
      lastCascadeLogAt.set(name, nowMs)
      logger.info({ name, downgradedAt: record.at, from: record.from },
        'model-fallback: limit still visible but cascade guard holds (one step per window)')
    }
    // Only when the pane says nothing: the deliberate fallback path always
    // wins, and the drift correction is the last resort for the failure class
    // that leaves NO trace in the pane (card b0c90a8a).
    checkModelDrift(name, pane, nowMs, limitDetected || accessFailure !== null, record !== null)
    return
  }

  // Quiet-hours gate: a revert costs a session restart and is never urgent --
  // the agent is working fine on the fallback model -- so between 22:00 and
  // 06:00 local time we let it be and the next daytime sweep does it. A
  // sub-agent DOWNGRADE is intentionally NOT gated: that one frees an agent
  // sitting deaf on a limited or unusable model, which the night shift must
  // not sleep through. The MAIN agent is the exception in BOTH directions
  // (audit 2026-07-31, P2): its Linux restart path is a fresh spawn with no
  // --continue, so an unattended 03:00 switch would wipe Mr. Wolfe's live
  // conversation for a limit that resolves by morning anyway -- and during
  // quiet hours no traffic depends on him. Same clock as the rest of the
  // sweep, so the whole tick agrees.
  const quietNow = isQuietHour(new Date(nowMs).getHours())
  if (quietNow && (action.kind === 'revert' || name === MAIN_AGENT_ID)) {
    logger.info({ name, action: action.kind, model: action.model },
      'model-fallback: action due but quiet hours, deferring')
    return
  }

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
    persistDowngradeState()
    // Tombstone the acted-on line so it never re-triggers -- not even after a
    // later revert removes the downgrade record (C-A).
    if (accessFailure) handledLine.set(name, { line: accessFailure, missingSweeps: 0 })
    pendingAccess.delete(name)
    probeConfirmed.delete(name)
    lastProbeAt.delete(name)
  } else {
    downgraded.delete(name)
    persistDowngradeState()
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
      // Re-seed cleanly if re-enabled -- on disk too, or a restart would
      // resurrect records the operator already turned the feature off for.
      if (downgraded.size > 0) {
        downgraded.clear()
        persistDowngradeState()
      }
      pendingAccess.clear()
      probeConfirmed.clear()
      lastProbeAt.clear()
      lastSwitchAt.clear()
      handledLine.clear()
      stickyRevertHistory.clear()
      driftStreaks.clear()
      driftCorrectHistory.clear()
      latestDriftStreaks.clear()
      midDriftAlerted.clear()
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
  // Restore before the first sweep: a downgraded agent must keep its record
  // across a dashboard restart, otherwise the revert branch is unreachable and
  // it stays on the fallback model forever.
  loadDowngradeState()
  // Startup burst FIRST, so the dashboard's own restart window is covered
  // instead of being the one moment nothing watches (card b0c90a8a).
  for (const delay of STARTUP_SWEEP_DELAYS_MS) setTimeout(sweep, delay)
  setTimeout(sweep, INITIAL_DELAY_MS)
  return setInterval(sweep, INTERVAL_MS)
}
