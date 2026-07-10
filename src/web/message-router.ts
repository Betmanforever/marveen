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
 *   - 'landed'  -> 'delivered': the text was submitted (or accepted by a busy
 *                               pane). Mark the message delivered, as before.
 *   - 'gave-up' -> 'retry':     the submit-retry budget was spent with the text
 *                               STILL parked in the input box. Marking it
 *                               delivered here is the exact "delivered != landed"
 *                               bug (2026-07-08: a parked-unsubmitted message
 *                               read delivered=true). Leave it pending instead.
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
      if (isMainAgent) continue
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
        // sendPromptToSession reports whether the text actually LANDED
        // (submitted / accepted by a busy pane) or the submit-retry budget was
        // exhausted with the text STILL parked in the input box ('gave-up').
        // Marking a 'gave-up' send delivered is the exact "delivered != landed"
        // gap (2026-07-08: a message sat parked-unsubmitted in the pane yet read
        // delivered=true). Only a 'landed' send is a real delivery.
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

