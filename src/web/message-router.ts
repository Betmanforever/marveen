import { logger } from '../logger.js'
import { MAIN_AGENT_ID } from '../config.js'
import { resolveAgentChannelStateDir } from './voice-directive.js'
import {
  getPendingMessages,
  markMessageDelivered,
  markMessageFailed,
} from '../db.js'
import { readAgentRemoteHost, readAgentVoiceConfig } from './agent-config.js'
import {
  agentSessionName,
  channelColdStartHoldActive,
  isSessionReadyForPrompt,
  clearInputBuffer,
  clearStaleParkedInput,
  sendPromptToSession,
  sessionExistsOnHost,
  type SendResult,
} from './agent-process.js'
import { setLastInboundModality } from './voice-modality.js'
import { classifyAgentMessage, wrapAgentMessageForDelivery } from './agent-message-wrap.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'

// A message that cannot be delivered within this window (target session never
// exists / stays busy) is marked failed so it stops clogging the pending
// queue and we stop re-scanning it forever. Matches the scheduled-task retry
// window so a long turn that ate one also eats the other.
const MESSAGE_ABANDON_WINDOW_MS = 60 * 60 * 1000
// How long a message must have waited before the stale-parked-input janitor is
// allowed to clear the receiver's input box. Long enough that a brief, genuine
// "agent parked a draft it is about to submit" never gets clobbered; short
// enough that a wedged channel recovers within ~a minute instead of forever.
const JANITOR_PARKED_MIN_AGE_MS = 45 * 1000
// Log "skipping, target not ready" at most once per message id so a busy
// receiver over many 5s ticks does not spam the log.
const routerLoggedMisses: Set<number> = new Set()

/**
 * Pure decision: should a pending inter-agent message be abandoned?
 *
 * Abandon ONLY when the target session has been ABSENT for the full retry
 * window. A session that EXISTS (even if busy or mid-turn) is never hard-
 * abandoned -- it keeps retrying until an idle gap delivers the message.
 *
 * The previous inline code checked `ageMs > window` BEFORE the session-
 * existence check, which abandoned messages to an alive-but-busy main
 * session at the 1h mark even though the session was continuously running
 * (incident: two reports lost while the session was busy).
 *
 * @param sessionExists Whether the target tmux session is currently alive.
 * @param ageMs         How long the message has been pending (ms).
 * @param windowMs      The abandon window threshold (ms).
 */
export function shouldAbandon(sessionExists: boolean, ageMs: number, windowMs: number): boolean {
  return !sessionExists && ageMs > windowMs
}

/**
 * Pure decision: given the outcome of a sendPromptToSession call, should the
 * router mark the message delivered, or leave it pending for a later retry?
 *
 *   - 'landed'  -> 'delivered': the send loop saw POSITIVE evidence the prompt
 *                               landed -- a real turn started, the payload echoed
 *                               into the transcript, or the box stayed provably
 *                               clean across the whole retry budget (4fddd480).
 *                               Mark the message delivered, as before.
 *   - 'gave-up' -> 'retry':     the retry budget was spent WITHOUT that positive
 *                               evidence -- the text is still parked, or the box
 *                               holds unexplained (bracketed-paste-mutated)
 *                               content. Marking it delivered here is the
 *                               "delivered != landed" bug (2026-07-08: a
 *                               parked-unsubmitted message read delivered=true;
 *                               2026-07-13 msg 1105: a mutated parked box read
 *                               landed). Leave it pending instead.
 *
 * Kept pure so the router's tmux/db-bound loop stays trivially testable: feed a
 * SendResult in, assert the outcome out.
 */
export function decideDeliveryOutcome(sendResult: SendResult): 'delivered' | 'retry' {
  return sendResult === 'landed' ? 'delivered' : 'retry'
}

/**
 * Pure decision: should a message whose send GAVE UP be hard-abandoned now?
 *
 * shouldAbandon() abandons only an ABSENT session, so a PRESENT-but-persistently
 * -stuck session would keep a gave-up message pending forever -- a fresh send
 * every 5s tick with no exit. This bounds that: once a gave-up message has
 * out-waited the full retry window it is abandoned regardless of session
 * presence, so the delivered!=landed fix cannot trade a false-delivered for an
 * eternal-retry regression. Strict greater-than mirrors shouldAbandon's
 * boundary (ageMs === windowMs is NOT yet abandoned).
 */
export function shouldAbandonGaveUp(ageMs: number, windowMs: number): boolean {
  return ageMs > windowMs
}

/**
 * Pure decision: should the in-process pending-age watchdog fire a DIRECT owner
 * alert now? True iff any pending message has out-waited `thresholdMs` AND the
 * dedup window has elapsed since the last alert. Returns false when nothing is
 * over threshold so the CALLER re-arms (sets lastAlertAt = null) as the backlog
 * clears -- the next stuck episode then alerts promptly.
 *
 * This backstops the queue that the wedge-escalation itself flows through: on
 * 2026-07-12 four inter-agent messages sat pending 10+ min in BOTH directions
 * (including a coordinator-bound pull-model message) with nothing alarming,
 * because the escalation path is the same agent_messages queue that had
 * starved. The watchdog reads the queue directly and NEVER writes to
 * agent_messages, so it survives that queue wedging.
 *
 * A future-dated lastAlertAt (clock skew / NTP correction) counts as "alert now"
 * rather than stalling the delta negative, mirroring the other decision guards.
 */
export function decidePendingAgeAlert(
  pendingAgesMs: number[],
  lastAlertAt: number | null,
  now: number,
  thresholdMs: number,
  dedupMs: number,
): boolean {
  if (!pendingAgesMs.some((age) => age > thresholdMs)) return false
  if (lastAlertAt === null) return true
  if (now < lastAlertAt) return true
  return now - lastAlertAt >= dedupMs
}

/**
 * Pure decision: does a stuck pending message's TARGET state warrant an owner
 * alert, or is the delay benign? A pull-model/push target that is ACTIVELY
 * WORKING (busy pane, no wedge signals) holds its inbox until the turn ends by
 * design -- alerting on that is a false alarm (2026-07-13 09:00: the 3-minute
 * blind alert fired on a merely-busy coordinator and paged the operator).
 * Suppress ONLY while all three hold: the pane is genuinely busy, shows no
 * wedge signal (parked input / context ceiling), and the message has not
 * out-waited the hard ceiling -- past the ceiling a "busy" pane is itself
 * suspect (an endless turn starves the queue just as dead as a wedge).
 * Fail-open: an unreadable pane ('unknown'/'error'/null capture) always alerts.
 */
export function shouldAlertStuckTarget(
  paneState: string | null,
  wedgeSignal: boolean,
  ageMs: number,
  hardCeilingMs: number,
): boolean {
  if (ageMs > hardCeilingMs) return true
  if (wedgeSignal) return true
  return paneState !== 'busy'
}

/**
 * Pure decision: should the router inject a self-poll nudge into the main
 * (coordinator) channels session? The main agent uses a PULL model -- it drains
 * its own inbox each turn -- so an IDLE coordinator can leave a message pending
 * for many minutes until something else makes it take a turn (2026-07-12: a
 * coordinator-bound message starved 10+ min). True iff the oldest main-bound
 * pending message has out-waited `thresholdMs` AND the dedup window has elapsed.
 * The I/O gates (session exists, idle-ready, not cold-starting) stay in the
 * caller; this owns only the age + dedup arithmetic.
 *
 * @param oldestPendingAgeMs Age of the oldest main-bound pending message, or
 *                           null when there is none.
 */
export function decideCoordinatorNudge(
  oldestPendingAgeMs: number | null,
  lastNudgeAt: number | null,
  now: number,
  thresholdMs: number,
  dedupMs: number,
): boolean {
  if (oldestPendingAgeMs === null || oldestPendingAgeMs <= thresholdMs) return false
  if (lastNudgeAt === null) return true
  if (now < lastNudgeAt) return true
  return now - lastNudgeAt >= dedupMs
}

// Coordinator inbox self-poll (deliverable: pull-model backstop). The oldest
// main-bound message must have waited this long before a nudge fires -- long
// enough that a normal busy coordinator (which will drain on its next turn
// anyway) is never nudged, short enough that an IDLE coordinator's inbox does
// not starve for many minutes.
const COORDINATOR_NUDGE_MIN_AGE_MS = 3 * 60 * 1000
// At most one nudge per this window, globally. A nudge only has to START a turn
// (the main agent's UserPromptSubmit hook auto-drains the whole inbox), so one
// per 10 min is ample; reset when the coordinator's pending backlog drains.
const COORDINATOR_NUDGE_DEDUP_MS = 10 * 60 * 1000
// One-line self-poll prompt. Content is near-irrelevant (any turn auto-drains
// the inbox); it just needs to start a turn and read sensibly if surfaced.
// MUST stay short enough to render as a SINGLE input row (~80 cols): when the
// submit silently fails (false-landed / bracketed-paste, 2026-07-13 10:22 the
// nudge itself sat parked in the coordinator's box for 30+ min), the stale-
// parked-input janitor auto-clears a single-row 'typing' box but deliberately
// HOLDS multi-row text -- so a long nudge converts a recoverable miss into a
// wedge that only a restart clears.
const COORDINATOR_NUDGE_PROMPT =
  '[inbox-nudge] Fuggoben levo uzenetek varnak, dolgozd fel oket.'
// Global (single main session) nudge throttle + reset flag. In-module so it
// survives across ticks but resets on a dashboard restart.
let lastCoordinatorNudgeMs: number | null = null

// Checks for pending messages every 5 seconds and injects them into target
// agent tmux sessions.
let _tickRunning = false

// Max messages drained per 5s tick; a larger backlog rolls to the next tick.
export const MAX_MESSAGES_PER_TICK = 25

export function startMessageRouter(): NodeJS.Timeout {
  return setInterval(async () => {
    // Re-entrancy guard: STT can hold a tick for up to 65s; skip new ticks
    // while the previous one is still in flight to prevent double-delivery.
    if (_tickRunning) return
    _tickRunning = true
    try {
      await runMessageRouterTick()
    } finally {
      _tickRunning = false
    }
  }, 5000)
}

// One router pass: drain up to MAX_MESSAGES_PER_TICK pending inter-agent
// messages and inject each into its target tmux session. Extracted from the
// setInterval body so it can be exercised directly in unit tests (the
// _tickRunning re-entrancy guard stays in startMessageRouter, around the call).
export async function runMessageRouterTick(): Promise<void> {
    // Cap work per tick: process at most MAX_MESSAGES_PER_TICK messages, the
    // rest roll to the next 5s tick. Bounds a single tick's wall-time so a
    // backlog (e.g. after a delivery stall) can never make one tick run long
    // and starve the event loop -- the slow-tick half of the progressive-hang
    // pattern. Ordering is preserved (oldest first) so nothing is starved.
    const pending = getPendingMessages().slice(0, MAX_MESSAGES_PER_TICK)
    const now = Date.now()
    // Coordinator inbox self-poll bookkeeping for THIS tick (see the isMainAgent
    // branch): fire at most one nudge, and re-arm the dedup once no main-bound
    // message remains pending (backlog drained).
    let mainBoundSeen = false
    let mainNudgeFiredThisTick = false
    for (const msg of pending) {
      const ageMs = now - msg.created_at * 1000
      // The main agent runs in `${MAIN_AGENT_ID}-channels`, not `agent-${name}`,
      // so agentSessionName() would miss it and strand every sub-agent → main
      // message as pending forever. Mirror the scheduler's session resolution.
      const isMainAgent = msg.to_agent === MAIN_AGENT_ID
      // PULL MODEL: the main agent drains its OWN inbox each turn (the
      // drain-inbox endpoint + UserPromptSubmit hook), so the router does NOT
      // tmux-inject into its perpetually-busy channel session -- that race is
      // what stalled inter-agent delivery to the main agent for ~1h on a busy
      // day. Leave the message pending; the next main-agent turn claims it
      // atomically. Sub-agents keep the tmux-inject path (they have idle gaps).
      if (isMainAgent) {
        // PULL MODEL (above): the router never tmux-injects a real message into
        // the perpetually-busy main channels session. But an IDLE coordinator
        // only drains its inbox when something makes it take a turn, so a
        // message can starve for many minutes (2026-07-12: a coordinator-bound
        // message sat pending 10+ min). `pending` is oldest-first, so the FIRST
        // main-bound message here is the oldest -- its ageMs drives a single
        // lightweight self-poll nudge. Gated on the session being idle-ready and
        // past the cold-start hold, deduped globally, and 'landed'-checked so a
        // gave-up send never retry-storms. The nudge content is near-irrelevant:
        // the main agent's UserPromptSubmit hook auto-drains the whole inbox on
        // ANY turn, so the nudge only has to START one.
        mainBoundSeen = true
        if (
          !mainNudgeFiredThisTick &&
          decideCoordinatorNudge(ageMs, lastCoordinatorNudgeMs, now, COORDINATOR_NUDGE_MIN_AGE_MS, COORDINATOR_NUDGE_DEDUP_MS) &&
          sessionExistsOnHost(null, MAIN_CHANNELS_SESSION) &&
          !channelColdStartHoldActive(MAIN_AGENT_ID) &&
          isSessionReadyForPrompt(MAIN_CHANNELS_SESSION, null)
        ) {
          mainNudgeFiredThisTick = true
          try {
            const nudgeResult = sendPromptToSession(MAIN_CHANNELS_SESSION, COORDINATOR_NUDGE_PROMPT, null, { waitForIdle: false })
            if (nudgeResult === 'landed') {
              lastCoordinatorNudgeMs = now
              logger.info({ id: msg.id, ageMs }, 'message-router: coordinator inbox nudge landed')
            } else {
              // gave-up: the input box was not clean. Do nothing more this tick
              // -- no retry, and do NOT bump the dedup, so a later idle tick can
              // try again once the box clears.
              logger.warn({ id: msg.id }, 'message-router: coordinator inbox nudge gave up (input parked); will retry a later tick')
            }
          } catch (err) {
            logger.warn({ err, id: msg.id }, 'message-router: coordinator inbox nudge injection failed')
          }
        }
        continue
      }
      const session = agentSessionName(msg.to_agent)
      // Remote sub-agents run their tmux session on the laptop; resolve the host
      // so the existence/readiness checks and the send all cross the ssh
      // boundary. Local agents (and the main channels agent) stay host=null.
      const host = isMainAgent ? null : readAgentRemoteHost(msg.to_agent)

      const sessionExists = sessionExistsOnHost(host, session)

      if (shouldAbandon(sessionExists, ageMs, MESSAGE_ABANDON_WINDOW_MS)) {
        logger.warn({ id: msg.id, from: msg.from_agent, to: msg.to_agent, ageMs }, 'Agent message abandoned: target session absent for full retry window')
        if (!markMessageFailed(msg.id, 'Abandoned: target session absent for full retry window')) {
          logger.warn({ id: msg.id }, 'markMessageFailed affected 0 rows (deleted concurrently?)')
        }
        routerLoggedMisses.delete(msg.id)
        continue
      }

      if (!sessionExists) {
        if (!routerLoggedMisses.has(msg.id)) {
          logger.warn({ id: msg.id, to: msg.to_agent, session }, 'Agent message target session not running, will retry')
          routerLoggedMisses.add(msg.id)
        }
        continue
      }

      // Channel-plugin cold-start hold: never inject a prompt while a freshly
      // (re)started channel agent's plugin MCP init may still be pending --
      // the keystrokes silently abort the registration (CC 2.1.199) and the
      // agent comes up permanently deaf. The message stays pending; the next
      // router tick retries (bun child appears or the hold window expires).
      if (!host && channelColdStartHoldActive(msg.to_agent)) {
        if (!routerLoggedMisses.has(msg.id)) {
          logger.info({ id: msg.id, to: msg.to_agent, session }, 'Agent message held: target channel plugin still cold-starting, will retry')
          routerLoggedMisses.add(msg.id)
        }
        continue
      }

      if (!isSessionReadyForPrompt(session, host)) {
        // Stale-parked-input janitor: a non-submitted line stuck in the input
        // box (e.g. a weak local model that typed its heartbeat reply into the
        // box instead of ending the turn) keeps isSessionReadyForPrompt false
        // forever, so this message -- and every later one -- strands as pending
        // and the channel silently wedges. Once a message has waited long enough,
        // clear a STABLE parked input so delivery resumes next tick. clearStale
        // ParkedInput only fires on the idle 'typing' state with text unchanged
        // across a settle, so it never clobbers a session that is actually
        // processing or input a human/agent is mid-typing.
        if (ageMs > JANITOR_PARKED_MIN_AGE_MS && clearStaleParkedInput(session, host)) {
          routerLoggedMisses.delete(msg.id)
          continue // input cleared; deliver on the next tick
        }
        if (!routerLoggedMisses.has(msg.id)) {
          logger.warn({ id: msg.id, to: msg.to_agent, session }, 'Agent message target session busy, will retry')
          routerLoggedMisses.add(msg.id)
        }
        continue
      }

      // Classify (channel-inbound / trusted-peer / untrusted) + reject an empty
      // from_agent -- SINGLE SOURCE in agent-message-wrap so the router and the
      // main-agent pull endpoint frame messages identically (no security drift).
      const cls = classifyAgentMessage(msg.from_agent, msg.to_agent)
      if (!cls) {
        logger.warn({ id: msg.id, rawFrom: msg.from_agent }, 'Agent message rejected: from_agent empty after sanitize')
        if (!markMessageFailed(msg.id, 'Invalid or empty from_agent')) {
          logger.warn({ id: msg.id }, 'markMessageFailed affected 0 rows (deleted concurrently?)')
        }
        routerLoggedMisses.delete(msg.id)
        continue
      }
      const { category, safeFrom: safeFromAgent } = cls
      const isChannelInbound = category === 'channel-inbound'
      const trusted = category === 'trusted-peer'

      // Voice auto-mode: if this is a channel-inbound voice message, run STT
      // and update the last-inbound-modality flag. The decision (STT or not)
      // lives HERE so both the inbound transcript injection and the modality
      // flag are set in one place, with full knowledge of agent-id + chat-id.
      let deliveryContent = msg.content
      if (isChannelInbound) {
        const voiceFileId = extractVoiceFileId(msg.content)
        const chatId = extractChatId(msg.content)
        const voiceCfg = readAgentVoiceConfig(msg.to_agent)
        if (voiceFileId && chatId) {
          // Always record modality so auto-mode TTS can fire on reply.
          setLastInboundModality(msg.to_agent, chatId, 'voice')
          if (voiceCfg.responseMode !== 'text') {
            // Attempt STT; on failure fall through to raw voice block.
            const transcript = await callVoiceSTT(voiceFileId, msg.to_agent)
            if (transcript) {
              deliveryContent = injectTranscript(msg.content, transcript)
              logger.info({ id: msg.id, agent: msg.to_agent }, 'message-router: voice STT applied')
              // TTS directive is injected by the UserPromptSubmit hook (voice-reply-directive.py)
              // which fires on every delivery path, not just coordinator-relay.
            } else {
              logger.warn({ id: msg.id, agent: msg.to_agent }, 'message-router: STT failed, delivering raw voice block')
            }
          }
        } else if (chatId) {
          // Text message: record modality so a previous voice flag is cleared.
          setLastInboundModality(msg.to_agent, chatId, 'text')
        }
      }

      try {
        // channel-inbound carries the STT-applied deliveryContent; the agent
        // wrap (trusted/untrusted) carries the raw content. Single-source frame.
        const content = isChannelInbound ? deliveryContent : msg.content
        const { prefix, wrapped } = wrapAgentMessageForDelivery(category, safeFromAgent, msg.from_agent, content)
        // Inline preamble so a fresh session (post hard-restart) doesn't miss
        // the context that explains the tag semantics.
        //
        // sendPromptToSession reports whether the text actually LANDED (POSITIVE
        // evidence: a real turn started, the payload echoed into the transcript,
        // or the box stayed provably clean across the whole retry budget) or the
        // budget was spent WITHOUT that evidence ('gave-up': still parked, or an
        // unexplained bracketed-paste-mutated box). Marking a 'gave-up' send
        // delivered is the "delivered != landed" gap (2026-07-08 parked-
        // unsubmitted; 2026-07-13 msg 1105 mutated-parked false landed). Only a
        // 'landed' send is a real delivery.
        const sendResult = sendPromptToSession(session, prefix + wrapped, host)
        if (decideDeliveryOutcome(sendResult) === 'delivered') {
          if (!markMessageDelivered(msg.id)) {
            logger.warn({ id: msg.id }, 'markMessageDelivered affected 0 rows (deleted concurrently?)')
          }
          routerLoggedMisses.delete(msg.id)
          logger.info({ id: msg.id, from: msg.from_agent, to: msg.to_agent, category: isChannelInbound ? 'channel-inbound' : trusted ? 'trusted-peer' : 'untrusted' }, 'Agent message delivered')
        } else {
          // 'gave-up': the submit-retry budget was spent with the text STILL
          // parked in the target input box (a [Pasted text #N] placeholder or a
          // multi-row verbatim buffer). Do NOT mark delivered -- leave the
          // message PENDING so a later tick re-delivers (the delivered!=landed
          // fix, 2026-07-08 incident).
          //
          // DELIBERATELY no same-tick clearInputBuffer + re-send on the retry
          // path. A bare Ctrl-U is PROVEN not to clear a paste placeholder, and
          // on a multi-row verbatim buffer clears only the cursor's row (see
          // discardPlaceholderBuffer in agent-process.ts). An imperfect clear
          // followed by a re-send would INTERLEAVE the parked remainder with the
          // resend -- the exact garbage-turn seen in the 2026-07-10 live repro
          // (charlie msg 745/746: repeated manual Ctrl-U + resend interleaved,
          // then a junk turn fired on its own). Instead lean on the SAME gate
          // every FIRST delivery already passes: a parked box reads not-ready to
          // isSessionReadyForPrompt (a placeholder reads 'busy', parked verbatim
          // reads 'typing' -- both block a send), so the next tick will NOT
          // re-send onto it. The retry is therefore gated identically to an
          // initial send and can never interleave more than a first delivery
          // can. A parked-'typing' box is additionally recovered by the existing
          // stale-parked-input janitor (clearStaleParkedInput, ~line 150 above),
          // the PROVEN, VERIFYING clear (Ctrl-U + C-a/C-k, confirm-empty gate,
          // operator escalation). Invariant: never accumulate onto the parked
          // remainder; no re-send until the box is verifiably clean.
          if (shouldAbandonGaveUp(ageMs, MESSAGE_ABANDON_WINDOW_MS)) {
            // Past the retry window: abandon so a present-but-stuck session
            // cannot pin this message pending forever. shouldAbandon() only
            // bounds an ABSENT session; this bounds the oscillating
            // clear->resend->gave-up loop against a PRESENT one. The row is
            // leaving the pending queue, so -- exactly like the catch branch
            // below -- best-effort clear the fresh parked residue first, so the
            // stuck-input watcher cannot later submit it as a phantom turn. No
            // re-send follows this clear, so it carries no interleave risk.
            try {
              clearInputBuffer(session, host)
            } catch (clearErr) {
              logger.warn({ err: clearErr, id: msg.id, session }, 'Post-give-up input-buffer clear failed')
            }
            logger.warn({ id: msg.id, from: msg.from_agent, to: msg.to_agent, ageMs }, 'Agent message abandoned: send gave up (text stayed parked) for full retry window')
            if (!markMessageFailed(msg.id, 'Abandoned: submit-retry budget exhausted, text stayed parked for full retry window')) {
              logger.warn({ id: msg.id }, 'markMessageFailed affected 0 rows (deleted concurrently?)')
            }
            routerLoggedMisses.delete(msg.id)
          } else {
            // DOUBLE-DELIVERY note: 'gave-up' requires the text to be STILL
            // parked (decideSubmitFollowup -> shouldRetrySubmit true), so the
            // box is not clean and the readiness gate blocks the re-send -- no
            // interleave. The only residual duplicate is the narrow race where
            // the parked text auto-submits (phantom turn) between this decision
            // and the next tick, after which a clean box lets the retry
            // re-deliver. That race is inherent without an exactly-once ledger,
            // which is deliberately OUT of scope (the fix targets the
            // delivered!=landed gap, not a global delivery ledger). Dedupe only
            // the log so a stuck message does not warn on every 5s tick.
            if (!routerLoggedMisses.has(msg.id)) {
              logger.warn({ id: msg.id, to: msg.to_agent, session }, 'Agent message send gave up (text parked); left pending for gate+janitor recovery, will retry')
              routerLoggedMisses.add(msg.id)
            }
          }
        }
      } catch (err) {
        logger.warn({ err, id: msg.id }, 'Failed to deliver agent message')
        // A failed delivery can abort sendPromptToSession mid-chunk-stream,
        // leaving half-typed text parked in the target input box -- which the
        // stuck-input watcher later SUBMITS as a phantom turn (observed
        // 2026-07-06: fork-storm ETIMEDOUT mid-typing). Best-effort clear so
        // marking the message failed never leaves the pane dirty; wrapped
        // because the pane itself may be gone by now (clearInputBuffer also
        // logs its own warn when the tmux call fails).
        try {
          clearInputBuffer(session, host)
        } catch (clearErr) {
          logger.warn({ err: clearErr, id: msg.id, session }, 'Post-failure input-buffer clear failed')
        }
        if (!markMessageFailed(msg.id, 'Failed to inject into tmux session')) {
          logger.warn({ id: msg.id }, 'markMessageFailed affected 0 rows (deleted concurrently?)')
        }
        routerLoggedMisses.delete(msg.id)
      }
    }
    // Re-arm the coordinator-nudge dedup once the main-bound backlog has drained,
    // so the next starvation episode nudges promptly instead of waiting out a
    // stale dedup window. (Guarded by the MAX_MESSAGES_PER_TICK slice: a >25-deep
    // non-main backlog could hide a main-bound tail this tick; the pending-age
    // watchdog covers that heavier case, and the next tick re-evaluates.)
    if (!mainBoundSeen) lastCoordinatorNudgeMs = null
}

// ---- voice helpers (message-router level) ----------------------------------

// Extract attachment_file_id from a <channel ... attachment_kind="voice" attachment_file_id="..."> block.
function extractVoiceFileId(content: string): string | null {
  if (!content.includes('attachment_kind="voice"')) return null
  const m = content.match(/attachment_file_id="([^"]+)"/)
  return m ? m[1] : null
}

// Extract chat_id from a <channel chat_id="..."> block.
function extractChatId(content: string): string | null {
  const m = content.match(/chat_id="([^"]+)"/)
  return m ? m[1] : null
}

// Replace the voice attachment block with a transcript prefix.
// Removes attachment_kind and attachment_file_id attributes; prepends [Hang átirat]:.
function injectTranscript(content: string, transcript: string): string {
  // Strip the attachment attributes from the opening tag
  let result = content
    .replace(/\s*attachment_kind="voice"/, '')
    .replace(/\s*attachment_file_id="[^"]*"/, '')
  // Replace the body with the transcript unconditionally (handles empty, "(empty message)", and caption).
  // Replacer function avoids $1/$& special-pattern interpretation in the transcript string.
  result = result.replace(
    /(<channel[^>]*>)[\s\S]*?(<\/channel>)/,
    (_m, open: string, close: string) => `${open}\n[Hang átirat]: ${transcript}\n${close}`,
  )
  return result
}

// Transcribe an inbound voice message. Calls transcribeVoiceFile() DIRECTLY
// (in-process) instead of self-HTTP'ing to /api/voice/stt: the old fetch to
// the same process's dashboard (65s AbortSignal) ran on the tick and coupled
// delivery to the HTTP server -- under sustained voice traffic it progressively
// throttled the event loop (/api/agents 73ms -> 12s -> timeout). The whisper
// subprocess keeps its own 60s timeout inside transcribeVoiceFile, so this can
// never hang the tick beyond that. Returns the transcript, or null on failure.
async function callVoiceSTT(fileId: string, agentId: string): Promise<string | null> {
  try {
    const { existsSync } = await import('node:fs')
    const { join } = await import('node:path')

    // Resolve the agent's channel state_dir using the canonical helper so
    // sub-agents (whose .env lives under AGENTS_BASE_DIR) are found correctly.
    const resolvedDir = resolveAgentChannelStateDir(agentId, 'telegram')
    if (!existsSync(join(resolvedDir, '.env'))) return null

    const { transcribeVoiceFile } = await import('./routes/voice.js')
    return await transcribeVoiceFile(fileId, resolvedDir)
  } catch (err) {
    logger.warn({ err }, 'message-router: callVoiceSTT error')
    return null
  }
}

