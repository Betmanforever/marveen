import { existsSync, readFileSync, statSync, writeFileSync, utimesSync } from 'node:fs'
import { hostname, loadavg, availableParallelism } from 'node:os'
import { join } from 'node:path'
import { execSync, execFileSync, spawn } from 'node:child_process'
import { resolveFromPath } from '../platform.js'
import { logger } from '../logger.js'
import { MAIN_AGENT_ID, SERVICE_ID, BOT_NAME, CHANNEL_PROVIDER, PROJECT_ROOT, RESPAWN_ENABLED } from '../config.js'
import { agentDir, listAgentNames, readAgentChannelProvider } from './agent-config.js'
import { createAgentMessage, getPendingMessages } from '../db.js'
import {
  agentHasChannel,
  agentSessionName,
  capturePane,
  captureParkedInputView,
  clearInputBuffer,
  dismissResumeSummaryModalIfPresent,
  isAgentRunning,
  sendPromptToSession,
  startAgentProcess,
  stopAgentProcess,
  scheduleIdentitySetup,
  ensureMainAgentIsolatedConfigDir,
  FLEET_OAUTH_TOKEN_PATH,
} from './agent-process.js'
import { reapChannelOrphans, reapDetachedChannelClaudes } from './channel-poller-reap.js'
import { probeTelegramConflict } from './channel-conflict-probe.js'
import { schedulePluginUnlockAfterRespawn, wasPluginConfirmedAbsent, clearPluginAbsent, channelPluginInitPending } from './channel-plugin-unlock.js'
import {
  detectPaneState, decidePaneErrorAlert, detectsBlockingMenu, detectsPermissionDialog, type PaneErrorAlertState, type PaneState,
  decideDialogEscalation, type DialogEscalationState,
  paneShowsContextLow, paneShowsContextSaturation,
  decideContextBudgetEscalation, type ContextBudgetState,
  stuckInputSignature, decideStuckInputRecovery, parkedChannelInput,
  parkedInputText, shouldClearTruncatedPreamble, shouldEscalateFrozenPane,
  parkedInputRowCount, submitLanded, decideStuckInputAction,
  type StuckInputState, type StuckInputThresholds, type StuckInputAction,
  type StuckInputActionFacts,
} from '../pane-state.js'
import { decidePendingAgeAlert, decidePendingAgeRealert, shouldAlertStuckTarget, isTargetInBootGrace } from './message-router.js'
// The plan limit modal wears the same navigable-modal footer as a genuine
// menu; the limit-banner detector tells the two apart so the menu-recovery
// alert can name the real cause (see the blocking-menu pass below).
import { detectsUsageLimit, extractLimitReset } from '../model-fallback.js'
import { MAIN_CHANNELS_SESSION, MAIN_CHANNELS_PLIST } from './main-agent.js'
import { notifyChannel } from '../notify.js'
import { getProvider, channelStateDir, readChannelToken, type ChannelProviderType } from '../channel-provider.js'
import { attemptChannelMcpReconnect } from './channel-mcp-reconnect.js'
import { readLastIngestionTimestamp, TRANSCRIPT_DIR } from './inbound-probe.js'
import { decideDownAgentAction, AGENT_MAX_RESTART_ATTEMPTS, parseEtimeToSeconds } from './agent-restart-policy.js'
// getClaudePidForSession + hasChannelPluginAlive live in the shared liveness
// module so the standalone channel-coordinator reuses the exact same probe.
import { getClaudePidForSession, hasChannelPluginAlive } from '../channel-coordinator/liveness.js'
import { getDesiredAgents } from './agent-desired-state.js'

const TMUX = resolveFromPath('tmux')
const CLAUDE = resolveFromPath('claude')

// How long the agent's claude process has been running. Returns -1 when it
// cannot be determined, which the restart policy treats as "do not restart".
function getProcessAgeMs(pid: number): number {
  try {
    const out = execFileSync('/bin/ps', ['-o', 'etime=', '-p', String(pid)], { timeout: 3000, encoding: 'utf-8' })
    const secs = parseEtimeToSeconds(out)
    return secs < 0 ? -1 : secs * 1000
  } catch {
    return -1
  }
}

function resolveAgentProvider(name: string): ChannelProviderType {
  const perAgent = readAgentChannelProvider(name)
  if (perAgent === 'slack' || perAgent === 'telegram' || perAgent === 'discord') return perAgent
  return CHANNEL_PROVIDER
}

// --- Channel Plugin Health Monitor ---
// Detect when the channel plugin grandchild dies under a Claude session
// by walking the process tree. Agents recover via stop+start; for the
// main agent's channels session we can only alert + escalate, because
// killing it would terminate the live agent.

const agentDownSince: Map<string, number> = new Map()
const agentLastRestart: Map<string, number> = new Map()
// Consecutive watchdog restarts (keyed by agent name) that did NOT bring the
// plugin back up. Drives exponential back-off so a plugin that crashes on every
// launch (e.g. a broken third-party channel plugin) is not restarted on a fixed
// short cadence forever -- which restarts the WHOLE agent every few minutes and
// renders it unusable. Reset to 0 the moment the plugin is seen alive again.
// Persisted to disk so a dashboard process restart does not reset the counter and
// restart a channel plugin that has already been given up on (bug: dashboard PID
// bounce wiped in-memory counters, restarting agents indefinitely on every boot).
const agentRestartFailures: Map<string, number> = new Map()
let agentRestartFailuresInitialized = false

function agentFailuresPath(agentName: string): string {
  return join(PROJECT_ROOT, 'store', `.agent-failures-${agentName}`)
}

function loadPersistedAgentFailures(agentName: string): number {
  try {
    const n = parseInt(readFileSync(agentFailuresPath(agentName), 'utf-8').trim(), 10)
    return Number.isFinite(n) && n >= 0 ? n : 0
  } catch {
    return 0
  }
}

function savePersistedAgentFailures(agentName: string, count: number): void {
  try {
    writeFileSync(agentFailuresPath(agentName), String(count))
  } catch (err) {
    logger.debug({ err, agentName }, 'Failed to persist agent restart failures (non-fatal)')
  }
}

function clearPersistedAgentFailures(agentName: string): void {
  try {
    writeFileSync(agentFailuresPath(agentName), '0')
  } catch { /* best effort */ }
}

function ensureAgentRestartFailuresInitialized(): void {
  if (agentRestartFailuresInitialized) return
  agentRestartFailuresInitialized = true
  for (const a of listAgentNames()) {
    const persisted = loadPersistedAgentFailures(a)
    if (persisted > 0) {
      agentRestartFailures.set(a, persisted)
      logger.info({ agent: a, failures: persisted }, 'channel-monitor: restored persisted restart failure count from disk')
    }
  }
}
// Global stagger for channel-down restarts. On Claude Code 2.1.193 a sub-agent's
// --channels plugin only LOADS on a fresh (no --continue) launch, and several
// such cold-boots at once race on the shared plugin cache so NONE attach a
// poller. Serialise: at most one channel-down restart per this interval,
// fleet-wide, so each fresh cold-boot completes in isolation.
let lastChannelAgentRestartAt = 0
const CHANNEL_RESTART_STAGGER_MS = 90_000
// Above this 1-min load per core the host is thrashing and the spawn-based
// liveness probes are unreliable (2026-07-16: ETIMEDOUT cascade at load ~11 on
// 8 cores) -- the agent down-path defers instead of restarting.
const HOST_OVERLOAD_LOAD1_PER_CORE = 2
function hostOverloaded(): boolean {
  return loadavg()[0] > availableParallelism() * HOST_OVERLOAD_LOAD1_PER_CORE
}
const AGENT_RESTART_GRACE_MS = 90_000
// Floor frequency for the backed-off restart: even a long-down plugin is still
// retried at least this often, in case an external fix brings it back.
const AGENT_MAX_RESTART_GRACE_MS = 60 * 60 * 1000 // 1h
// A freshly started agent can take well over the first-probe window to bring
// its channel plugin up (a large-context model launched with --continue spawns
// the plugin only after a slow session load). Never restart a process younger
// than this on a "plugin down" reading, or the watchdog crash-loops it.
const AGENT_STARTUP_GRACE_MS = 180_000
// When the unlock probe has confirmed the plugin ABSENT from /mcp (never
// loaded, not merely Failed/disabled), a fresh restart cannot bring it back --
// it comes up absent again, and each restart wipes the agent's session context
// (2026-07-01: rocket + mantis burned 5 fresh-restarts each on an absent plugin
// before the watchdog gave up). Cap the restart budget at ONE for that case so
// the watchdog escalates to the operator after a single attempt instead of the
// full AGENT_MAX_RESTART_ATTEMPTS. The absent verdict is honoured only while
// fresh (re-stamped by each post-respawn probe, cleared on recovery).
const PLUGIN_ABSENT_MAX_RESTART_ATTEMPTS = 1
const PLUGIN_ABSENT_TTL_MS = 15 * 60 * 1000
const PLUGIN_ALERT_DEDUP_MS = 30 * 60 * 1000

// Stuck channel-input recovery (MAIN session only). A channel notification
// delivered while Boss is busy can be parked as plain text at the ❯ prompt
// without being submitted ('typing' state) -- it wedges the session because
// skipIfBusy heartbeats read 'typing' as not-idle and Boss never processes
// the message. The parked text already carries the full
// <channel ... chat_id=...> block, so recovery only needs to get it SUBMITTED.
let mainStuckInput: StuckInputState = { parkedSig: null, firstSeenAt: null, lastRecoverAt: null, attempts: 0 }
// Same recovery, per sub-agent session (keyed by tmux session name). A channel
// message can be parked at a sub-agent's ❯ prompt exactly like the main one --
// the sub-agent then "doesn't respond" until manually restarted. Entries are
// dropped once the spell ends so this never grows unbounded.
const agentStuckInput: Map<string, StuckInputState> = new Map()
// Raw Enters tried before escalating to clear+re-inject. Enter is faithful
// (it submits the REAL buffer, no capture-truncation risk); re-inject is the
// fallback for a TUI that swallows the Enter in raw-mode.
const MAIN_STUCK_ENTER_ATTEMPTS = 2
const MAIN_STUCK_THRESHOLDS: StuckInputThresholds = {
  // Same text must stay parked this long before the first recovery action so a
  // turn about to submit on its own is not pre-empted (>=2 observations at the
  // 60s tick).
  confirmMs: 90_000,
  // One recovery action per ~tick.
  dedupMs: 45_000,
  // 2 Enters + up to 2 re-injects, then hold (logged).
  maxAttempts: 4,
}

// --- Stuck-input hard-restart escalation (reliable backstop) ---
// When the soft recovery above (Enter + clear+re-inject) is EXHAUSTED but the
// main channel input is STILL parked, the TUI is hard-wedged: a paste
// placeholder that Enter only expands (never submits), or a state where
// keystrokes no longer register. Soft recovery cannot win there; the only fix
// is a fresh claude process. Escalate to hardRestartMarveenChannels()
// (respawn-pane on Linux -- replaces ONLY the main pane's claude, the tmux
// server + every other agent session stay intact). Rate-limited + capped so a
// wedge a restart cannot clear never becomes a restart loop.
const STUCK_RESTART_MIN_INTERVAL_MS = 5 * 60 * 1000
const STUCK_RESTART_MAX_CONSECUTIVE = 3
let stuckRestartCount = 0
let lastStuckRestartAt = 0

// Pure decision for the stuck-input restart escalation.
//   'restart' -> soft recovery exhausted + input still parked + rate-limit ok
//   'alert'   -> restarts are not clearing the wedge (cap reached) -> surface once
//   'skip'    -> not wedged past soft recovery, rate-limited, or already alerted
export function decideStuckInputRestart(
  parked: boolean,
  attempts: number,
  maxAttempts: number,
  now: number,
  lastRestartAt: number,
  restartCount: number,
  minIntervalMs: number,
  maxConsecutive: number,
): 'restart' | 'alert' | 'skip' {
  if (!parked || attempts < maxAttempts) return 'skip'
  if (now - lastRestartAt < minIntervalMs) return 'skip'
  if (restartCount >= maxConsecutive) return restartCount === maxConsecutive ? 'alert' : 'skip'
  return 'restart'
}

// Busy-guard over the stuck-input restart decision (false-positive fix,
// 2026-06-26). #452 hard-restarted (respawn-pane / launchctl reload) the main
// session as soon as a parked input survived ~4 soft-recovery ticks -- but a
// parked inbound message is the NORMAL transient case: the channel plugin drops
// it into the prompt box and the Claude TUI, in raw mode, frequently swallows
// the auto-submit Enter, so the same text sits 'typing' across several ticks
// until soft recovery (Enter / clear+re-inject) finally submits it. The hard
// restart pre-empted that recovery with a sledgehammer that destroyed the live
// conversation (~10 reloads in 12h, each losing context).
//
// Defer the restart whenever the pane is busy OR holds parked input it is still
// actively recovering ('typing') -- give soft recovery time to submit instead
// of nuking the session. A session that is genuinely DEAD (not even soft-
// recovering) is still caught by the keepalive-staleness watchdog (~18min), the
// pre-#452 backstop. This narrows the hard restart to unreadable/error panes and
// leaves the routine parked-input case to the non-destructive soft path.
// Reuses shouldDeferKeepaliveRespawn (single source of truth for busy/typing).
export function applyStuckRestartBusyGuard(
  paneState: PaneState | null,
  decision: 'restart' | 'alert' | 'skip',
): 'restart' | 'alert' | 'skip' {
  return shouldDeferKeepaliveRespawn(paneState) ? 'skip' : decision
}

// Session-agnostic stuck-input recovery: capture the pane, and if a channel
// notification is parked at the ❯ prompt, get it SUBMITTED (Enter-first, then
// clear + verbatim re-inject of the COMPLETE block). The gate fires ONLY for a
// parked <channel> block, so a human's own draft is never touched. Returns the
// next StuckInputState. Used for the main session AND every sub-agent session.
// Recover a channel/inter-agent message stranded at the ❯ prompt by getting it
// SUBMITTED. Tracks ANY parked input (stuckInputSignature), Enter-first, then
// escalates after MAIN_STUCK_ENTER_ATTEMPTS. Escalation has three safe paths:
//   1. a COMPLETE <channel> block -> clear + verbatim re-inject (chat_id-safe);
//   2. a truncated/stale safety preamble (no real opening tag) -> clear only,
//      NEVER re-inject (re-injecting it could let a later payload inherit a
//      stale trust preamble -- see shouldClearTruncatedPreamble);
//   3. SUB-AGENTS ONLY (allowPlainReinject): any other complete parked text
//      (e.g. an inter-agent notification) -> clear + re-inject the collapsed
//      text. A sub-agent's input box never holds a human draft, so this is
//      safe; the main session stays conservative (Enter / <channel>-only).
export function recoverStuckInputForSession(
  session: string,
  prev: StuckInputState,
  thresholds: StuckInputThresholds,
  allowPlainReinject: boolean,
): StuckInputState {
  // Ghost-stripped capture: a dim autocomplete hint in an empty box must NOT
  // read as parked input, or the recovery below would re-type + submit it
  // (phantom prompt-injection). See captureParkedInputView / stripGhostSuggestion.
  const pane = captureParkedInputView(session)
  const sig = pane != null ? stuckInputSignature(pane) : null
  const decision = decideStuckInputRecovery(sig, prev, Date.now(), thresholds)
  if (decision.recover && pane != null) {
    const attempt = decision.next.attempts
    const block = parkedChannelInput(pane)
    // Gather the parked-input facts and let the pure decision choose the move.
    // The decision NEVER bare-Enters a multi-row box (that inserts a newline
    // and corrupts the message) and prefers a chat_id-safe re-inject; the
    // truncation-guard (no verbatim re-inject of an incomplete <channel> block)
    // is preserved via blockTruncated.
    const facts: StuckInputActionFacts = {
      escalate: attempt > MAIN_STUCK_ENTER_ATTEMPTS,
      rowCount: parkedInputRowCount(pane),
      blockComplete: block != null && block.complete && block.block != null,
      blockTruncated: block != null && !block.complete,
      truncatedPreamble: shouldClearTruncatedPreamble(pane),
      allowPlainReinject,
      hasPlainText: allowPlainReinject && parkedInputText(pane) != null,
    }
    const action = decideStuckInputAction(facts)
    performStuckInputAction(session, action, pane, block, sig, attempt)
  }
  return decision.next
}

// Execute a stuck-input recovery action and verify it landed. The action is
// chosen by the pure decideStuckInputAction(); this does only the tmux side-
// effect plus POST-SUBMIT VERIFICATION (re-capture + submitLanded), so a move
// that did NOT clear the parked text is logged and the next tick escalates
// within the attempts budget (decideStuckInputRecovery caps it). 'hold' and
// 'clear-preamble' submit nothing, so there is nothing to verify there.
function performStuckInputAction(
  session: string,
  action: StuckInputAction,
  paneBefore: string,
  block: ReturnType<typeof parkedChannelInput>,
  prevSig: string | null,
  attempt: number,
): void {
  let submitted = false
  try {
    switch (action) {
      case 'reinject-block':
        logger.warn({ session, chatId: block?.chatId, attempt }, 'Stuck channel input -- clear + verbatim re-inject')
        clearInputBuffer(session)
        sendPromptToSession(session, block!.block!)
        submitted = true
        break
      case 'reinject-plain': {
        const text = parkedInputText(paneBefore)
        if (text != null) {
          logger.warn({ session, attempt }, 'Stuck input (non-channel) -- clear + re-inject parked text')
          clearInputBuffer(session)
          sendPromptToSession(session, text)
        } else {
          execFileSync(TMUX, ['send-keys', '-t', session, 'Enter'], { timeout: 5000 })
        }
        submitted = true
        break
      }
      case 'clear-preamble':
        logger.warn({ session, attempt }, 'Stuck input -- truncated safety preamble, clearing buffer (no re-inject)')
        clearInputBuffer(session)
        break
      case 'enter':
        execFileSync(TMUX, ['send-keys', '-t', session, 'Enter'], { timeout: 5000 })
        submitted = true
        break
      case 'hold':
        logger.warn({ session, attempt }, 'Stuck input -- multi-row/truncated, holding (no bare-Enter; awaiting keystroke fix)')
        break
    }
  } catch (err) {
    logger.warn({ err, session, action }, 'Stuck-input recovery action failed')
    return
  }
  if (submitted) {
    // submitLanded() handles a null capture internally (-> not landed). prevSig
    // is non-null here in practice (recover only fires on a parked signature),
    // but guard the type narrowing explicitly.
    const landed = prevSig != null ? submitLanded(prevSig, captureParkedInputView(session)) : false
    logger.warn(
      { session, action, attempt, landed },
      landed
        ? 'Stuck input -- recovery action landed'
        : 'Stuck input -- recovery action did NOT land (escalating next tick within budget)',
    )
  }
}

// Periodic detached-channel-claude reap (CB6CF755 durable fix). The pane-
// attribution reaper (reapDetachedChannelClaudes) already runs at RESPAWN time
// (resumeMarveenSession + agent (re)start), but orphans that accumulate BETWEEN
// respawns -- a --continue respawn that failed to tear down its predecessor --
// linger until the next respawn happens to fire (the "5 orphans over 13 days"
// leak). Running the same reaper on a slow cadence here closes that gap. The
// reaper is fail-safe (no live panes resolved -> reaps nothing) and pane-
// guarded, so a live agent/main session can never be hit. Throttled so the
// ps/tmux snapshot is not taken on every 60s tick.
const DETACHED_REAP_INTERVAL_MS = 10 * 60 * 1000
// Initialised to load time so the first periodic reap fires ~10min after boot,
// letting startup settle (the respawn-time reap already covers boot itself).
let lastDetachedReapAt = Date.now()

// Pure: is it time to run the periodic reap again? Exported for test.
export function shouldRunPeriodicReap(lastAt: number, now: number, intervalMs: number): boolean {
  return now - lastAt >= intervalMs
}

// Per-session tracking for the wedged thinking-block error (a Claude
// session stuck returning `400 ... thinking blocks cannot be modified`
// on every prompt). detectPaneState() classifies such a pane as
// 'error'; the monitor alerts so the operator can reset it. Alert-only
// by design -- auto-reset would destroy the agent's working memory and a
// false positive must not nuke a healthy session.
const paneErrorState: Map<string, PaneErrorAlertState> = new Map()
// Must persist for at least two monitor ticks (60s interval) before the
// first alert, so a one-tick transient never reports. 30 min dedup
// matches the channel-plugin alert cadence. clearMs (5 min) keeps a
// spell alive across brief non-error blips (null capture, mid-flight
// busy) so a flapping but genuinely wedged session still alerts.
const PANE_ERROR_CONFIRM_MS = 120_000
const PANE_ERROR_DEDUP_MS = 30 * 60 * 1000
const PANE_ERROR_CLEAR_MS = 5 * 60 * 1000

// Per-session tracking for a session parked in a blocking interactive menu
// (the /mcp manager, a model/config picker, a permission dialog). Unlike the
// thinking-block error this IS auto-recovered: a single Escape pops the modal
// without touching the conversation, so it is non-destructive. Reuses the
// decidePaneErrorAlert state machine (treat its `alert` as "recover now") so a
// one-tick transient never fires and the Escape is not re-sent every tick.
// confirmMs keeps it to ~2 ticks (~1-2 min) before recovering; dedupMs throttles
// retries if the Escape did not take; clearMs survives brief capture blips.
const paneMenuState: Map<string, PaneErrorAlertState> = new Map()
const MENU_RECOVER_CONFIRM_MS = 45_000
const MENU_RECOVER_DEDUP_MS = 5 * 60 * 1000
const MENU_RECOVER_CLEAR_MS = 2 * 60 * 1000

// A permission dialog is NOT auto-recovered (Escape would reject the tool call),
// so it can legitimately sit for a human-decision timescale. Escalation is
// two-phase per session: the coordinator (mr-wolfe) is flagged FIRST via an
// inter-agent message so it can resolve the dialog or humanise the decision,
// and only if the coordinator has not cleared it within DIALOG_WOLFE_GRACE_MS
// does a DIRECT owner alert fire as the safety net. A raw technical alert
// straight to the owner (the old behaviour) violated the "never send Gabor to a
// sub-agent terminal" fleet rule and Gabor complained about it. The decision
// itself lives in the pure decideDialogEscalation so it is tmux/db-free
// testable; this map only persists the state. The Escape-suppression stays
// unconditional. Cleared when the dialog disappears (see the menu-clear path).
const paneDialogEscalation: Map<string, DialogEscalationState> = new Map()
// Phase-1 dedup: re-flag the coordinator for the SAME persisting dialog at most
// this often (the 5-min menu dedup would otherwise emit ~12 flags/hour).
const DIALOG_ESCALATE_DEDUP_MS = 30 * 60 * 1000
// Grace after the coordinator is flagged before the direct owner fallback fires.
const DIALOG_WOLFE_GRACE_MS = 6 * 60 * 1000

// Second call-site for the SAME two-phase escalation: the thinking-block wedge
// (see the pane-level error pass). Kept in its OWN map so it can never cross-
// throttle the permission-dialog escalation above -- a session could in
// principle hit one then the other, and a shared map would let one spell's
// timestamps suppress the other's flag. Reuses decideDialogEscalation + the
// DIALOG_* timing unchanged; only the trigger differs (a confirmed error spell,
// not a permission dialog) and the wording (manual reset, not approve/deny).
const paneErrorEscalation: Map<string, DialogEscalationState> = new Map()

// The [AUTOMATIKUS DECISION-FLAG] inter-agent message sent to the coordinator
// (mr-wolfe) when a sub-agent is parked in a permission dialog. Shape mirrors
// scripts/hooks/decision-flag.py so the marveen-auto-decision-flag-triage skill
// triages it identically: it names the agent, states the permission_prompt
// stall, carries the escalation-governance rule, and warns against sending raw
// keys back to a dialog. Deliberately NO `tmux attach` / raw session-id, and no
// literal [DONTESRE-VAR:...] marker (which the Stop hook would false-detect).
function buildDialogCoordinatorFlag(label: string): string {
  return (
    `[AUTOMATIKUS DECISION-FLAG] A(z) ${label} sub-agent kore dontesre/inputra varva ragadt egy ` +
    'engedely-dialogusban (permission_prompt csatorna) -- a watchdog a pane-scan alapjan eszlelte, ' +
    'NEM kuldott Escape-et (az elutasitana a folyamatban levo muveletet es megszakitana a kort). ' +
    'Dontsd el: oldd fel kozvetlenul, ha egy mar jovahagyott feladat artalmatlan, egyertelmu-default ' +
    'lepese, VAGY forditsd emberi nyelvre es told tovabb Telegramon, ha Gabor-szintu dontes. ' +
    'Permission-dialogusra varo agentnek NE uzenj vissza nyers billentyut a message-routeren keresztul ' +
    '(a tmux-kezbesites gombot nyomhat a dialoguson) -- celzott send-keys vagy Telegram-eszkalacio a helyes ut.'
  )
}

// The direct owner (Gabor) fallback, fired only after the coordinator grace
// expires. Human-friendly by design: no tmux command, no raw session-id -- the
// exact complaint that motivated this change.
function buildDialogOwnerFallback(label: string): string {
  return (
    `⚠️ A(z) ${label} egy engedelyt igenylo lepesnel megallt es tobb perce dontesre var, ` +
    'a koordinator pedig nem oldotta fel. Ha raersz, nezd meg.'
  )
}

// The [AUTOMATIKUS DECISION-FLAG] inter-agent message sent to the coordinator
// (mr-wolfe) when a sub-agent is wedged on the thinking-block API error. Same
// shape / triage contract as buildDialogCoordinatorFlag (see
// marveen-auto-decision-flag-triage), but the resolution differs: the session
// history is corrupt so every prompt returns the same 400, the watchdog
// deliberately never auto-resets (a false positive must not nuke a healthy
// agent), and the ONLY fix is a manual stop+start for a fresh session -- which
// mr-wolfe can do directly. Deliberately NO `tmux attach` / raw session-id, and
// no literal [DONTESRE-VAR:...] marker (the Stop hook would false-detect it).
function buildThinkingBlockCoordinatorFlag(label: string): string {
  return (
    `[AUTOMATIKUS DECISION-FLAG] A(z) ${label} sub-agent egy thinking-block API hibaban ragadt ` +
    '(a session-history korrupt, minden uj prompt ugyanazt a 400-at adja) -- a watchdog a pane-scan ' +
    'alapjan eszlelte, es SZANDEKOSAN nem inditott auto-resetet (egy false-positive nem nukealhat egy ' +
    'egeszseges agentet). A megoldas KEZI RESET: allitsd le es inditsd ujra az agentet (stop+start), ' +
    'friss session indul -- ez a te hataskoreben van, futtasd le. A korrupt session-t prompttal NEM ' +
    'lehet feloldani, ezert NE uzenj neki nyers billentyut vagy promptot a message-routeren keresztul. ' +
    'Ha a reset utan is visszater vagy nem tudod vegrehajtani, forditsd emberi nyelvre es told tovabb Gabornak Telegramon.'
  )
}

// The direct owner (Gabor) fallback for the thinking-block wedge, fired only
// after the coordinator grace expires. Human-friendly by design: no tmux
// command, no raw session-id, and no 400/thinking-block jargon -- just that the
// agent is stuck and likely needs a restart.
function buildThinkingBlockOwnerFallback(label: string): string {
  return (
    `⚠️ A(z) ${label} egy ismetlodo API-hibaba ragadt es tobb perce nem tud dolgozni, ` +
    'a koordinator pedig nem allitotta helyre. Valoszinuleg ujrainditas kell hozza. Ha raersz, nezd meg.'
  )
}

// Third call-site for the SAME two-phase escalation: a pane at/near its context
// ceiling (paneShowsContextLow OR paneShowsContextSaturation). A saturated
// session still reads as idle, so the scheduler/router keep dispatching work
// whose in-flight verdicts/outputs can no longer be trusted -- the 2026-07-12
// wedge (a sub-agent at 97% context silently dropped four inter-agent messages
// in BOTH directions, escalation included). Own map so it can never cross-
// throttle the dialog/thinking-block escalations. decideContextBudgetEscalation
// adds a consecutive-tick confirm on top of the shared DIALOG_* dedup+grace.
const paneContextBudgetEscalation: Map<string, ContextBudgetState> = new Map()
// Persist the signal across this many consecutive ~60s ticks before the first
// coordinator flag -- a one-tick capture flake never escalates (~2 min at the
// 60s cadence). Reuses DIALOG_WOLFE_GRACE_MS / DIALOG_ESCALATE_DEDUP_MS.
const CONTEXT_BUDGET_CONFIRM_TICKS = 2
// Direct owner heads-up throttle for a context-LOW main channels session. Full
// saturation of main is already handled by the dispatch readiness gate
// (isSessionReadyForPrompt refuses a saturated pane) + the keepalive/down
// cascade, so this only covers the pre-saturation warning, and only the owner
// (the coordinator cannot flag itself).
let mainContextLowAlertAt: number | null = null

// The [AUTOMATIKUS DECISION-FLAG] inter-agent message sent to the coordinator
// (mr-wolfe) when a SUB-AGENT is at/near its context ceiling. Same shape/triage
// contract as buildDialogCoordinatorFlag / buildThinkingBlockCoordinatorFlag
// (see marveen-auto-decision-flag-triage). The resolution is a RESTART: a
// saturated session keeps reading idle and silently corrupts/drops work, so its
// in-flight verdicts must not be trusted; the watchdog deliberately does NOT
// auto-restart (a false positive would nuke a healthy session's context).
// Deliberately NO tmux/session-id leak and no literal [DONTESRE-VAR:...] marker.
function buildContextBudgetCoordinatorFlag(agentName: string): string {
  return (
    `[AUTOMATIKUS DECISION-FLAG] A(z) ${agentName} sub-agent a kontextus-plafonjahoz ert (a pane ` +
    'context-low vagy teljes 100%-os telitettseget mutat) -- a watchdog a pane-scan alapjan eszlelte. ' +
    'Amig ujra nem indul, a folyamatban levo megallapitasait, verdiktjeit es kimeneteit NE tekintsd ' +
    'megbizhatonak (egy telitett session tovabb dolgozik, de csendben elront vagy eldob dolgokat). ' +
    `A megoldas UJRAINDITAS: POST /api/agents/${agentName}/restart (vagy a dashboard agent-restart gombja) ` +
    '-- ez a te hataskoreben van, futtasd le. A watchdog SZANDEKOSAN nem inditott auto-resetet (egy ' +
    'false-positive nem nukealhat egy egeszseges session kontextusat). Ha ujraindulas utan is visszater, ' +
    'forditsd emberi nyelvre es told tovabb Gabornak Telegramon.'
  )
}

// The direct owner (Gabor) fallback for the context-ceiling case, fired only
// after the coordinator grace expires (sub-agents) or as a deduped heads-up
// (main). Human-friendly by design (mirrors buildThinkingBlockOwnerFallback):
// no curl, no raw session-id -- just that the agent is at its context limit, its
// recent output is unreliable, and it likely needs a restart.
function buildContextBudgetOwnerFallback(label: string): string {
  return (
    `⚠️ A(z) ${label} elerte a kontextus-plafonjat, a friss megallapitasai es valaszai megbizhatatlanok, ` +
    'amig ujra nem indul -- a koordinator pedig nem oldotta meg. Valoszinuleg ujrainditas kell hozza. Ha raersz, nezd meg.'
  )
}

// Pending-age watchdog state (see the watchdog pass in check()). The wedge
// escalation itself flows through agent_messages, so when THAT queue silently
// starves (2026-07-12) the escalation dies with it. The pass reads the queue
// DIRECTLY and alerts the owner via sendAlert (NEVER agent_messages), so it
// survives the queue wedging. One alert per stuck episode; re-armed when the
// backlog clears.
let pendingAgeLastAlertAt: number | null = null
const PENDING_AGE_ALERT_THRESHOLD_MS = 3 * 60 * 1000
const PENDING_AGE_ALERT_DEDUP_MS = 15 * 60 * 1000
// Past this age even a busy-working target alerts: an endless turn starves
// the queue just as dead as a wedge (busy-vs-wedged discrimination ceiling).
const PENDING_AGE_ALERT_HARD_CEILING_MS = 15 * 60 * 1000
// Ceiling RE-ARM: once the OLDEST pending row has out-waited this age (~3x the
// routine dedup) the episode is not merely slow but wedged-and-worsening, so a
// severity escalation re-alert fires INSIDE the routine dedup window
// (decidePendingAgeRealert). Self-throttled to one per PENDING_AGE_REALERT_DEDUP_MS
// via the shared pendingAgeLastAlertAt stamp, so it can never storm the tick.
const PENDING_AGE_REALERT_CEILING_MS = 45 * 60 * 1000
const PENDING_AGE_REALERT_DEDUP_MS = 5 * 60 * 1000
// Boot-grace suppression (2026-07-22 14:59 false alarm, Gabor approval): a
// target whose claude process started less than this long ago is booting, not
// wedged -- its pending rows are normal recovery latency. Kept under the hard
// ceiling so a boot that never completes still alerts.
const PENDING_AGE_BOOT_GRACE_MS = 5 * 60 * 1000

// Age of the session's pane-leader process (claude itself for agent panes).
// null on any failure -- callers must fail-open (no boot-grace claimed).
function paneProcessAgeMs(session: string): number | null {
  try {
    const panePid = execFileSync(TMUX, ['list-panes', '-t', session, '-F', '#{pane_pid}'], { timeout: 3000, encoding: 'utf-8' })
      .split('\n')[0]?.trim()
    if (!panePid || !/^\d+$/.test(panePid)) return null
    const out = execFileSync('/bin/ps', ['-o', 'etimes=', '-p', panePid], { timeout: 3000, encoding: 'utf-8' }).trim()
    const secs = parseInt(out, 10)
    return Number.isFinite(secs) && secs >= 0 ? secs * 1000 : null
  } catch {
    return null
  }
}

// The plan usage-limit dialog is a recurring special case: model-fallback
// respawns the limited session, the respawn re-hits the same plan-wide limit
// and re-parks the pane, so the 5-min menu dedup re-alerted on every cycle
// (observed 2026-07-05: 5 alerts in one 35-min limit window). One alert per
// limit window is enough -- the alert itself says model-fallback handles it.
// The per-cycle recovery Escape is NOT throttled by this, only the operator
// alert + the resume nudge. Unlike paneDialogEscalation this timestamp must
// SURVIVE the paneMenuState clear (every respawn cycle fully clears the menu
// spell); it resets only once the menu is gone AND the pane no longer shows
// the limit banner, i.e. the window is actually over.
const paneLimitDialogAlertAt: Map<string, number> = new Map()
const LIMIT_DIALOG_ALERT_DEDUP_MS = 60 * 60 * 1000

// Nudge injected (via the tested inter-agent message router, NOT a raw
// send-keys) after a recovery Escape pops a real menu on a sub-agent. The
// Escape can land on a modal that was covering a mid-turn tool call; the turn
// then sits idle and never resumes on its own (observed 2026-07-04: Charlie
// stalled ~40m). Framed as a main-agent message so the sub-agent treats it as a
// trusted coordinator prompt. The router holds it until the session is
// idle-ready, so enqueueing immediately after the Escape is safe.
const MENU_RECOVER_NUDGE = 'Automatikus recovery-Escape ment ki a sessionodbe (egy beragadt menu feloldasara). Ha ez megszakitott egy folyamatban levo lepest, folytasd onnan ahol abbamaradt, es ha elakadtal jelezz.'

type MarveenRecoveryStage = 'soft' | 'save' | 'resume' | 'hard' | 'gave_up'
interface MarveenDownState {
  downSince: number
  stage: MarveenRecoveryStage
  lastAlertAt: number
  softAttempts: number
  stageStartedAt?: number
  // Set once we've issued the diagnostic getUpdates probe for this down-cycle,
  // so we don't spam the upstream API every poll while recovery is running.
  conflictProbed?: boolean
}

const SAVE_WINDOW_MS = 60_000
const MARVEEN_DOWN_CONFIRM_MS = 120_000
let marveenSuspectFirstSeen: number | null = null
let marveenDownState: MarveenDownState | null = null

function getMainAgentProvider(): ChannelProviderType {
  return CHANNEL_PROVIDER
}

function softReconnectMarveen(): boolean {
  return attemptChannelMcpReconnect(MAIN_AGENT_ID).ok
}

function triggerMarveenMemorySave(): void {
  const prompt = [
    '[SYSTEM: channels recovery] A csatorna plugin nem reagal, kb 60 masodperc',
    `mulva hard restart lesz a ${MAIN_CHANNELS_SESSION} session-on (a beszelgetes elveszik).`,
    `MOST mentsd el a ${BOT_NAME} memoriaba amit a kovetkezo sessionnek tudnia kell:`,
    'aktiv feladatok (category hot), friss dontesek/preferenciak (warm), tanulsagok (cold).',
    'Hasznald: curl -s -X POST http://localhost:3420/api/memories ... (lasd CLAUDE.md).',
    'Ha kesz vagy, irj egy rovid napi naplo bejegyzest is a /api/daily-log-ra. Utana eleg.',
  ].join(' ')
  try {
    sendPromptToSession(MAIN_CHANNELS_SESSION, prompt)
    logger.info(`${BOT_NAME} memory-save prompt dispatched before hard restart`)
  } catch (err) {
    logger.warn({ err }, `Failed to dispatch ${BOT_NAME} memory-save prompt`)
  }
}

// Read the main agent's configured model from .claude/settings.json so a
// soft resume passes --model explicitly, mirroring scripts/channels.sh. Without
// it the respawned session falls back to claude-code's built-in default and
// silently drifts off the model the user picked. Returns '' when unset.
function readConfiguredMainModel(): string {
  try {
    const settingsPath = join(PROJECT_ROOT, '.claude', 'settings.json')
    if (!existsSync(settingsPath)) return ''
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    const model = parsed?.model
    return typeof model === 'string' ? model.trim() : ''
  } catch {
    return ''
  }
}

// Build the claude command used to (re)spawn the main channels session via
// `tmux respawn-pane`. Pure + exported so the contract test can LOCK the
// presence of the `$HOME/.bun/bin` PATH export (without it the respawned bun
// telegram bridge can't be found and the session comes up channel-less). The
// PATH and flags mirror scripts/channels.sh. `continueSession` resumes the
// prior conversation (stage-3 recovery) vs a clean start (hard restart).
//
// NOTE: inbound from `--channels` also goes through the allowlist at
// /etc/claude-code/managed-settings.json (allowedChannelPlugins); a plugin not
// listed there has its MCP notifications silently dropped. See channels.sh.
export function buildMainSessionRespawnCmd(opts: {
  claudePath: string
  pluginId: string
  model: string
  continueSession: boolean
  /**
   * When set (macOS main-agent isolation on), the respawn exports this isolated
   * CLAUDE_CONFIG_DIR plus the fleet setup-token -- parity with channels.sh CFG_ENV.
   * Without it the RECOVERY respawn brings the main agent up on the shared
   * ~/.claude, which on macOS authenticates from the rotating Keychain OAuth
   * session and periodically 401s ("Please run /login"). null/undefined => keep
   * the shared root (unchanged behaviour for installs with isolation off).
   */
  isolatedConfigDir?: string | null
}): string {
  return [
    'export PATH="/opt/homebrew/bin:$HOME/.bun/bin:/home/linuxbrew/.linuxbrew/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"',
    // MCP startup-batch tuning (parity with channels.sh + startAgentProcess):
    // the --channels plugin is a stdio MCP server; the main session runs the
    // most MCP servers (filesystem/playwright/chrome + claude.ai connectors +
    // the plugin), so without these the channel plugin can be starved out of
    // the default 3-wide blocking startup batch and never register a poller.
    // This respawn-pane path is the RECOVERY launcher -- it must tune the same
    // env as the channels.sh boot path, else a recovery respawn comes up
    // un-tuned and can re-starve under load.
    '&& export MCP_SERVER_CONNECTION_BATCH_SIZE=10 MCP_CONNECTION_NONBLOCKING=1 MCP_TIMEOUT=60000',
    // macOS main-agent config isolation -- parity with channels.sh CFG_ENV. The
    // token is read at launch via $(cat) so the secret never lands in argv/`ps`.
    ...(opts.isolatedConfigDir
      ? [`&& export CLAUDE_CONFIG_DIR='${opts.isolatedConfigDir}' && export CLAUDE_CODE_OAUTH_TOKEN="$(cat '${FLEET_OAUTH_TOKEN_PATH}')"`]
      : []),
    '&&', opts.claudePath,
    ...(opts.continueSession ? ['--continue'] : []),
    '--dangerously-skip-permissions',
    // Single-quote the model id so a value like `claude-opus-4-8[1m]` is not
    // glob-expanded by the shell that tmux respawn-pane spawns the command in.
    ...(opts.model ? ['--model', `'${opts.model}'`] : []),
    `--channels plugin:${opts.pluginId}`,
  ].join(' ')
}

// Exported so the stuck-tool-call-watcher recovers a wedged main session via
// this respawn-pane path (reap + `tmux respawn-pane -k --continue`) INSTEAD of
// the launchctl hard-restart. respawn-pane replaces only the claude process in
// the pane: it does NOT `tmux kill-session`, so an attached client is never
// kicked ([exited]) -- the #248 user-visible crash. It also runs the
// pane-attribution detached-claude reap first, breaking the orphan->409->freeze
// doom-loop that the launchctl path (channels.sh env-grep reap) never cleaned.
export function resumeMarveenSession(): boolean {
  const provider = getProvider(getMainAgentProvider())
  try {
    // Reap any orphan bun/node poller BEFORE we respawn. tmux respawn-pane -k
    // kills the parent claude process but leaves grandchild pollers running -
    // see channel-poller-reap.ts. Without this, the freshly-respawned
    // --continue session would race a still-alive poller for the same bot
    // token (409 Conflict on getUpdates).
    try {
      reapChannelOrphans(provider.type, PROJECT_ROOT)
    } catch (err) {
      logger.warn({ err }, 'resumeMarveenSession: pre-respawn reap failed (continuing)')
    }

    // Also reap DETACHED main-session claudes. reapChannelOrphans (env-scan)
    // cannot see the main session: channels.sh launches it without a
    // *_STATE_DIR export, so neither the claude nor its bun poller match the
    // env needle, and bot.pid is never written. A --continue respawn that did
    // not tear down the prior claude leaves it detached (reparented to the tmux
    // server) with a live poller hammering the shared token. Pane attribution
    // spares the live session (this pane) and kills only the leftovers.
    // See project_channels_continue_respawn_leak.
    try {
      reapDetachedChannelClaudes({ tmuxPath: TMUX })
    } catch (err) {
      logger.warn({ err }, 'resumeMarveenSession: detached-claude reap failed (continuing)')
    }

    const claudeCmd = buildMainSessionRespawnCmd({
      claudePath: CLAUDE,
      pluginId: provider.pluginId,
      model: readConfiguredMainModel(),
      continueSession: true,
      // Parity with channels.sh: a recovery respawn must also land on the
      // isolated CLAUDE_CONFIG_DIR (macOS), else it re-authenticates from the
      // rotating Keychain and 401s. Returns null when isolation is off/no token,
      // preserving the prior shared-root behaviour.
      isolatedConfigDir: ensureMainAgentIsolatedConfigDir(),
    })
    execFileSync(TMUX, ['respawn-pane', '-k', '-t', MAIN_CHANNELS_SESSION, claudeCmd], { timeout: 15000 })

    // --continue replays the last conversation. When the prior session is large
    // (>200k tokens) Claude Code opens with a "Resume from summary" modal that
    // parks the prompt - the plugin never reaches inbound-ready and stage 3
    // silently times out into stage 4. The agent-process startup path already
    // dismisses this modal; we mirror it here for the resume path.
    try {
      execFileSync('/bin/sleep', ['2'], { timeout: 4000 })
      dismissResumeSummaryModalIfPresent(MAIN_CHANNELS_SESSION)
    } catch (err) {
      logger.warn({ err }, 'resumeMarveenSession: post-respawn modal dismiss failed (continuing)')
    }

    // --continue replays the last conversation. When the prior session is
    // large (>200k tokens) Claude Code opens with a "Resume from summary"
    // modal that parks the prompt - the plugin never reaches the inbound-
    // ready state, detectPaneState stays 'unknown', and stage 3 silently
    // times out into stage 4. The agent-process startup path already dismisses
    // this modal; we do the same here so the resume path matches.
    try {
      execFileSync('/bin/sleep', ['2'], { timeout: 4000 })
      dismissResumeSummaryModalIfPresent(MAIN_CHANNELS_SESSION)
    } catch (err) {
      logger.warn({ err }, 'resumeMarveenSession: post-respawn modal dismiss failed (continuing)')
    }

    logger.warn({ provider: provider.type }, 'Marveen session respawned with --continue')
    // Re-establish /name on the brand-new claude process (the prior session's
    // identity is gone after respawn-pane; channels.sh sets it on a normal
    // start). /remote-control was dropped (the operator no longer uses it).
    scheduleIdentitySetup(MAIN_CHANNELS_SESSION, BOT_NAME)
    // channels.sh runs an /mcp+Up+Enter+Enter unlock probe after launching
    // the main session to revive a Failed/disabled channel plugin (#231/#232),
    // but THIS code path skips channels.sh entirely - tmux respawn-pane is
    // direct. Schedule the same probe in-process so the plugin doesn't get
    // stuck in `◯ disabled` after an in-process respawn (2026-06-01 18:55).
    schedulePluginUnlockAfterRespawn(MAIN_CHANNELS_SESSION, provider.type)
    // Post-resume guard (CC 2.1.193 regression). A --continue resume can come up
    // WITHOUT the --channels plugin (absent from /mcp, no poller -> deaf main
    // channel). The unlock probe above only revives a Failed/disabled plugin --
    // it cannot help when the plugin never loaded at all. Schedule a liveness
    // probe; if the plugin is still missing after the settle, escalate straight
    // to a FRESH respawn instead of burning the full RESUME_GRACE_MS cascade.
    // Context is dropped only in the bad case; a clean --continue keeps it.
    schedulePostResumePluginGuard(provider.type)
    // Stamp the shared respawn timestamp so lastMainRespawnAt() sees this
    // respawn from any caller (down-cascade stage 3, stuck-tool-call-watcher,
    // external systemd-timer watchdog). Without it the watcher cannot defer
    // its own self-respawn-and-recheck within the post-respawn grace, which
    // produced the 2026-06-08 false-positive loop (13 respawns in 8h on
    // residual 3-4s counters left over from the prior respawn's TUI redraw).
    writeRespawnStamp()
    return true
  } catch (err) {
    logger.error({ err }, 'Marveen session respawn failed')
    return false
  }
}

// Grace history: 90s -> 150s -> 240s.
// 2026-06-01 16:31 incident: with the reap+modal-dismiss path landed,
// resumeMarveenSession respawned cleanly, but a >200k-token --continue
// session-load + plugin re-handshake exceeded the 150s window and stage 4
// fired anyway (context lost). Bumped to 240s so the slowest realistic
// large-context resume completes inside the window. The monitor polls every
// 60s, so the effective resolution rounds up to the next poll - 240s gives
// 3-4 polls' worth of slack before the hard restart escalates.
const RESUME_GRACE_MS = 240_000
let marveenLastHardRestart = 0
// Post-respawn cold-start grace. After ANY main-session respawn (keepalive
// fresh-respawn, stage-3 resume, or stage-4 hard restart) the new claude needs
// minutes to load its large context and complete the channel-plugin handshake.
// The 2026-06-01 480s outage was self-inflicted churn: a keepalive fresh-respawn
// at 17:59:20 was followed by a down-detect at 18:03 because this grace was only
// 120s -- it expired mid cold-start, so soft->save->resume->hard piled THREE
// restarts onto a session that was merely still booting. 6 min comfortably
// covers the slowest realistic cold start while staying under the 18-min
// keepalive-staleness net, so a session that is genuinely dead after a respawn
// is still caught by another path. Exported so the stuck-tool-call-watcher
// shares the same post-respawn grace (single source of truth).
export const MARVEEN_POST_RESPAWN_GRACE_MS = 360_000

/**
 * B2 fix: shared cross-path grace accessor.
 * Returns the wall-clock time (ms since epoch) of the most recent main-session
 * respawn, regardless of which path triggered it (keepalive or inbound-probe).
 * Both paths check this before firing so they cannot double-respawn within
 * KEEPALIVE_RESPAWN_GRACE_MS of each other.
 */
export function lastMainRespawnAt(): number {
  return Math.max(marveenLastKeepaliveRespawn, marveenLastHardRestart, fileRespawnStampMs())
}

// Cross-LAYER coordination with the independent systemd-timer watchdog
// (scripts/channel-watchdog.sh). That timer writes RESPAWN_STAMP_FILE (epoch
// SECONDS) when IT respawns; reading it here means an out-of-process respawn
// also suppresses this in-process watchdog for the grace window. Symmetrically,
// hardRestartMarveenChannels writes the same file so the timer defers to us.
// Best-effort: 0 if absent/garbage.
const RESPAWN_STAMP_FILE = join(PROJECT_ROOT, 'store', '.channel-last-respawn')
function fileRespawnStampMs(): number {
  try {
    const s = parseInt(readFileSync(RESPAWN_STAMP_FILE, 'utf-8').trim(), 10)
    return Number.isFinite(s) && s > 0 ? s * 1000 : 0
  } catch {
    return 0
  }
}
function writeRespawnStamp(): void {
  try {
    writeFileSync(RESPAWN_STAMP_FILE, String(Math.floor(Date.now() / 1000)))
  } catch { /* best effort */ }
}

// --- Vanished-session recovery (self-healing main session) ---
//
// The down-cascade (handleMarveenDown) recovers a main session whose claude
// process is alive but whose channel plugin died, by replacing the claude
// process in the EXISTING pane via `tmux respawn-pane`. respawn-pane needs a
// live pane: it cannot bring back a session that has disappeared entirely
// (crash, self-update mid-restart, OOM kill, host reboot). On a deployment
// where nothing supervises the session -- marveen-channels.service disabled,
// or any pure-tmux install -- a vanished session stays gone, and because the
// scheduler skips every task whose target tmux session is missing
// (schedule-runner !sessionExists branch), ALL main-agent scheduled jobs
// (morning briefing, daily-log, dream-engine, audits, heartbeats) silently
// stop firing with no error surfaced anywhere. This closes that gap by
// recreating the session from scratch via the canonical scripts/channels.sh --
// the same path the service uses -- so recovery is channel-independent and
// works even with the service disabled.
const CHANNELS_SCRIPT = join(PROJECT_ROOT, 'scripts', 'channels.sh')
// channels.sh creates the session, runs the first-run dialog auto-accept, sets
// /name, and brings up the channel plugin -- a cold start that takes minutes.
// Throttle relaunches so a session that is still booting is not torn down and
// recreated on the next 60s poll.
const MAIN_SESSION_CREATE_GRACE_MS = 360_000
let marveenLastSessionCreate = 0

export function mainChannelsSessionExists(): boolean {
  try {
    execFileSync(TMUX, ['has-session', '-t', MAIN_CHANNELS_SESSION], { timeout: 3000 })
    return true
  } catch {
    return false
  }
}

export function createMainChannelsSession(): boolean {
  const now = Date.now()
  if (marveenLastSessionCreate && now - marveenLastSessionCreate < MAIN_SESSION_CREATE_GRACE_MS) {
    return false
  }
  if (!existsSync(CHANNELS_SCRIPT)) {
    logger.error({ script: CHANNELS_SCRIPT }, 'Cannot recreate main channels session: channels.sh missing')
    return false
  }
  try {
    // Detached + unref'd: channels.sh is a long-lived supervisor (it tails the
    // session in a wait loop), so it must outlive this check() tick without
    // keeping the dashboard event loop alive. stdio ignored -- channels.sh does
    // its own logging to store/channels-failures.log.
    const child = spawn('/bin/bash', [CHANNELS_SCRIPT], {
      detached: true,
      stdio: 'ignore',
      cwd: PROJECT_ROOT,
    })
    child.unref()
    marveenLastSessionCreate = now
    // Fold into the shared cold-start grace so the down-cascade defers to this
    // boot instead of stacking a respawn on a session that is still coming up.
    writeRespawnStamp()
    logger.warn({ session: MAIN_CHANNELS_SESSION }, 'Main channels session absent -- recreating via channels.sh')
    sendAlert(`♻️ A ${MAIN_CHANNELS_SESSION} session eltunt -- ujrainditom (channels.sh). Enelkul minden utemezett feladat csendben kimaradna.`)
    return true
  } catch (err) {
    logger.error({ err }, 'Failed to recreate main channels session via channels.sh')
    return false
  }
}

// Hard-restart fallback when there is no systemd unit to bounce: respawn the
// tmux pane with a FRESH claude (no --continue). Mirrors resumeMarveenSession
// but starts a clean session -- exactly what scripts/channels.sh does -- so a
// wedged plugin gets a brand-new process even on pure-tmux installs. Distinct
// from the stage-3 resume (which keeps --continue) by clearing session state.
function respawnMarveenSessionFresh(): boolean {
  const provider = getProvider(getMainAgentProvider())
  try {
    const claudeCmd = buildMainSessionRespawnCmd({
      claudePath: CLAUDE,
      pluginId: provider.pluginId,
      model: readConfiguredMainModel(),
      continueSession: false,
      // Same channels.sh-bypass concern as resumeMarveenSession: this fresh
      // respawn also skips channels.sh, so it must carry the isolated config
      // itself or it 401s on the rotating macOS Keychain. null when off/no token.
      isolatedConfigDir: ensureMainAgentIsolatedConfigDir(),
    })
    execFileSync(TMUX, ['respawn-pane', '-k', '-t', MAIN_CHANNELS_SESSION, claudeCmd], { timeout: 15000 })
    logger.warn({ provider: provider.type }, 'Hard restart: marveen session respawned fresh (no --continue)')
    // Re-establish /name on the fresh process (see note in resumeMarveenSession).
    scheduleIdentitySetup(MAIN_CHANNELS_SESSION, BOT_NAME)
    // Same channels.sh-bypass concern as in resumeMarveenSession: this respawn
    // path does NOT invoke channels.sh, so the post-init plugin unlock probe
    // (#231/#232) never runs. Wire it in-process so the keep-alive-watchdog
    // fresh-respawn path also revives a Failed/disabled plugin instead of
    // leaving the channel offline until manual intervention.
    schedulePluginUnlockAfterRespawn(MAIN_CHANNELS_SESSION, provider.type)
    writeRespawnStamp() // coordinate with the systemd-timer watchdog (covers the keepalive path too)
    return true
  } catch (err) {
    logger.error({ err }, 'Fresh session respawn failed')
    return false
  }
}

// Post-resume guard delay. Must clear the unlock-probe budget (first probe at
// ~35s, retries every 15s up to 2x => ~65s worst case) so a plugin that merely
// loaded `disabled` gets revived BEFORE we declare the resume deaf, yet stay
// well under RESUME_GRACE_MS (240s) so a genuinely-absent plugin escalates
// ~150s sooner than the cascade would. 90s leaves a healthy --continue ample
// time to attach its poller; only a pathologically large (>200k-token) context
// resume risks a false escalation, which still self-heals (fresh respawn).
export const POST_RESUME_GUARD_DELAY_MS = 90_000

// Gap (seconds) between the two liveness samples in the post-resume probe (see
// shouldEscalateFrozenPane). Long enough that a pane still rendering / settling
// differs between captures -- so a session merely slow to come up is NOT judged
// frozen -- yet short enough to keep the already-delayed guard callback brief.
const POST_RESUME_PROBE_GAP_S = 4

// PURE decision for the post-resume guard: after a --continue resume, do we have
// to escalate to a fresh respawn? Yes iff the resumed session is NOT serving the
// channel plugin -- either the claude pid is gone, or the pid is alive but the
// plugin never attached (the CC 2.1.193 regression). A live pid WITH the plugin
// means --continue succeeded and the conversation context is preserved.
export function shouldEscalateAfterResume(f: { claudePid: number | null; pluginAlive: boolean }): boolean {
  if (f.claudePid == null) return true
  return !f.pluginAlive
}

// Scheduled (non-blocking) check fired after a --continue resume. If the
// channels plugin attached, the resume succeeded and the conversation context
// is preserved -- nothing to do. If it did not (CC 2.1.193: --continue does not
// re-init the plugin MCP server), escalate to a FRESH respawn so the main
// channel becomes reachable again. respawnMarveenSessionFresh() writes the
// respawn stamp, so lastMainRespawnAt() suppresses the down-cascade's redundant
// stage-4 hard restart during the ensuing cold boot.
function schedulePostResumePluginGuard(provider: ChannelProviderType): void {
  setTimeout(() => {
    try {
      const claudePid = getClaudePidForSession(MAIN_CHANNELS_SESSION)
      const pluginAlive = claudePid != null && hasChannelPluginAlive(claudePid, provider)
      if (!shouldEscalateAfterResume({ claudePid, pluginAlive })) {
        // Plugin attached -- but a live poller does NOT prove the resumed TUI can
        // ACT on input (the 2026-06-02 stdio wedge: poller alive, render loop
        // frozen). Confirm the pane is a live surface with a stdin-SAFE two-sample
        // liveness read (no keystroke: a bare Enter would submit parked text and
        // typing would answer a permission dialog). Escalate only if the pane is
        // frozen (non-idle, non-busy, no dialog, no parked input, byte-identical
        // across both samples). shouldEscalateFrozenPane fails open on a capture
        // miss, so a transient tmux hiccup never triggers a needless respawn.
        const sampleA = capturePane(MAIN_CHANNELS_SESSION)
        try {
          execFileSync('/bin/sleep', [String(POST_RESUME_PROBE_GAP_S)], { timeout: (POST_RESUME_PROBE_GAP_S + 2) * 1000 })
        } catch { /* best effort: fall through to the second capture */ }
        const sampleB = capturePane(MAIN_CHANNELS_SESSION)
        if (shouldEscalateFrozenPane(sampleA, sampleB)) {
          logger.warn({ provider }, 'Post-resume guard: plugin attached but the resumed pane is FROZEN (non-idle/non-busy, unchanged across two samples) -- the --continue TUI is wedged; escalating to fresh respawn (context dropped, memory persists)')
          sendAlert(`⚠️ A --continue resume utan a channel plugin felallt, de a TUI befagyott (ket mintavetel kozott valtozatlan, nem reagal). Fresh respawn most a ${MAIN_CHANNELS_SESSION} session-on (a beszelgetes elveszik, memoria marad).`)
          respawnMarveenSessionFresh()
          return
        }
        logger.info({ provider }, 'Post-resume guard: channel plugin attached after --continue AND the pane is a live surface -- context preserved, no escalation')
        return
      }
      logger.warn({ provider }, 'Post-resume guard: --continue resume came up WITHOUT the channels plugin (CC 2.1.193) -- escalating to fresh respawn (context dropped, memory persists)')
      sendAlert(`⚠️ A --continue resume suketen jott fel (nincs channel plugin). Fresh respawn most a ${MAIN_CHANNELS_SESSION} session-on (a beszelgetes elveszik, memoria marad).`)
      respawnMarveenSessionFresh()
    } catch (err) {
      logger.warn({ err }, 'Post-resume guard probe failed (leaving recovery to the down-cascade)')
    }
  }, POST_RESUME_GUARD_DELAY_MS)
  logger.info({ delayMs: POST_RESUME_GUARD_DELAY_MS }, 'Post-resume plugin guard scheduled after --continue resume')
}

export function hardRestartMarveenChannels(): { ok: boolean; error?: string } {
  // macOS: bounce the launchd job when the plist exists. If the channels session
  // is NOT managed by launchd on this install (plist absent -- only
  // com.jarvis.dashboard exists), fall through to the respawn-pane path below.
  // The previous unconditional launchctl call was a silent no-op: launchctl
  // accepts a non-existent plist with exit 0, leaving the session untouched.
  if (process.platform !== 'linux' && existsSync(MAIN_CHANNELS_PLIST)) {
    try {
      execFileSync('/bin/launchctl', ['unload', MAIN_CHANNELS_PLIST], { timeout: 5000 })
      execFileSync('/bin/sleep', ['2'], { timeout: 4000 })
      execFileSync('/bin/launchctl', ['load', MAIN_CHANNELS_PLIST], { timeout: 5000 })
      logger.warn(`Hard restart: launchctl reload of com.${SERVICE_ID}.channels`)
      marveenLastHardRestart = Date.now()
      writeRespawnStamp() // coordinate with the systemd-timer watchdog
      return { ok: true }
    } catch (err) {
      logger.error({ err }, 'Hard restart failed (launchctl)')
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  if (process.platform !== 'linux') {
    logger.warn({ plist: MAIN_CHANNELS_PLIST }, 'Hard restart: launchd channels plist absent -- falling back to respawn-pane')
  }

  // Linux: respawn-pane ONLY -- NEVER `systemctl --user restart`. The channels
  // unit (e.g. marveen-channels.service) runs with KillMode=control-group and
  // the shared tmux SERVER lives in its cgroup, so restarting the unit kills the
  // tmux server and with it EVERY agent session, not just the main one.
  // respawn-pane replaces only the claude process in the main channels pane,
  // leaving the server and all other sessions intact.
  if (respawnMarveenSessionFresh()) {
    marveenLastHardRestart = Date.now()
    return { ok: true }
  }
  return { ok: false, error: 'hard restart failed: tmux respawn-pane failed' }
}

// Escalate a main channel input that survived the full soft recovery to a hard
// restart (respawn-pane). Driven by the pure decideStuckInputRestart; this
// wrapper owns the I/O + counters. Called once per monitor tick right after the
// main stuck-input recovery.
function maybeRestartWedgedMainChannel(state: StuckInputState): void {
  const parked = state.parkedSig !== null
  // A cleared input box ends the spell -> reset the escalation counter so the
  // next genuine wedge starts fresh (and a successful restart is not penalised).
  if (!parked) { stuckRestartCount = 0; return }
  // Busy-guard: never hard-restart while the main pane is actively generating --
  // a parked <channel> block then is a busy session, not a wedge. See
  // applyStuckRestartBusyGuard. detectPaneState reads 'unknown' for an
  // unreadable pane and the guard fails-open on that, so a broken capture never
  // blocks a genuine recovery.
  const paneContent = capturePane(MAIN_CHANNELS_SESSION)
  const paneState = paneContent != null ? detectPaneState(paneContent) : null
  const action = applyStuckRestartBusyGuard(paneState, decideStuckInputRestart(
    parked, state.attempts, MAIN_STUCK_THRESHOLDS.maxAttempts,
    Date.now(), lastStuckRestartAt, stuckRestartCount,
    STUCK_RESTART_MIN_INTERVAL_MS, STUCK_RESTART_MAX_CONSECUTIVE,
  ))
  if (action === 'skip' && shouldDeferKeepaliveRespawn(paneState)) {
    logger.info({ paneState, attempts: state.attempts }, 'Stuck-input restart deferred -- main pane is busy (working, not wedged)')
  }
  if (action === 'skip') return
  if (action === 'alert') {
    logger.error({ session: MAIN_CHANNELS_SESSION }, 'Stuck main channel input survived max restart escalations -- manual intervention needed')
    sendAlert(`⛔ A ${MAIN_CHANNELS_SESSION} bemenete beragadt es ${STUCK_RESTART_MAX_CONSECUTIVE} automatikus respawn-pane sem szabaditotta ki. Kezi beavatkozas kell: inditsd ujra a ${SERVICE_ID}-channels szolgaltatast.`)
    stuckRestartCount++ // tick past the cap so the alert fires only once
    return
  }
  logger.warn({ session: MAIN_CHANNELS_SESSION, attempts: state.attempts, restart: stuckRestartCount + 1 }, 'Stuck main channel input survived soft recovery -- escalating to hard restart (respawn-pane)')
  const r = hardRestartMarveenChannels()
  lastStuckRestartAt = Date.now()
  if (r.ok) {
    stuckRestartCount++
    // Reset the tracker so the fresh post-restart pane is re-evaluated cleanly.
    mainStuckInput = { parkedSig: null, firstSeenAt: null, lastRecoverAt: null, attempts: 0 }
  } else {
    logger.error({ session: MAIN_CHANNELS_SESSION, err: r.error }, 'Stuck-input hard restart failed')
  }
}

// --- Keep-alive staleness watchdog (deafness safety net, decision #3) ---
//
// The keep-alive (a scheduled edit_message round-trip from the channels
// session) touches store/.channel-keepalive on every success. If that file
// goes stale while the session is otherwise process-alive, the MCP stdio pipe
// is likely wedged -> respawn the pane.
//
// LIMITATION (documented on purpose): this staleness net does NOT catch a clean
// inbound-ONLY deafness, where outbound edit_message still succeeds and keeps the
// file fresh while server->claude notifications are dropped. The keep-alive
// PREVENTS that case (warm pipe); the ACTIVE detector for it now ships as
// src/web/inbound-probe.ts (2026-06-01) -- a userbot sends a marker the watchdog
// verifies in the transcript. This staleness path remains the coarse backstop.
const KEEPALIVE_FILE = join(PROJECT_ROOT, 'store', '.channel-keepalive')
const KEEPALIVE_STALE_MS = 18 * 60 * 1000 // ~3 missed 6-min cycles
const KEEPALIVE_RESPAWN_GRACE_MS = 15 * 60 * 1000 // let a respawned session re-establish the file
let marveenLastKeepaliveRespawn = 0

/**
 * Pure decision: should the keepalive respawn be deferred because the
 * main session pane is actively busy?
 *
 * Returns true (defer) for 'busy' | 'typing'.
 * Returns false (proceed) for 'idle' | 'unknown' | 'error' | null.
 *
 * Fail-OPEN on unknown/error/null: a wedged or unreadable pane must still
 * be recoverable. Never block a respawn because we couldn't read the pane.
 */
export function shouldDeferKeepaliveRespawn(
  paneState: PaneState | null
): boolean {
  return paneState === 'busy' || paneState === 'typing'
}

// Pure decision: respawn only when the file EXISTS but has gone stale (a file
// that was once fresh and stopped updating). A missing file means the keep-
// alive hasn't established a baseline yet (fresh boot) -- never respawn on
// absence, or we'd loop before the first keep-alive runs.
export function shouldRespawnForStaleKeepalive(opts: {
  keepaliveAgeMs: number | null
  stalenessThresholdMs: number
  msSinceLastRespawn: number | null
  respawnGraceMs: number
}): boolean {
  if (opts.keepaliveAgeMs == null) return false
  if (opts.msSinceLastRespawn != null && opts.msSinceLastRespawn < opts.respawnGraceMs) return false
  return opts.keepaliveAgeMs > opts.stalenessThresholdMs
}

// SOURCE FIX (2026-06-01): the staleness watchdog's only health signal was the
// scheduled edit_message round-trip, injected into the SAME busy channels
// session. When the session is busy carrying a real conversation, that prompt
// is skipped/stuck, so the keepalive file ages WHILE THE CHANNEL IS PERFECTLY
// ALIVE -- and the watchdog respawned the live conversation in an idle gap.
//
// Real inbound traffic is direct proof the server->claude pipe is alive (it is
// exactly that pipe which dies in a deafness). So the dashboard advances the
// keepalive file's mtime to the timestamp of the last ingested `<channel
// source=` block. Now an active conversation keeps the file warm -- precisely
// when it used to go stale -- while a genuinely silent/deaf session still ages
// out. Both watchdogs (this one + the systemd timer) key off the file mtime, so
// both benefit. The scheduled edit_message round-trip stays as the IDLE-path
// keep-alive (no organic traffic); its busy-skip no longer causes false
// staleness because organic inbound covers the busy case.

// Pure decision: should the keepalive file be advanced to the last-inbound
// timestamp? Only when there IS a last inbound and it is newer than the file
// (never move the mtime backward; the scheduled keepalive may be more recent).
export function shouldRefreshKeepaliveFromInbound(
  lastInboundTs: number | null,
  keepaliveMtimeMs: number,
): boolean {
  return lastInboundTs != null && lastInboundTs > keepaliveMtimeMs
}

// Side-effecting: advance store/.channel-keepalive's mtime to the last ingested
// inbound message time, so live conversation proves the pipe healthy. Best
// effort; never throws into the monitor tick.
function refreshKeepaliveFromInbound(): void {
  try {
    const lastInboundTs = readLastIngestionTimestamp(TRANSCRIPT_DIR)
    let mtimeMs = 0
    try { mtimeMs = statSync(KEEPALIVE_FILE).mtimeMs } catch { /* missing -> 0 */ }
    if (!shouldRefreshKeepaliveFromInbound(lastInboundTs, mtimeMs)) return
    if (!existsSync(KEEPALIVE_FILE)) {
      writeFileSync(KEEPALIVE_FILE, String(Math.floor((lastInboundTs as number) / 1000)))
    }
    const when = new Date(lastInboundTs as number)
    utimesSync(KEEPALIVE_FILE, when, when)
  } catch (err) {
    logger.debug({ err }, 'refreshKeepaliveFromInbound failed (non-fatal)')
  }
}

function checkMainKeepaliveStaleness(): void {
  // SAFETY NET first: let any fresh inbound traffic warm the file before we
  // judge staleness, so a busy-but-alive session is never seen as stale-deaf.
  refreshKeepaliveFromInbound()

  // GROUND-TRUTH SHORTCUT (2026-06-01 21:18 incident): if the channel
  // plugin's bun poller is ALIVE under Marveen's claude pid, the channel
  // is healthy by definition -- Telegram traffic CAN reach us. A stale
  // keepalive file with a live poller is just a quiet conversation, NOT
  // deafness. Respawning here would kill the session for nothing (Szabi
  // got "channel keep-alive 18 perce nem frissült" alerts every 30 min
  // during idle periods, each one losing the running --continue context).
  // The bun-child check is the same liveness signal channel-plugin-unlock
  // already uses; reuse it here so the two paths agree on "alive".
  try {
    const claudePid = getClaudePidForSession(MAIN_CHANNELS_SESSION)
    if (claudePid != null) {
      const provider = getProvider(getMainAgentProvider())
      if (hasChannelPluginAlive(claudePid, provider.type)) {
        logger.debug({ claudePid, provider: provider.type }, 'Keepalive stale but channel plugin is alive -- skipping respawn')
        return
      }
    }
  } catch (err) {
    // Fail-open: if we couldn't probe liveness, fall through to the
    // existing staleness path so a genuinely dead session still recovers.
    logger.debug({ err }, 'Keepalive liveness shortcut probe failed, falling through')
  }

  let ageMs: number | null = null
  try {
    ageMs = Date.now() - statSync(KEEPALIVE_FILE).mtimeMs
  } catch {
    ageMs = null // file missing -> keep-alive not yet established
  }
  const now = Date.now()
  // B2 fix: cross-path grace — use the later of the two respawn timestamps so
  // an inbound-probe respawn also suppresses the keepalive path for the grace window.
  const msSinceLastRespawn = lastMainRespawnAt() ? now - lastMainRespawnAt() : null
  const respawn = shouldRespawnForStaleKeepalive({
    keepaliveAgeMs: ageMs,
    stalenessThresholdMs: KEEPALIVE_STALE_MS,
    msSinceLastRespawn,
    respawnGraceMs: KEEPALIVE_RESPAWN_GRACE_MS,
  })
  if (!respawn) return
  // Busy-guard: do not respawn a pane that is actively processing a turn.
  // capturePane returns null if the pane can't be read; detectPaneState
  // returns 'unknown' for null input — shouldDeferKeepaliveRespawn is
  // fail-open on unknown, so a broken capture never blocks recovery.
  const paneContent = capturePane(MAIN_CHANNELS_SESSION)
  const paneState = paneContent != null ? detectPaneState(paneContent) : null
  if (shouldDeferKeepaliveRespawn(paneState)) {
    logger.info({ paneState }, 'Keepalive stale but pane is busy -- deferring respawn')
    return
  }
  const ageMin = Math.round((ageMs ?? 0) / 60000)
  logger.warn({ ageMs, paneState }, 'Channel keep-alive stale -- main session likely wedged/deaf, respawning via respawn-pane')
  sendAlert(`⚠️ A fő channel keep-alive ${ageMin} perce nem frissült -- respawn-pane a ${MAIN_CHANNELS_SESSION} session-on (a beszelgetes elveszik, memoria marad).`)
  if (respawnMarveenSessionFresh()) {
    marveenLastKeepaliveRespawn = now
    // Suppress the process-down handler during the respawn window (reuses the
    // existing hard-restart grace) so the two recovery paths don't collide.
    marveenLastHardRestart = now
  }
}

export function sendAlert(text: string): void {
  notifyChannel(text).catch(() => {})
}

function handleMarveenDown(): void {
  const now = Date.now()
  const providerLabel = getMainAgentProvider()
  // Cold-start guard: defer the ENTIRE down cascade while a recent respawn
  // (from any recovery path -- keepalive fresh-respawn, stage-3 resume, stage-4
  // hard restart, or the external watchdog's file stamp) is still inside its
  // boot window. lastMainRespawnAt() folds all three timestamps together, so a
  // keepalive respawn that did NOT touch marveenLastHardRestart still suppresses
  // escalation. This is what stops the restart-on-restart stacking that caused
  // the 2026-06-01 480s outage (see MARVEEN_POST_RESPAWN_GRACE_MS).
  const lastRespawn = lastMainRespawnAt()
  if (lastRespawn && now - lastRespawn < MARVEEN_POST_RESPAWN_GRACE_MS) {
    return
  }
  if (!marveenDownState) {
    marveenDownState = { downSince: now, stage: 'soft', lastAlertAt: now, softAttempts: 0 }
    logger.warn({ provider: providerLabel }, 'Marveen channel plugin down -- stage 1 (soft /mcp reconnect, silent)')
    // Diagnostic 409 probe (Telegram only). Fire-and-forget so the sync
    // check-loop is not blocked on a network call. Logs explicitly when the
    // upstream returns the orphan-poller's "terminated by other getUpdates
    // request" message, so dashboard.log carries hard evidence of the real
    // cause instead of leaving the operator to infer it from a pane scan.
    if (providerLabel === 'telegram' && !marveenDownState.conflictProbed) {
      marveenDownState.conflictProbed = true
      const tokenPath = join(channelStateDir(providerLabel, PROJECT_ROOT), '.env')
      const tok = readChannelToken(providerLabel, tokenPath)
      if (tok) {
        probeTelegramConflict(tok)
          .then(r => {
            if (r.conflicted) {
              logger.warn(
                { status: r.status, description: r.description },
                'Telegram getUpdates 409 Conflict confirmed -- orphan poller is contending for the bot token. Recovery will reap and respawn.',
              )
            } else if (r.status > 0) {
              logger.info(
                { status: r.status, description: r.description },
                'Telegram getUpdates returned non-409 status on diagnostic probe -- the down state has a different cause than orphan poller contention',
              )
            }
          })
          .catch(err => {
            logger.warn({ err }, 'Telegram conflict probe failed to complete')
          })
      }
    }
    if (softReconnectMarveen()) marveenDownState.softAttempts += 1
    return
  }
  if (marveenDownState.stage === 'soft') {
    if (marveenDownState.softAttempts < 3 && softReconnectMarveen()) {
      marveenDownState.softAttempts += 1
      marveenDownState.lastAlertAt = now
      return
    }
    marveenDownState.stage = 'save'
    marveenDownState.stageStartedAt = now
    marveenDownState.lastAlertAt = now
    logger.warn({ provider: providerLabel }, 'Marveen channel plugin still down -- stage 2 (memory save)')
    triggerMarveenMemorySave()
    return
  }
  if (marveenDownState.stage === 'save') {
    const saveStartedAt = marveenDownState.stageStartedAt ?? marveenDownState.downSince
    if (now - saveStartedAt < SAVE_WINDOW_MS) return
    marveenDownState.stage = 'resume'
    marveenDownState.stageStartedAt = now
    marveenDownState.lastAlertAt = now
    logger.warn({ provider: providerLabel }, 'Marveen channel plugin still down -- stage 3 (session resume)')
    resumeMarveenSession()
    return
  }
  if (marveenDownState.stage === 'resume') {
    const resumeStartedAt = marveenDownState.stageStartedAt ?? marveenDownState.downSince
    if (now - resumeStartedAt < RESUME_GRACE_MS) return
    marveenDownState.stage = 'hard'
    marveenDownState.stageStartedAt = now
    marveenDownState.lastAlertAt = now
    logger.warn({ provider: providerLabel }, 'Marveen channel plugin still down -- stage 4 (hard restart)')
    const svcName = process.platform === 'linux' ? 'systemctl' : 'launchctl'
    sendAlert(`⚠️ Session resume nem segitett. Hard restart (${svcName}) most a ${MAIN_CHANNELS_SESSION} session-on...`)
    hardRestartMarveenChannels()
    return
  }
  if (marveenDownState.stage === 'hard') {
    marveenDownState.stage = 'gave_up'
    marveenDownState.lastAlertAt = now
    logger.error({ provider: providerLabel }, 'Marveen channel plugin still down after hard restart -- giving up auto-recovery')
    const serviceCmd = process.platform === 'linux'
      ? `\`systemctl --user status ${SERVICE_ID}-channels\``
      : `\`launchctl list | grep ${SERVICE_ID}\``
    // Issue #189: a plain `tmux attach -t ...` may itself fail with "Permission
    // denied" when the operator is running it from another tmux session. Prefix
    // with `unset TMUX` so the hint works in both nested and non-nested cases.
    sendAlert(`🚨 Hard restart SEM segitett. Kezzel kell megnezni: \`unset TMUX && tmux attach -t ${MAIN_CHANNELS_SESSION}\` es ${serviceCmd}.`)
    return
  }
  if (now - marveenDownState.lastAlertAt > PLUGIN_ALERT_DEDUP_MS) {
    marveenDownState.lastAlertAt = now
    sendAlert(`🚨 ${BOT_NAME} ${providerLabel} plugin meg mindig halott. Nezd meg kezzel.`)
  }
}

function handleMarveenUp(): void {
  marveenSuspectFirstSeen = null
  if (marveenDownState) {
    const downedFor = Math.round((Date.now() - marveenDownState.downSince) / 1000)
    const stage = marveenDownState.stage
    const providerLabel = getMainAgentProvider()
    logger.info({ stage, downedFor, provider: providerLabel }, 'Marveen channel plugin recovered')
    if (stage !== 'soft' && stage !== 'save' && stage !== 'resume') {
      sendAlert(`✅ ${BOT_NAME} ${providerLabel} plugin helyrealt (${stage} utan, ${downedFor}s kieses).`)
    }
    marveenDownState = null
  }
}

function shouldEscalateMarveenDown(): boolean {
  const now = Date.now()
  if (marveenSuspectFirstSeen === null) {
    marveenSuspectFirstSeen = now
    return false
  }
  return now - marveenSuspectFirstSeen >= MARVEEN_DOWN_CONFIRM_MS
}

export function startChannelPluginMonitor(): NodeJS.Timeout | null {
  // Respawn/keep-alive is production-only. On any non-production host (e.g. a
  // local dev checkout) we never respawn the main agent or auto-restart
  // sub-agents -- otherwise two machines would fight over the same bot tokens.
  // Applies to ALL agents because the whole monitor loop is skipped here.
  if (!RESPAWN_ENABLED) {
    logger.info({ host: hostname() }, 'Channel plugin monitor disabled (respawn is production-only)')
    return null
  }

  const mainProvider = getMainAgentProvider()

  function check() {
    // Restore persisted failure counts on first tick so a dashboard restart
    // does not reset the cap and restart agents that have already been given up on.
    ensureAgentRestartFailuresInitialized()

    type Target = { session: string; isMarveen: boolean; agentName?: string; provider: ChannelProviderType }
    const targets: Target[] = [{ session: MAIN_CHANNELS_SESSION, isMarveen: true, provider: mainProvider }]
    for (const a of listAgentNames()) {
      if (isAgentRunning(a) && agentHasChannel(a)) {
        targets.push({
          session: agentSessionName(a),
          isMarveen: false,
          agentName: a,
          provider: resolveAgentProvider(a),
        })
      }
    }

    // Pane-level thinking-block error detection. Independent of channel
    // plugin liveness: a session can keep a live plugin yet be wedged on the
    // API error, every injected prompt yielding another 400. Detect it via the
    // pane state and escalate (never auto-reset -- a false positive must not
    // nuke a healthy agent). Escalation mirrors the permission-dialog path:
    // flag the coordinator (mr-wolfe) FIRST so it can restart the corrupt
    // session, and fall back to a direct owner alert only after the grace.
    for (const t of targets) {
      const now = Date.now()
      const pane = capturePane(t.session)
      const isError = pane != null && detectPaneState(pane) === 'error'
      const prev = paneErrorState.get(t.session) ?? { firstSeenAt: null, lastAlertAt: null, lastErrorAt: null }
      const decision = decidePaneErrorAlert(isError, prev, now, {
        confirmMs: PANE_ERROR_CONFIRM_MS,
        dedupMs: PANE_ERROR_DEDUP_MS,
        clearMs: PANE_ERROR_CLEAR_MS,
      })
      if (decision.next.firstSeenAt === null) {
        paneErrorState.delete(t.session)
        // Spell fully cleared: drop the two-phase escalation state too, so a
        // future wedge on this session starts fresh (flags the coordinator
        // promptly instead of inheriting a stale dedup/grace timestamp).
        paneErrorEscalation.delete(t.session)
      } else {
        paneErrorState.set(t.session, decision.next)
      }
      // Drive the escalation off the CONFIRMED error spell on THIS tick, NOT
      // decision.alert. decision.alert is throttled to once per
      // PANE_ERROR_DEDUP_MS (30 min); binding the two-phase escalation to it
      // would make the 6-min owner-fallback grace unmeasurable -- the next
      // escalation check would be a full 30 min away. That is the dedup
      // conflict between decidePaneErrorAlert's 30-min alert-dedup and
      // decideDialogEscalation's 6-min grace. Resolution: decidePaneErrorAlert
      // stays PURELY the confirm+clear-hysteresis gate (flapping protection),
      // and decideDialogEscalation drives dedup+grace on its own map, re-run
      // every ~60s tick while the spell is confirmed (unlike the permission
      // dialog, whose menu-recovery machine re-confirms every ~5 min). Gating
      // on isError -- not just next.firstSeenAt !== null -- keeps the old "alert
      // only while actually wedged" semantics: a clearMs hysteresis tick
      // (error-free but spell still held) must NOT escalate, while the
      // escalation state still survives a one-tick capture flap.
      const spellConfirmed = isError
        && decision.next.firstSeenAt !== null
        && now - decision.next.firstSeenAt >= PANE_ERROR_CONFIRM_MS
      if (spellConfirmed) {
        const label = t.isMarveen ? BOT_NAME : (t.agentName ?? t.session)
        const prevEsc = paneErrorEscalation.get(t.session) ?? { wolfeFlaggedAt: null, gaborNotifiedAt: null }
        if (!t.isMarveen && t.agentName) {
          // Two-phase, sub-agent-scoped: flag the coordinator (mr-wolfe) FIRST
          // via an inter-agent message so it can restart the corrupt session
          // (stop+start -> fresh session); fall back to a DIRECT owner alert
          // only if the coordinator has not resolved it within the grace
          // window. The pure decideDialogEscalation owns the dedup+grace
          // timing; this branch is just the I/O, reusing the permission
          // dialog's shared DIALOG_* constants.
          const esc = decideDialogEscalation(prevEsc, now, {
            graceMs: DIALOG_WOLFE_GRACE_MS,
            dedupMs: DIALOG_ESCALATE_DEDUP_MS,
          })
          paneErrorEscalation.set(t.session, esc.next)
          if (esc.action === 'notify-wolfe') {
            logger.error({ session: t.session, agent: label }, 'Agent wedged on thinking-block API error -- flagging coordinator (mr-wolfe) for manual reset')
            try {
              // from = the wedged sub-agent, to = coordinator: matches the
              // decision-flag.py hook convention so mr-wolfe receives it as a
              // trusted-peer "[Uzenet @<agent>-tol]" flag. t.agentName is a
              // listAgentNames() entry, so it survives sanitizeAgentIdent.
              createAgentMessage(t.agentName, MAIN_AGENT_ID, buildThinkingBlockCoordinatorFlag(label))
            } catch (err) {
              // Router enqueue failed -- do not lose the escalation; fall
              // straight to the direct owner alert.
              logger.warn({ err, session: t.session }, 'Thinking-block coordinator flag enqueue failed -- direct owner fallback')
              sendAlert(buildThinkingBlockOwnerFallback(label))
            }
          } else if (esc.action === 'fallback-gabor') {
            logger.error({ session: t.session, agent: label }, 'Thinking-block wedge unresolved after coordinator grace -- direct owner fallback')
            sendAlert(buildThinkingBlockOwnerFallback(label))
          }
        } else {
          // The main channels session IS the coordinator: it cannot flag itself
          // to restart its own wedge, and a thinking-block-wedged main agent
          // could not act on an inter-agent message anyway. Unlike the
          // permission-dialog case (skip-permissions means main never parks in a
          // dialog), main CAN genuinely hit this error, so keep a single
          // 30-min-throttled DIRECT owner alert as the safety net. Reuses the
          // same map (wolfeFlaggedAt as the throttle stamp) so the cleanup path
          // clears one map, not two.
          if (prevEsc.wolfeFlaggedAt === null || now - prevEsc.wolfeFlaggedAt >= DIALOG_ESCALATE_DEDUP_MS) {
            paneErrorEscalation.set(t.session, { wolfeFlaggedAt: now, gaborNotifiedAt: prevEsc.gaborNotifiedAt })
            logger.error({ session: t.session, agent: label }, 'Main channels session wedged on thinking-block API error -- direct owner alert (no coordinator to delegate to)')
            sendAlert(buildThinkingBlockOwnerFallback(label))
          }
        }
      }
    }

    // Context-budget escalation (main + sub-agents). A pane approaching
    // ("Context low" / "N% until auto-compact") or already at ("100% context
    // used") its ceiling still reads as idle, so the scheduler/router keep
    // dispatching work whose in-flight verdicts/outputs can no longer be trusted
    // (2026-07-12: a sub-agent at 97% context silently dropped four inter-agent
    // messages in both directions). Escalate coordinator-first (mr-wolfe
    // restarts it); the watchdog NEVER auto-restarts (a false positive would
    // nuke a healthy session's context) -- it only RECOMMENDS a restart via
    // POST /api/agents/<name>/restart. Own map + a consecutive-tick confirm so a
    // one-frame capture flake never fires; reuses the shared DIALOG_* grace+dedup.
    for (const t of targets) {
      const now = Date.now()
      const pane = capturePane(t.session)
      const low = pane != null && paneShowsContextLow(pane)
      const saturated = pane != null && paneShowsContextSaturation(pane)
      const signal = low || saturated
      if (!t.isMarveen && t.agentName) {
        // Sub-agent: full two-phase escalation (coordinator first, owner
        // fallback after the grace), behind the confirm-tick flapping guard.
        const prevEsc = paneContextBudgetEscalation.get(t.session) ?? { consecutiveHits: 0, wolfeFlaggedAt: null, gaborNotifiedAt: null }
        const esc = decideContextBudgetEscalation(signal, prevEsc, now, {
          confirmTicks: CONTEXT_BUDGET_CONFIRM_TICKS,
          graceMs: DIALOG_WOLFE_GRACE_MS,
          dedupMs: DIALOG_ESCALATE_DEDUP_MS,
        })
        if (!signal) {
          // Spell over: drop the entry so a future ceiling starts fresh.
          paneContextBudgetEscalation.delete(t.session)
        } else {
          paneContextBudgetEscalation.set(t.session, esc.next)
        }
        const label = t.agentName
        if (esc.action === 'notify-wolfe') {
          logger.warn({ session: t.session, agent: label, saturated }, 'Sub-agent at/near context ceiling -- flagging coordinator (mr-wolfe) to restart')
          try {
            // from = the ceiling-hit sub-agent, to = coordinator: matches the
            // decision-flag.py convention (mr-wolfe receives a trusted-peer flag).
            createAgentMessage(t.agentName, MAIN_AGENT_ID, buildContextBudgetCoordinatorFlag(t.agentName))
          } catch (err) {
            // Router enqueue failed -- do not lose the escalation; fall straight
            // to the direct owner alert.
            logger.warn({ err, session: t.session }, 'Context-budget coordinator flag enqueue failed -- direct owner fallback')
            sendAlert(buildContextBudgetOwnerFallback(label))
          }
        } else if (esc.action === 'fallback-gabor') {
          logger.warn({ session: t.session, agent: label }, 'Sub-agent context ceiling unresolved after coordinator grace -- direct owner fallback')
          sendAlert(buildContextBudgetOwnerFallback(label))
        }
      } else {
        // Main channels session: full saturation is already handled by the
        // dispatch readiness gate (isSessionReadyForPrompt refuses a saturated
        // pane) + the keepalive/down cascade, and the coordinator cannot flag
        // itself to restart. Only the pre-saturation context-LOW warning earns a
        // single deduped DIRECT owner heads-up; re-armed once it clears.
        if (low) {
          if (mainContextLowAlertAt === null || now < mainContextLowAlertAt || now - mainContextLowAlertAt >= DIALOG_ESCALATE_DEDUP_MS) {
            mainContextLowAlertAt = now
            logger.warn({ session: t.session }, 'Main channels session approaching context ceiling -- deduped owner heads-up')
            sendAlert(buildContextBudgetOwnerFallback(BOT_NAME))
          }
        } else {
          mainContextLowAlertAt = null
        }
      }
    }

    // Blocking-menu recovery (main + sub-agents). A session parked in an
    // interactive modal (/mcp manager, model/config picker, permission dialog)
    // is neither busy nor idle, so detectPaneState reads 'unknown' and the
    // scheduler/router silently skip it -- the session goes deaf with nothing
    // alerting (observed: main session sat in /mcp ~6h). A single Escape pops
    // the modal back to the prompt without touching the conversation, so unlike
    // the thinking-block error this is safe to auto-recover. Same debounce
    // machine as the error pass (alert == "recover now") so a one-tick frame
    // never fires and the Escape is not re-sent every tick.
    for (const t of targets) {
      const pane = capturePane(t.session)
      const inMenu = pane != null && detectsBlockingMenu(pane)
      const prev = paneMenuState.get(t.session) ?? { firstSeenAt: null, lastAlertAt: null, lastErrorAt: null }
      const decision = decidePaneErrorAlert(inMenu, prev, Date.now(), {
        confirmMs: MENU_RECOVER_CONFIRM_MS,
        dedupMs: MENU_RECOVER_DEDUP_MS,
        clearMs: MENU_RECOVER_CLEAR_MS,
      })
      if (decision.next.firstSeenAt === null) {
        paneMenuState.delete(t.session)
        // Modal fully cleared: reset the two-phase dialog-escalation state
        // (coordinator-flag + owner-fallback timestamps) so a future dialog on
        // this session starts as a fresh spell rather than inheriting a stale
        // one -- phase 1 flags the coordinator promptly instead of being
        // throttled by a previous spell's timestamp.
        paneDialogEscalation.delete(t.session)
        // The limit-dialog throttle is stickier: a model-fallback respawn
        // clears the menu spell mid-window (fresh pane, no modal yet) while
        // the limit itself still holds, so clearing here unconditionally would
        // re-arm the alert on every respawn cycle -- the very noise the
        // throttle exists to stop. Reset only once the pane also stopped
        // showing the limit banner (the window is genuinely over). A failed
        // capture cannot prove that, so it keeps the throttle; a stale entry
        // ages out via LIMIT_DIALOG_ALERT_DEDUP_MS anyway.
        if (pane != null && !detectsUsageLimit(pane)) {
          paneLimitDialogAlertAt.delete(t.session)
        }
      } else {
        paneMenuState.set(t.session, decision.next)
      }
      if (decision.alert) {
        const label = t.isMarveen ? BOT_NAME : (t.agentName ?? t.session)
        // D1: a permission/tool-approval dialog has the same navigable-modal
        // footer as a /mcp menu, but Escape there REJECTS the pending tool call
        // and aborts the turn -- it is NOT the safe "close modal, conversation
        // untouched" that the menu recovery assumes. Never auto-Escape it;
        // escalate to a human, who can approve/deny deliberately.
        if (pane != null && detectsPermissionDialog(pane)) {
          // Escape-suppression is unconditional. Escalation is two-phase and
          // sub-agent-scoped: flag the coordinator (mr-wolfe) FIRST via an
          // inter-agent message, and only fall back to a direct owner alert if
          // the coordinator has not cleared the dialog within the grace window.
          // The pure decideDialogEscalation owns the timing (dedup + grace);
          // this branch is just the I/O.
          const prevEsc = paneDialogEscalation.get(t.session) ?? { wolfeFlaggedAt: null, gaborNotifiedAt: null }
          if (!t.isMarveen && t.agentName) {
            const esc = decideDialogEscalation(prevEsc, Date.now(), {
              graceMs: DIALOG_WOLFE_GRACE_MS,
              dedupMs: DIALOG_ESCALATE_DEDUP_MS,
            })
            paneDialogEscalation.set(t.session, esc.next)
            if (esc.action === 'notify-wolfe') {
              logger.warn({ session: t.session, agent: label }, 'Session parked in a permission dialog -- NOT sending Escape, flagging coordinator (mr-wolfe)')
              try {
                // from = the stuck sub-agent, to = coordinator: matches the
                // decision-flag.py hook convention, so mr-wolfe receives it as a
                // trusted-peer "[Uzenet @<agent>-tol]" flag. t.agentName is a
                // listAgentNames() entry (already used as an agent id by the
                // menu-recovery nudge below), so it survives sanitizeAgentIdent.
                createAgentMessage(t.agentName, MAIN_AGENT_ID, buildDialogCoordinatorFlag(label))
              } catch (err) {
                // Router enqueue failed -- do not lose the escalation; fall
                // straight to the direct owner alert so a stuck dialog is never
                // silently dropped.
                logger.warn({ err, session: t.session }, 'Permission-dialog coordinator flag enqueue failed -- direct owner fallback')
                sendAlert(buildDialogOwnerFallback(label))
              }
            } else if (esc.action === 'fallback-gabor') {
              logger.warn({ session: t.session, agent: label }, 'Permission dialog unresolved after coordinator grace -- direct owner fallback')
              sendAlert(buildDialogOwnerFallback(label))
            }
          } else {
            // Main channels session runs --dangerously-skip-permissions and so
            // never actually reaches here; if it ever did, the coordinator
            // cannot delegate its own dialog to itself. Keep a single
            // 30-min-throttled DIRECT owner alert as a defensive net, reusing
            // the same map (wolfeFlaggedAt as the throttle stamp) so the
            // cleanup path clears one map, not two.
            if (prevEsc.wolfeFlaggedAt === null || Date.now() - prevEsc.wolfeFlaggedAt >= DIALOG_ESCALATE_DEDUP_MS) {
              paneDialogEscalation.set(t.session, { wolfeFlaggedAt: Date.now(), gaborNotifiedAt: prevEsc.gaborNotifiedAt })
              logger.warn({ session: t.session, agent: label }, 'Main channels session parked in a permission dialog -- direct owner alert (no coordinator to delegate to)')
              sendAlert(buildDialogOwnerFallback(label))
            }
          }
        } else {
          paneDialogEscalation.delete(t.session)
          // The Claude plan limit modal ("You've hit your session limit ·
          // resets 3:10am") wears the same navigable-modal footer as a genuine
          // menu, so the canned "(pl. /mcp)" alert misdiagnosed it (observed
          // 2026-07-05 23:00). When the pane also shows the limit banner, name
          // the real cause + the reset time; the Escape recovery itself is
          // identical in both cases and stays unconditional.
          const limitDialog = pane != null && detectsUsageLimit(pane)
          logger.warn({ session: t.session, agent: label }, limitDialog
            ? 'Session parked in the plan usage-limit dialog -- sending Escape to recover'
            : 'Session parked in a blocking interactive menu -- sending Escape to recover')
          try {
            execFileSync(TMUX, ['send-keys', '-t', t.session, 'Escape'], { timeout: 5000 })
          } catch (err) {
            logger.warn({ err, session: t.session }, 'Menu-recovery Escape failed')
          }
          // At most ONE operator alert + resume nudge per session per limit
          // window: each model-fallback respawn re-hits the plan-wide limit
          // and re-parks the pane, and the 5-min menu dedup restarts with the
          // spell, so it re-alerted every cycle (5 alerts in the 35-min window
          // on 2026-07-05). The Escape above is the recovery and stays
          // per-cycle; only the messaging is throttled. Genuine menus keep
          // today's cadence (notify stays true).
          let notify = true
          if (limitDialog) {
            const lastLimitAlert = paneLimitDialogAlertAt.get(t.session) ?? 0
            notify = Date.now() - lastLimitAlert >= LIMIT_DIALOG_ALERT_DEDUP_MS
            if (notify) paneLimitDialogAlertAt.set(t.session, Date.now())
          }
          if (notify) {
            if (limitDialog) {
              // extractLimitReset only ever yields a tight clock-time shape, so
              // interpolating this pane-derived value into the alert is safe.
              const reset = pane == null ? null : extractLimitReset(pane)
              sendAlert(`⏳ A(z) ${label} session a plan usage-limit dialogusaban all (nem menu-beragadas). Escape kikuldve. A limit varhato visszaallasa: ${reset ?? 'ismeretlen'}. A model-fallback kezeli, kulon teendo nincs.`)
            } else {
              sendAlert(`⌨️ A(z) ${label} session beragadt egy interaktiv menube (pl. /mcp) es nem dolgozott fel uzeneteket. Kikuldtem egy Escape-et, visszateritettem a prompthoz. Ha ismetlodik: tmux attach -t ${t.session}`)
            }
            // D2: for a sub-agent, nudge the session so a turn the Escape may have
            // interrupted actually resumes -- otherwise it can sit idle silently.
            // Routed as a main-agent inter-agent message (trusted-peer), so it
            // reuses the session-ready / cold-start-hold delivery guards. Within
            // a limit window the nudge shares the alert throttle: a limited agent
            // cannot act on it, so five per window were pure queue noise.
            if (!t.isMarveen && t.agentName) {
              try {
                createAgentMessage(MAIN_AGENT_ID, t.agentName, MENU_RECOVER_NUDGE)
              } catch (err) {
                logger.warn({ err, session: t.session }, 'Menu-recovery nudge enqueue failed')
              }
            }
          }
        }
      }
    }

    // Stuck channel-input recovery (main + sub-agents). Recover a channel
    // notification stranded at the ❯ prompt by getting it SUBMITTED. The gate
    // (parkedChannelInput != null) fires ONLY for a parked <channel> block, so
    // a human's own hand-typed draft is never touched. Enter-first (faithful);
    // escalate to clear+re-inject only after MAIN_STUCK_ENTER_ATTEMPTS, and
    // only when the captured block looks COMPLETE -- a truncated capture stays
    // on Enter rather than risk a partial re-inject to the wrong chat_id.
    mainStuckInput = recoverStuckInputForSession(MAIN_CHANNELS_SESSION, mainStuckInput, MAIN_STUCK_THRESHOLDS, false)
    // Reliable backstop: if the soft recovery is exhausted and the input is
    // STILL parked, the TUI is hard-wedged -- escalate to a respawn-pane (the
    // automated form of the manual `systemctl restart channels`). Rate-limited.
    maybeRestartWedgedMainChannel(mainStuckInput)
    // Same recovery for every running sub-agent session: a parked channel
    // message wedges a sub-agent ("nem válaszol") exactly as it would the main
    // session. Per-session state lives in agentStuckInput; drop it once the
    // spell ends so the map never grows unbounded.
    for (const t of targets) {
      if (t.isMarveen) continue
      const prev = agentStuckInput.get(t.session) ?? { parkedSig: null, firstSeenAt: null, lastRecoverAt: null, attempts: 0 }
      const next = recoverStuckInputForSession(t.session, prev, MAIN_STUCK_THRESHOLDS, true)
      if (next.parkedSig === null) agentStuckInput.delete(t.session)
      else agentStuckInput.set(t.session, next)
    }

    for (const t of targets) {
      const claudePid = getClaudePidForSession(t.session)
      if (!claudePid) {
        if (!t.isMarveen && t.agentName) {
          const lastRestart = agentLastRestart.get(t.agentName)
          if (lastRestart && Date.now() - lastRestart < AGENT_RESTART_GRACE_MS) continue
        }
        if (t.isMarveen) {
          // The claude pid is gone. WHY decides recovery: a session that no
          // longer exists at all must be recreated from scratch (respawn-pane,
          // the only tool the down-cascade has on Linux, cannot resurrect a
          // vanished session); a session that still exists with a dead/wedged
          // claude is the down-cascade's job. Without this split a crashed,
          // self-updated or rebooted main session never returns on installs
          // with no supervising service, and every scheduled main-agent task
          // silently skips (scheduler !sessionExists branch).
          if (!mainChannelsSessionExists()) {
            if (shouldEscalateMarveenDown() && createMainChannelsSession()) {
              marveenDownState = null
              marveenSuspectFirstSeen = null
            }
          } else if (shouldEscalateMarveenDown()) {
            handleMarveenDown()
          }
        }
        continue
      }
      const alive = hasChannelPluginAlive(claudePid, t.provider, t.agentName)
      if (alive) {
        if (t.isMarveen) {
          handleMarveenUp()
          // Process-alive does NOT prove the inbound MCP pipe is healthy (the
          // deafness blind spot). Cross-check the keep-alive freshness.
          checkMainKeepaliveStaleness()
        } else {
          if (agentDownSince.has(t.session)) {
            logger.info({ session: t.session, provider: t.provider }, 'Agent channel plugin recovered')
            agentDownSince.delete(t.session)
          }
          // Healthy observation clears the exponential back-off so the next
          // down-spell starts again at the base grace.
          agentRestartFailures.delete(t.agentName!)
          clearPersistedAgentFailures(t.agentName!)
          // Retire any stale absent verdict too, so a future down-spell starts
          // with the full restart budget rather than the absent-capped one.
          clearPluginAbsent(t.session)
        }
        continue
      }
      if (t.isMarveen) {
        if (shouldEscalateMarveenDown()) handleMarveenDown()
      } else {
        // Host-overload guard (2026-07-16 incident): with 1-min load ~11 on 8
        // cores every spawnSync in this process (the ps liveness probe, sleep,
        // tmux) hit ETIMEDOUT, healthy plugins read as "down", and the
        // resulting fresh restarts both wiped agent context and fed the load
        // spiral (one restart attempt itself died on ETIMEDOUT). A "down"
        // reading taken on a thrashing host is unreliable -- defer the whole
        // down-path until load subsides; a genuinely dead plugin is picked up
        // by the next calm sweep.
        if (hostOverloaded()) {
          logger.warn({ agent: t.agentName, provider: t.provider, load1: loadavg()[0], cores: availableParallelism() }, 'Channel plugin probe reports down but host is overloaded -- deferring (probe unreliable under load)')
          continue
        }
        // Marketplace-stall guard (2026-07-03 second incident): while the
        // plugin init is provably still in flight (no bun poller AND no
        // plugin-cache .in_use marker yet -- a stalled official-marketplace
        // refresh serialised one observed init to 11.5 minutes), a restart
        // would tear down a session that is about to come up healthy and
        // re-enter the same stall with the context lost. Defer until the init
        // resolves either way or the 15-min wedged-claude ceiling passes.
        if (channelPluginInitPending(claudePid, getProcessAgeMs(claudePid))) {
          logger.info({ agent: t.agentName, provider: t.provider, claudePid }, 'Channel plugin probe reports down but plugin init is still pending (no bun, no .in_use marker) -- deferring')
          continue
        }
        // Intentional-stop guard (5e67f632): /api/agents/<name>/stop removes
        // the agent from agents-desired.json precisely so it stays down, but
        // this down-path used to resurrect it anyway (fresh:true, context
        // lost) because the plugin's disappearance looked like a crash. Honor
        // the desired state here. An empty desired set means the feature is
        // not in use (mirrors reconcileDesiredAgents), so only guard when the
        // operator has an explicit desired list.
        {
          const desired = getDesiredAgents()
          if (desired.size > 0 && !desired.has(t.agentName!)) {
            logger.info({ agent: t.agentName, provider: t.provider }, 'Channel down but agent was intentionally stopped (not in desired state) -- not restarting')
            agentDownSince.delete(t.session)
            continue
          }
        }
        if (!agentDownSince.has(t.session)) agentDownSince.set(t.session, Date.now())
        const lastRestart = agentLastRestart.get(t.agentName!)
        const failures = agentRestartFailures.get(t.agentName!) ?? 0
        // If the unlock probe confirmed the plugin ABSENT from /mcp (never
        // loaded), fresh-restarting cannot fix it -- cap the budget at one
        // attempt so we escalate to the operator instead of nuking the agent's
        // context 5x. A merely Failed/disabled plugin (still in the list) keeps
        // the full budget: a restart genuinely helps that case.
        const absentConfirmed = wasPluginConfirmedAbsent(t.session, PLUGIN_ABSENT_TTL_MS)
        const maxRestartAttempts = absentConfirmed
          ? PLUGIN_ABSENT_MAX_RESTART_ATTEMPTS
          : AGENT_MAX_RESTART_ATTEMPTS
        const action = decideDownAgentAction({
          processAgeMs: getProcessAgeMs(claudePid),
          msSinceLastRestart: lastRestart != null ? Date.now() - lastRestart : null,
          startupGraceMs: AGENT_STARTUP_GRACE_MS,
          restartGraceMs: AGENT_RESTART_GRACE_MS,
          consecutiveFailures: failures,
          maxRestartGraceMs: AGENT_MAX_RESTART_GRACE_MS,
        }, maxRestartAttempts)
        if (action === 'skip') {
          logger.debug({ agent: t.agentName, provider: t.provider, failures }, 'Channel plugin probe reports down but agent is within startup/restart back-off -- deferring')
          continue
        }
        if (action === 'alert') {
          // The cap is reached: restarting is not bringing the plugin back, and
          // each restart costs the agent its whole session context. Stop the
          // loop and hand it to a human. Tick the counter past the cap so this
          // fires exactly once; a later healthy sweep resets it (re-arming the
          // alert for a future down-spell).
          logger.error({ agent: t.agentName, provider: t.provider, failures, absentConfirmed }, 'Agent channel plugin down after max restart attempts -- giving up, alerting operator')
          sendAlert(absentConfirmed
            ? `⛔ A(z) ${t.agentName} agens ${t.provider} plugin-je BE SEM TOLTODOTT (absent a /mcp listabol), a fresh-restart ezt nem javitja -- tovabb nem probalom (minden restart elveszi a session kontextusat). Kezi TISZTA ujrainditas kell (uresen, mas agens indulasaval nem atlapolva): ${t.session}.`
            : `⛔ A(z) ${t.agentName} agens ${t.provider} csatornaja ${AGENT_MAX_RESTART_ATTEMPTS} automatikus ujrainditas utan sem allt helyre. Tovabb nem indinitom ujra (minden restart elveszi a session kontextusat). Kezi beavatkozas kell: nezd meg a ${t.session} session-t es a ${SERVICE_ID} csatorna-plugint.`)
          agentRestartFailures.set(t.agentName!, failures + 1)
          savePersistedAgentFailures(t.agentName!, failures + 1)
          agentDownSince.delete(t.session)
          continue
        }
        const agentProvider = resolveAgentProvider(t.agentName!)
        const stateDir = channelStateDir(agentProvider, agentDir(t.agentName!))
        const agentToken = readChannelToken(agentProvider, join(stateDir, '.env'))
        if (!agentToken) {
          logger.warn({ agent: t.agentName, provider: agentProvider }, 'Agent has no channel token in state dir -- skipping restart to avoid token conflict')
          continue
        }
        // Stagger: only one channel-down restart per CHANNEL_RESTART_STAGGER_MS
        // fleet-wide, so fresh sub-agent cold-boots serialise instead of racing.
        if (Date.now() - lastChannelAgentRestartAt < CHANNEL_RESTART_STAGGER_MS) {
          logger.debug({ agent: t.agentName }, 'Channel-down restart staggered -- deferring to avoid simultaneous cold-boot race')
          continue
        }
        logger.warn({ agent: t.agentName, provider: t.provider, failures }, 'Agent channel plugin down -- auto-restarting')
        try {
          stopAgentProcess(t.agentName!)
          // Settle before the fresh start. stopAgentProcess already reaps this
          // agent's channel orphans + waits 2s; add more so the shared plugin
          // cache (bun run --cwd <plugin>, .in_use markers) fully releases from
          // the torn-down claude before the new one loads the plugin. A too-short
          // gap is the suspected trigger for the plugin coming up ABSENT on a
          // rapid restart (2026-07-01 rocket/mantis loop). Fleet-wide staggering
          // (CHANNEL_RESTART_STAGGER_MS) means this extra block runs at most once
          // per 90s, so it does not stall the monitor's per-agent sweep.
          execSync('sleep 8', { timeout: 10000 })
          lastChannelAgentRestartAt = Date.now()
          // FRESH (no --continue): on CC 2.1.193 a --continue resume does NOT load
          // the --channels plugin MCP server, so the agent comes up with no plugin
          // and no poller (verified: continue -> "Plugin not found" in /mcp; fresh
          // -> plugin loads + poller attaches). Context is dropped, memory persists.
          startAgentProcess(t.agentName!, { fresh: true })
          agentLastRestart.set(t.agentName!, Date.now())
          agentDownSince.delete(t.session)
          // Count this restart as failed until a later sweep sees the plugin
          // alive (which resets the counter). Repeated failures back off the
          // next restart exponentially instead of churning every base-grace.
          // Persisted to disk so a dashboard restart does not reset the counter.
          agentRestartFailures.set(t.agentName!, failures + 1)
          savePersistedAgentFailures(t.agentName!, failures + 1)
        } catch (err) {
          logger.error({ err, agent: t.agentName }, 'Failed to auto-restart agent after channel plugin down')
        }
      }
    }

    // In-process pending-age watchdog (independent of any agent session). The
    // wedge escalation itself flows through agent_messages, so when THAT queue
    // silently starves (2026-07-12: four messages pending 10+ min in BOTH
    // directions, including a coordinator-bound pull-model message) the
    // escalation dies with it. Read the queue DIRECTLY and alert the owner via
    // sendAlert (NEVER agent_messages -- that is the failing channel). Include
    // coordinator-bound (pull-model) messages: they are exactly the ones that
    // silently starve. One alert per stuck episode; re-armed when the backlog
    // clears. Wrapped so a DB hiccup can never break the rest of the monitor tick.
    try {
      const pending = getPendingMessages()
      const nowMs = Date.now()
      const agesMs = pending.map((m) => nowMs - m.created_at * 1000)
      if (!agesMs.some((a) => a > PENDING_AGE_ALERT_THRESHOLD_MS)) {
        // Backlog below threshold: re-arm so the next episode alerts promptly.
        pendingAgeLastAlertAt = null
      } else if (
        decidePendingAgeAlert(agesMs, pendingAgeLastAlertAt, nowMs, PENDING_AGE_ALERT_THRESHOLD_MS, PENDING_AGE_ALERT_DEDUP_MS) ||
        // Ceiling RE-ARM: once the OLDEST row out-waits the ceiling the episode is
        // wedged-and-worsening, so escalate INSIDE the routine dedup window (at the
        // faster PENDING_AGE_REALERT_DEDUP_MS cadence, self-throttled off the same
        // pendingAgeLastAlertAt stamp so it never storms).
        decidePendingAgeRealert(Math.max(...agesMs), pendingAgeLastAlertAt, nowMs, PENDING_AGE_REALERT_CEILING_MS, PENDING_AGE_REALERT_DEDUP_MS)
      ) {
        // Busy-vs-wedged discrimination (2026-07-13 09:00 false alarm): a
        // target that is ACTIVELY WORKING holds its inbox until the turn ends
        // by design -- that is latency, not starvation. Classify each stuck
        // row's target pane and alert only on rows whose target is not a
        // healthy-busy session; a hard ceiling re-includes even busy targets
        // (an endless turn starves the queue just as dead as a wedge). One
        // capture per distinct target session, cached for this pass.
        const stuckAll = pending
          .map((m) => ({ m, ageMs: nowMs - m.created_at * 1000 }))
          .filter((x) => x.ageMs > PENDING_AGE_ALERT_THRESHOLD_MS)
          .sort((a, b) => b.ageMs - a.ageMs)
        const paneCache = new Map<string, { state: string | null; wedge: boolean; procAgeMs: number | null }>()
        const classifyTarget = (toAgent: string): { state: string | null; wedge: boolean; procAgeMs: number | null } => {
          const session = toAgent === MAIN_AGENT_ID ? MAIN_CHANNELS_SESSION : agentSessionName(toAgent)
          const cached = paneCache.get(session)
          if (cached) return cached
          const pane = capturePane(session)
          const out = pane == null
            ? { state: null, wedge: false, procAgeMs: null } // unreadable -> fail-open (alerts)
            : {
                state: detectPaneState(pane),
                wedge: parkedInputText(pane) != null || paneShowsContextLow(pane) || paneShowsContextSaturation(pane),
                procAgeMs: paneProcessAgeMs(session),
              }
          paneCache.set(session, out)
          return out
        }
        const stuck = stuckAll.filter((x) => {
          const t = classifyTarget(x.m.to_agent)
          // Boot-grace: a just-(re)started target holds its inbox while claude
          // boots -- suppress like healthy-busy, but never past the hard
          // ceiling and never over a wedge signal (2026-07-22 14:59 false alarm).
          if (!t.wedge && x.ageMs <= PENDING_AGE_ALERT_HARD_CEILING_MS
              && isTargetInBootGrace(t.procAgeMs, PENDING_AGE_BOOT_GRACE_MS)) return false
          return shouldAlertStuckTarget(t.state, t.wedge, x.ageMs, PENDING_AGE_ALERT_HARD_CEILING_MS)
        }).slice(0, 5)
        if (stuck.length === 0) {
          // Every stuck row's target is healthy-busy: benign latency. Do NOT
          // bump the dedup stamp -- if a target wedges (or the ceiling passes)
          // on a later tick, the alert must fire promptly, not wait out a
          // window consumed by a suppressed non-alert.
          logger.info({ suppressed: stuckAll.length }, 'Pending-age watchdog: all stuck targets are busy-working (no wedge signal) -- alert suppressed')
        } else {
          pendingAgeLastAlertAt = nowMs
          // List up to the 5 oldest alert-worthy rows (id, from→to, minutes pending).
          const list = stuck.map((x) => `#${x.m.id} ${x.m.from_agent}→${x.m.to_agent} (${Math.floor(x.ageMs / 60000)}p)`).join(', ')
          const thresholdMin = Math.floor(PENDING_AGE_ALERT_THRESHOLD_MS / 60000)
          const oldestMin = Math.floor(stuck[0].ageMs / 60000)
          // Escalation wording is SEVERITY-driven (oldest past the ceiling), not
          // cadence-driven: a routine-cadence re-alert on a 45+ min backlog is
          // still an escalation. Past the ceiling this is a wedge, not latency.
          const escalation = stuck[0].ageMs > PENDING_AGE_REALERT_CEILING_MS
          logger.error({ stuck: stuck.length, oldestMin, escalation }, 'Inter-agent message queue starving -- pending rows past age threshold')
          sendAlert(escalation
            ? `⛔ ESZKALACIO -- az inter-agent uzenetsor MEG MINDIG akad: ${stuck.length} uzenet, a legregebbi ${oldestMin} perce pending (tullepte a ${Math.floor(PENDING_AGE_REALERT_CEILING_MS / 60000)} perces plafont). Legidosebbek: ${list}. Ez mar nem lassulas hanem beragadas -- nezd meg a dashboard uzenetsort / a cel-agens sessiont.`
            : `⛔ Az inter-agent uzenetsor akad: ${stuck.length} uzenet ${thresholdMin}+ perce pending, es a cel-agent NEM dolgozik epp (vagy wedge-jelet mutat). Legidosebbek: ${list}. Nezd meg a dashboard uzenetsort.`)
        }
      }
    } catch (err) {
      logger.warn({ err }, 'channel-monitor: pending-age watchdog pass failed')
    }

    // Desired-state reconciliation: bring back agents the operator wants
    // running but whose tmux session vanished entirely (shared tmux server
    // killed by a channels-unit restart, or a machine reboot). The per-target
    // loop above only handles sessions that still exist with a dead plugin.
    // Staggered to avoid the simultaneous-start race that kills agents.
    void reconcileDesiredAgents()

    // Periodic detached-channel-claude reap (CB6CF755). Throttled; reuses the
    // respawn-time reaper so orphans accumulating between respawns are cleaned
    // up on a slow cadence too. Fail-safe + pane-guarded inside the reaper.
    if (shouldRunPeriodicReap(lastDetachedReapAt, Date.now(), DETACHED_REAP_INTERVAL_MS)) {
      lastDetachedReapAt = Date.now()
      try {
        const reaped = reapDetachedChannelClaudes({ tmuxPath: TMUX })
        if (reaped.length > 0) {
          logger.warn({ reaped }, 'channel-monitor: periodic reap removed detached channel-claude orphans')
        }
      } catch (err) {
        logger.warn({ err }, 'channel-monitor: periodic detached-claude reap failed')
      }
    }
  }
  setTimeout(check, 30000)
  return setInterval(check, 60000)
}

// Start desired-but-missing agents one at a time (~15s apart). The stagger is
// mandatory: starting several channel agents at once makes them all die in the
// resume-from-summary modal race. A single in-flight burst at a time.
let reconcileBurstInProgress = false
const AGENT_RECONCILE_STAGGER_MS = 15000
function delay(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }

async function reconcileDesiredAgents(): Promise<void> {
  if (reconcileBurstInProgress) return
  const desired = getDesiredAgents()
  if (desired.size === 0) return
  const down = [...desired].filter((name) => !isAgentRunning(name))
  if (down.length === 0) return
  reconcileBurstInProgress = true
  try {
    for (const name of down) {
      if (isAgentRunning(name)) continue
      const last = agentLastRestart.get(name)
      if (last != null && Date.now() - last < AGENT_RESTART_GRACE_MS) continue
      logger.warn({ agent: name }, 'Desired agent not running -- auto-starting (reconcile)')
      try {
        const r = startAgentProcess(name)
        agentLastRestart.set(name, Date.now())
        if (!r.ok && r.error !== 'Agent is already running') {
          logger.error({ agent: name, error: r.error }, 'Reconcile start failed')
        }
      } catch (err) {
        logger.error({ err, agent: name }, 'Reconcile start threw')
      }
      await delay(AGENT_RECONCILE_STAGGER_MS)
    }
  } finally {
    reconcileBurstInProgress = false
  }
}

// Backward-compatible alias
export const startTelegramPluginMonitor = startChannelPluginMonitor
