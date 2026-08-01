// Pure-logic detector for a tmux pane running Claude Code.
//
// Motivation: the scheduler used a single regex (`/esc to interrupt/`) to
// decide whether a target session could accept a new prompt. Between a
// user turn's submission and the spinner's first render there is a frame-
// scale window where the footer shows only `⏵⏵ bypass permissions on
// (shift+tab to cycle)` WITHOUT the `· esc to interrupt` suffix. A
// scheduler tick landing in that window mis-detected "ready", called
// sendPromptToSession, and the prompt sat in the input buffer until the
// post-send retry gave up. The new detector:
//
//   - Recognises a wider range of positive busy indicators (spinner
//     glyph labels + token-count pattern + tool-use mid-turn lines)
//     so the frame-level footer gap no longer yields a false positive.
//   - Returns a discrete state so the caller can distinguish idle /
//     busy / typing / unknown and react per state.
//
// The module has ZERO imports so it is trivially unit-testable against
// captured pane fixtures. The I/O (capture-pane + double-sample) lives
// in src/web.ts alongside the rest of the scheduler.

export type PaneState = 'idle' | 'busy' | 'typing' | 'unknown' | 'error'

// Claude Code shows the footer in one of two modes: the default "bypass"
// permissions mode (permissive) and the "strict" mode. Both are "idle"
// surfaces. If neither is visible the pane is not a recognised Claude
// Code surface and we report 'unknown' rather than guess.
//
// The bypass-mode footer has known trailing variants after the
// "bypass permissions on" prefix: the original "(shift+tab to cycle)"
// hint, and the background-shells indicator which Claude Code
// substitutes when one or more BashTool background shells are running
// in the session. The background-shells indicator itself comes in two
// shapes depending on whether the tasks panel is visible:
//   - tasks visible:  "· N shells · ctrl+t to hide tasks · ↓ to manage"
//   - tasks hidden:   "· N shells · ↓ to manage"
// All variants must classify as idle, otherwise sessions that spawn
// background shells (gh poll, file watchers, long-running build) get
// stuck pending forever.
//
// The shells-variant requires either the "· ctrl+t" marker or the
// "· ↓ to manage" tail after the shell count, rather than just the
// bare "· N shell(s)" prefix. Two reasons:
//   (a) one of these tails is always what Claude Code actually renders,
//       so insisting on either rejects malformed or mid-render frames;
//   (b) it disambiguates the footer from scrollback content that
//       happens to contain "bypass permissions on · 1 shell" verbatim
//       (an echoed log line, a quoted message, etc.) which would
//       otherwise be misread as idle.
// The idle footer's trailing action area is highly variable: `(shift+tab to
// cycle)`, or `· N shells · ctrl+t`, or -- when a background monitor and/or
// sub-agents are present -- `· N monitor · ← for agents · ↓ to manage`. The
// previous regex only accepted the `· \d+ shells ·` shape, so a session running
// a background monitor (footer `· 1 monitor · ← for agents · ↓ to manage`) was
// mis-read as 'unknown' and the router/scheduler silently refused to deliver to
// it -- a fleet-wide delivery hole. Match `bypass permissions on` + EITHER the
// shift+tab hint OR any `·`-separated tail ending in a known idle action (ctrl+t
// / ↓ to manage). Busy states are filtered above (esc to interrupt / busy
// indicators / paste placeholder), so this stays idle-specific.
//
// STRICT-MODE ROTATING-TIP HOLE (2026-07-04): non-bypass agents (strict
// profiles) never render `bypass permissions on`, so they relied entirely on
// the `? for shortcuts` alternative. But Claude Code rotates a HINT in that same
// left footer slot (`? for shortcuts`, `gh auth login`, other onboarding tips);
// when it showed `gh auth login · ← for agents` NOTHING matched, detectPaneState
// read 'unknown', isSessionReadyForPrompt never went true, and inter-agent
// messages to alex/charlie/ive were silently undeliverable across restarts
// (only neo, in bypass mode, kept working). Fix: anchor on the STABLE
// `← for agents` (ASCII `<-` variant too) suffix, which is present regardless of
// the rotating tip. Busy/menu states are filtered above, so this stays
// idle-specific.
const IDLE_FOOTER_RX = /bypass permissions on(?: \(shift\+tab to cycle\)| · [^\n]*?(?:ctrl\+t|↓ to manage))|\? for shortcuts|(?:←|<-) for agents/

// Positive busy signals. ANY match anywhere in the pane means the turn
// is mid-flight, even if the footer looks idle for a frame.
//
// Deliberately narrow: only signals that disappear THE MOMENT a turn
// ends. Two failure modes we explicitly avoid:
//
//   (A) Scrollback persistence. Tool-use summary lines (`Searched for /
//       Listed / Read`) stay rendered above the input box after the
//       turn ends, and Claude Code never overwrites them. A regex
//       matching those would starve the scheduler forever.
//
//   (B) Prose false positive. The standalone word "Thinking…" or
//       "Crafting…" could legitimately appear in Claude's reply text
//       (Markdown headings, list items, quoted content). Matching the
//       label alone would read that prose as mid-turn. To avoid this
//       we require the label to be followed by the parenthesised
//       runtime marker `(Ns · ↓` -- an UI chrome signature that
//       cannot appear in reply text.
//
// The load-bearing signal is the tokens-down-arrow pattern `(Ns · ↓N`,
// which every extended-thinking turn renders regardless of spinner
// label. `esc to interrupt` is the footer-scoped fallback checked only
// in the live footer region (see LIVE_FOOTER_REGION_LINES below) to
// prevent prose-quoting false positives. A future Claude Code release
// that renames the spinner labels will miss the label regex but still
// be caught by the tokens pattern.
const BUSY_INDICATORS: RegExp[] = [
  // NOTE: /\besc to interrupt\b/ is NOT in this list.
  // It is checked separately via BUSY_ESC_TO_INTERRUPT_RX scoped to the
  // bottom LIVE_FOOTER_REGION_LINES lines, because a watchdog report or
  // tool-call output that quotes the phrase in scrollback would otherwise
  // permanently pin the session as busy (81-retry starvation incident).
  //
  // These patterns are ALSO region-scoped (to BUSY_LIVE_REGION_LINES, see
  // below) for the same reason: a completed turn's final spinner frame
  // "Accomplishing… (3m 8s · ↓ 9.3k tokens)" is NOT always overwritten on
  // completion -- only the footer line is. A stale token-counter line left
  // rendered ABOVE the live (empty) input box of a genuinely idle session
  // would otherwise match whole-pane and pin it busy forever (observed:
  // 94 consecutive scheduler retries on an idle neo-channels session,
  // 2026-06-30). The live spinner/token line renders just above the input
  // box during a real turn, so the bottom-region scope still catches it.
  //
  // Tokens-down-arrow counter: "(52s · ↓ 2.6k tokens ..."
  /\(\s*\d+s\s*·\s*↓\s*\d/,
  // Known spinner labels paired with the turn-scoped `(Ns · ↓` tail on
  // the same line. The tail requirement kills the "Thinking…" prose
  // false positive. Non-exhaustive by design; the bare tokens pattern
  // above is the authoritative fallback.
  /\b(?:Combobulating|Beaming|Thinking|Pondering|Reticulating|Configuring|Noodling|Ruminating|Percolating|Cogitating|Deliberating|Contemplating|Musing|Brewing|Synthesizing|Distilling|Refining|Simmering|Crafting|Formulating|Consulting|Unfurling|Unspooling|Unraveling)…\s*\(\s*\d+s\s*·\s*↓/,
]

// `esc to interrupt` is a footer-region-only busy signal: Claude Code
// appends it to the bypass-mode footer line during a live turn. Scoping
// the check to the bottom LIVE_FOOTER_REGION_LINES lines prevents a
// watchdog report or tool-call output that quotes the phrase anywhere
// in the scrollback from permanently pinning the session as busy
// (observed incident: 81 consecutive scheduler retries on a report that
// contained the phrase in its body).
const BUSY_ESC_TO_INTERRUPT_RX = /\besc to interrupt\b/
const LIVE_FOOTER_REGION_LINES = 5

// How many trailing lines the BUSY_INDICATORS (spinner / token-counter)
// scan inspects. During a live turn the status line renders just above the
// input box (footer ~3 lines + box ~2 lines + the spinner line + a little
// tool-output tail), comfortably inside this window. Must exceed
// LIVE_FOOTER_REGION_LINES so the spinner line above the box is included,
// while a stale counter scrolled higher (from a completed turn) is excluded.
const BUSY_LIVE_REGION_LINES = 12

// Pasted-text placeholder. Claude Code lifts a single large input write
// (empirically a tmux send-keys -l of more than ~700 chars) into a
// `[Pasted text #N]` / `[Pasted text #N +X chars]` stub that sits in the
// LIVE INPUT BOX and never auto-submits. Treat as busy so the scheduler
// doesn't pile a second prompt on top.
//
// Wrap tolerance (real-capture finding): when the input is long the stub
// renders wrapped across a terminal line break -- `...[Pasted text` at the
// end of one line and `  #3]...` at the start of the next (the digits
// themselves can also straddle the break). The opening token, the `#`, and
// the digit are therefore separated by `\s*` (which includes newlines and
// the leading indent of the wrapped continuation) rather than a single
// literal space. This still matches the unwrapped `[Pasted text #N` and
// `[Pasted text #N +X chars]` shapes.
const PENDING_PASTE_RX = /\[Pasted text\s*#\s*\d/

// How many trailing lines to inspect for the stub when no input-box
// separators are visible (a malformed / partial capture, or the older
// `paste again to expand` render with separators scrolled off). Kept tight
// so a stub quoted higher up in scrollback cannot reach the bottom region.
const PASTE_REGION_FALLBACK_LINES = 8

// Scope the placeholder match to the live input box, not the whole pane.
// The box is the region between the two most recent U+2500 separators found
// from the BOTTOM of the pane -- footer-INDEPENDENT, because the placeholder
// render is version-dependent: the current build keeps the normal
// `bypass permissions ...` idle footer below the box, while an older build
// replaced it with a `paste again to expand` hint. Anchoring on the
// separators (always present around the box) covers both. When two
// separators are not found we fall back to the last few lines.
//
// Whole-pane matching was a confirmed false-POSITIVE source: these agents
// routinely quote tmux captures and discuss this very bug, so a literal
// `[Pasted text #N` in a reply line or deep scrollback would trigger a
// destructive Ctrl-C + resend on a perfectly healthy session. Scoping to
// the box (same discipline as BUSY_ESC_TO_INTERRUPT_RX / the footer checks)
// confines the match to where a genuine parked stub actually lives.
function pastePlaceholderRegion(pane: string): string {
  const lines = pane.split('\n')
  let bottomSep = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (BOX_SEP_RX.test(lines[i])) { bottomSep = i; break }
  }
  if (bottomSep > 0) {
    let topSep = -1
    for (let i = bottomSep - 1; i >= 0; i--) {
      if (BOX_SEP_RX.test(lines[i])) { topSep = i; break }
    }
    if (topSep >= 0) return lines.slice(topSep + 1, bottomSep).join('\n')
  }
  return lines.slice(-PASTE_REGION_FALLBACK_LINES).join('\n')
}

// A placeholder pane is identified by the `[Pasted text #N]` stub IN THE LIVE
// INPUT BOX. The accompanying `paste again to expand` footer hint is
// deliberately NOT used: it is version-dependent (the current build keeps the
// normal idle footer instead) AND it empirically LINGERS for a beat after the
// message submits (the box is already empty, the stub gone, yet the hint line
// is still rendered), so keying on it would false-positive a freshly-submitted
// pane as still stuck and trigger a needless clear-and-resend. The stub itself
// appears iff a real placeholder is parked (verified across real captures:
// present in every placeholder render, absent the instant it submits). Pure +
// dependency-free so callers (detectPaneState, shouldRetrySubmit, the recovery
// decision) share ONE definition instead of re-inlining the regex.
export function detectsPastePlaceholder(pane: string): boolean {
  if (!pane) return false
  return PENDING_PASTE_RX.test(pastePlaceholderRegion(pane))
}

// Input-box separator lines are made of U+2500 BOX DRAWINGS LIGHT
// HORIZONTAL. At least 10 in a run to ignore stray `-` glyphs.
const BOX_SEP_RX = /^─{10,}/

// Prompt line inside the input box. `❯` followed by at least one
// horizontal whitespace and then a non-whitespace character means the
// user (or a send-keys that didn't submit) parked text there.
//
// The class is `[^\S\r\n]` (any whitespace EXCEPT a line break), not
// `[ \t]`: a live Claude Code pane renders the gap after the ❯ prompt
// glyph as a NON-BREAKING SPACE (U+00A0), not an ASCII space, while a
// message sits parked (delivered but not yet submitted). The ASCII-space
// form only appears in scrollback for already-submitted lines. `[ \t]`
// missed that NBSP, so an NBSP-rendered parked box read as 'idle' and the
// whole stuck-input recovery chain (stuckInputSignature, parkedChannelInput,
// parkedInputText all gate on detectPaneState === 'typing') never fired --
// the message stranded forever. Excluding only \r\n keeps the original
// single-line intent (the match must not cross into the next line) while
// admitting the NBSP and any other horizontal Unicode space the TUI emits.
const PARKED_INPUT_RX = /❯[^\S\r\n]+\S/

// Strip Claude Code's DIM (SGR 2) "ghost suggestion" autocomplete from a
// COLOURED pane capture (`tmux capture-pane -e -p`), then remove every
// remaining ANSI escape, yielding plain text equivalent to `capture-pane -p`
// MINUS the ghost. Claude Code renders a history/autocomplete hint inside an
// EMPTY input box at REDUCED intensity (`❯ ` then `ESC[2m<hint>ESC[0m`). A
// plain (`-p`) capture drops the colour, so the dim hint becomes
// indistinguishable from a genuinely parked input -- and the stuck-input
// recovery then re-types + Enter-submits it as if the agent had typed it
// (the 2026-06-26 phantom prompt-injection: it triggered a real invoice storno
// and a forged email). The discriminator is intensity: a real parked input is
// rendered at NORMAL intensity, only the ghost is dim. We track SGR dim state
// across the stream and DROP any character emitted while dim is active, so a
// pure-ghost box collapses to `❯ ` (no `\S` after the prompt) and
// PARKED_INPUT_RX / detectPaneState no longer read it as 'typing'.
//
// Pure: a string transform, unit-testable against captured `-e` fixtures.
// `38`/`48` extended-colour params (`38;5;N`, `38;2;R;G;B`) are consumed as a
// unit so a colour INDEX of 2 is never mistaken for the dim attribute.
export function stripGhostSuggestion(coloredPane: string): string {
  let out = ''
  let dim = false
  let i = 0
  const n = coloredPane.length
  while (i < n) {
    const ch = coloredPane[i]
    if (ch === '\x1b') {
      if (coloredPane[i + 1] !== '[') { i++; continue } // drop non-CSI ESC
      let j = i + 2
      while (j < n && (coloredPane[j] < '@' || coloredPane[j] > '~')) j++
      const final = coloredPane[j]
      if (final === 'm') {
        const params = coloredPane.slice(i + 2, j)
        const codes = params.length === 0 ? [''] : params.split(';')
        let k = 0
        while (k < codes.length) {
          const c = codes[k]
          if (c === '38' || c === '48') {
            const mode = codes[k + 1]
            k += mode === '5' ? 3 : mode === '2' ? 5 : 1
            continue
          }
          if (c === '2') dim = true
          else if (c === '0' || c === '22' || c === '') dim = false
          k++
        }
      }
      i = j < n ? j + 1 : n // skip the whole escape sequence
      continue
    }
    if (!dim) out += ch
    i++
  }
  return out
}

// Persistent Anthropic thinking-block API error. When an assistant turn
// ends with a 400 about thinking/redacted_thinking blocks that "cannot
// be modified", the session is wedged: every subsequent prompt re-sends
// the same context and yields the identical 400. The pane shows the idle
// footer (turn "finished") plus a past-tense thinking stamp but NO live
// busy indicator, so detectPaneState would otherwise classify it 'idle'
// and the scheduler/router would keep injecting -- each injection
// another doomed 400. Surfacing this as a distinct 'error' state makes
// isReadyForPrompt() return false so injection stops, and lets the
// channel monitor alert that a manual reset is needed.
//
// Three guards, ALL required, to avoid flagging a healthy session that
// merely quotes the error text (a bug-report message, a log analysis):
//
//   (a) Position scope: only the "live tail" (the lines just above the
//       idle footer) is inspected, never deep scrollback. A long-ago
//       turn's error echo above the live region is ignored. The footer
//       is found from the BOTTOM (the live footer is always the last
//       line of the pane) so a footer-looking string quoted higher up
//       in scrollback does not shift the scope.
//   (b) Chrome glyph: the error must render as a tool-output line
//       `⎿  API Error: <code>` -- the U+23BF result glyph Claude Code
//       prints before a turn-level error. Prose that quotes "API Error
//       400" in a message body has no leading `⎿  API Error: <num>`.
//   (c) Specific phrase: the thinking-block signature `cannot be
//       modified` together with `thinking` or `redacted_thinking`. A
//       generic API error (rate limit, overloaded) is NOT this class.
//
// (b) and (c) are required WITHIN ONE CHROME BLOCK (the chrome line plus
// its wrapped continuation), not anywhere in the joined tail. Otherwise
// a benign `⎿ API Error: 429` on one line plus an unrelated "thinking
// ... cannot be modified" prose on another line would AND-combine into
// a false positive on a healthy session.
const ERROR_CHROME_RX = /⎿\s*API Error:\s*\d+/
const ERROR_THINKING_PHRASE_RX = /cannot be modified/
const ERROR_THINKING_KIND_RX = /\b(?:redacted_thinking|thinking)\b/

// How many lines above the idle footer count as the "live tail". The
// error output (the `⎿` line + its wrapped continuation), the thinking
// stamp, and the input box together span well under 20 lines; 20 gives
// margin for terminal re-flow without reaching deep scrollback.
const ERROR_LIVE_TAIL_LINES = 20

// How many lines a single API-error render spans: the `⎿` chrome line
// plus its wrapped continuation. The thinking-block message is long and
// the terminal wraps it; at ~80 cols "cannot be modified" lands on the
// 2nd line, at ~60 cols on the 3rd-4th. 4 covers narrow panes while
// staying short enough that an adjacent unrelated chrome block does not
// bleed in (the decoupled-benign test pins this boundary).
const ERROR_BLOCK_LINES = 4

/**
 * True when the pane is wedged in the persistent thinking-block API
 * error described above. Scoped to the live tail above the idle footer
 * so a quoted error string in scrollback or a message body does not
 * trigger a false positive. Returns false when there is no idle footer
 * (the pane is busy or not a recognised Claude Code surface).
 */
export function detectsThinkingBlockError(pane: string): boolean {
  if (!pane) return false
  const lines = pane.split('\n')
  // Find the footer from the bottom: the live footer is the last line of
  // the pane, so a footer-looking line quoted in scrollback must not win.
  let footerIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (IDLE_FOOTER_RX.test(lines[i])) { footerIdx = i; break }
  }
  if (footerIdx < 0) return false
  const start = Math.max(0, footerIdx - ERROR_LIVE_TAIL_LINES)
  const tail = lines.slice(start, footerIdx)
  // The chrome glyph and the thinking-block phrase+kind must co-occur
  // within ONE chrome block, not be scattered across the tail.
  for (let i = 0; i < tail.length; i++) {
    if (!ERROR_CHROME_RX.test(tail[i])) continue
    const block = tail.slice(i, i + ERROR_BLOCK_LINES).join('\n')
    if (ERROR_THINKING_PHRASE_RX.test(block) && ERROR_THINKING_KIND_RX.test(block)) {
      return true
    }
  }
  return false
}

// Claude Code modal/overlay surfaces -- the /mcp server manager, the model/
// config/theme pickers, and permission dialogs -- replace the input box with a
// navigable list whose footer reads e.g.
//   "↑/↓ to navigate · Enter to confirm · Esc to cancel".
// A headless service session (the main --channels session, a sub-agent) parked
// in such a modal silently stops processing inbound work: it is not 'busy' (no
// spinner / token counter) and not 'idle' (the input box is gone), so
// detectPaneState classifies it 'unknown' and the scheduler/router just skip
// it. Observed 2026-06-12: the main channels session sat in /mcp for ~6h, deaf
// on Telegram, with nothing alerting. detectsBlockingMenu recognises the modal
// so the monitor can pop back to the prompt with a single Escape.
//
// Guards against a healthy session that merely quotes menu chrome in a reply
// or a log line:
//   (a) Not busy: a live turn (spinner / token counter / esc-to-interrupt) is
//       never a parked menu.
//   (b) No idle footer: a real modal hides the permission/shortcuts footer.
//       capturePane uses `capture-pane -p` (visible screen only, no
//       scrollback), so a quoted footer cannot linger from a past turn -- an
//       idle footer present means the normal prompt is live, not a menu.
//   (c) The dismiss/navigation hint must sit in the live footer region (the
//       bottom few lines), not anywhere in the pane, so a message body that
//       quotes "Esc to cancel" does not trigger it.
// `esc to interrupt` (the busy footer) is deliberately excluded from
// MENU_ESC_RX, and guard (a) rejects it anyway.
const MENU_NAV_RX = /(?:↑\/↓|↑↓)\s+to\s+(?:navigate|select|choose)/
const MENU_ESC_RX = /\besc to (?:cancel|exit|close|go back|quit)\b/i
const MENU_FOOTER_REGION_LINES = 8

/**
 * True when the pane is parked in a blocking Claude Code interactive menu /
 * modal (not busy, not at the idle prompt). Pure + dependency-free for unit
 * testing. The monitor uses this to send a recovery Escape; detectPaneState
 * intentionally still returns 'unknown' for these panes so the hot-path
 * scheduler/router behaviour is unchanged.
 */
export function detectsBlockingMenu(pane: string): boolean {
  if (!pane || !pane.trim()) return false
  for (const rx of BUSY_INDICATORS) {
    if (rx.test(pane)) return false
  }
  const lines = pane.split('\n')
  const footerRegion = lines.slice(-MENU_FOOTER_REGION_LINES).join('\n')
  if (BUSY_ESC_TO_INTERRUPT_RX.test(footerRegion)) return false
  if (IDLE_FOOTER_RX.test(pane)) return false
  return MENU_NAV_RX.test(footerRegion) || MENU_ESC_RX.test(footerRegion)
}

// A tool-approval / permission dialog is a SPECIAL CASE of a blocking modal:
// detectsBlockingMenu() returns true for it (same "Esc to cancel" footer), but
// the recovery Escape here does NOT mean "close the modal, conversation
// untouched" -- it means "reject the pending tool call AND abort the turn". A
// session Escaped out of a permission dialog is left idle with an interrupted
// turn and never resumes on its own (observed 2026-07-04: Charlie stalled ~40m
// after the menu-recovery Escape cancelled a live tool call). The monitor must
// recognise this shape and NOT auto-Escape -- escalate to a human instead.
//
// The markers are the option lines unique to the CC permission prompt; they do
// not appear in the /mcp manager or the model/theme pickers:
//   "Do you want to proceed?" / "Do you want to make this edit to ..."
//   "❯ 1. Yes"
//   "2. Yes, and don't ask again ..."
//   "3. No, and tell Claude what to do differently (esc)"
// A match needs EITHER the highly specific option phrase (unique to the
// permission prompt, never in the /mcp menu or a reply body), OR the question
// line paired with a numbered "Yes" option on its own line -- the pair keeps a
// reply that merely quotes "Do you want to ..." in prose from tripping it. Bias
// is deliberately toward sensitivity: a false positive only costs a skipped
// auto-Escape + an alert (safe); a false negative re-opens the turn-aborting
// bug. Calibrate the phrasing against a live `tmux capture-pane` of an actual
// dialog before narrowing.
// Option phrases unique to an approval prompt across its variants: tool-approval
// ("don't ask again" / "tell Claude what to do differently") and plan-mode
// ("auto-accept edits" / "keep planning"). None appear in the /mcp manager or
// the model/theme pickers.
const PERMISSION_OPTION_RX = /(?:don'?t ask again|tell Claude what to do differently|auto-accept edits|keep planning)/i
// Both the tool-approval ("Do you want to proceed?") and plan-mode ("Would you
// like to proceed?") question wordings.
const PERMISSION_QUESTION_RX = /\b(?:Do you want to|Would you like to)\b/i
const PERMISSION_YES_OPTION_RX = /^\s*❯?\s*\d+\.\s+Yes\b/m

/**
 * True when the pane is parked in a Claude Code tool-approval / permission
 * dialog (a blocking modal where Escape rejects the tool call and aborts the
 * turn, not a navigable menu Escape can safely dismiss). Pure + dependency-free
 * for unit testing. Callers use this to SUPPRESS the menu-recovery Escape.
 */
export function detectsPermissionDialog(pane: string): boolean {
  if (!pane || !pane.trim()) return false
  for (const rx of BUSY_INDICATORS) {
    if (rx.test(pane)) return false
  }
  if (BUSY_ESC_TO_INTERRUPT_RX.test(pane.split('\n').slice(-LIVE_FOOTER_REGION_LINES).join('\n'))) return false
  if (IDLE_FOOTER_RX.test(pane)) return false
  if (PERMISSION_OPTION_RX.test(pane)) return true
  return PERMISSION_QUESTION_RX.test(pane) && PERMISSION_YES_OPTION_RX.test(pane)
}

// The model-credit consent dialog is a THIRD special case of a blocking modal,
// and the most dangerous one yet, because Escape here is neither "close the
// modal, conversation untouched" (the /mcp menu) nor "reject the tool call"
// (the permission dialog) -- it is a SILENT MODEL DOWNGRADE.
//
// Shape (verified against a real capture of neo's pane and against the Claude
// Code 2.1.220 bundle, the `model_fable_consent` dialog):
//
//   ────────────────────────────────────────────────────────────────────────
//     You've reached your Fable 5 limit
//     You've used your included Fable 5 usage for this week. Continuing on
//     Fable 5 uses usage credits, purchased separately from your plan.
//     Learn more: https://support.claude.com/en/articles/12429409-extra-usage-...
//     ❯ 1. Continue with Fable 5
//       2. Switch to Sonnet 5 and continue
//     Enter to confirm · Esc to cancel
//
// detectsBlockingMenu() is ALREADY true for it (same "Esc to cancel" footer),
// and it is NOT a permission dialog, so before this detector existed it fell
// straight into the generic menu-recovery Escape. In the CLI the dialog
// resolves to one of three answers -- `consent` (option 1), `switch_default`
// (option 2) and `cancelled` (Escape / onCancel) -- and the query loop treats
// ANY answer other than `consent` identically: it swaps the session onto the
// fallback model and continues. `switch_default` additionally persists that
// model as the user default; `cancelled` does not. So the recovery Escape
// silently moved the agent onto the fallback model MID-SESSION, the modal
// disappeared, the pane looked healthy, and agent-config.json still claimed
// the configured model -- nothing in the fleet could see the drift. Observed
// live 2026-07-24 ~21:09-21:24: neo (configured claude-fable-5, Gabor's
// 2026-07-20 decision to stay on Fable and accept usage credits) ran ~15
// minutes on Sonnet 5; only the session JSONL's assistant.model field exposed
// it.
//
// Guards, in order:
//   (a) detectsBlockingMenu() must hold. This reuses the busy / idle-footer /
//       footer-region discipline instead of re-inlining it AND makes the new
//       branch a strict SUBSET of the panes the generic Escape would have
//       handled -- it can never fire somewhere the old code did nothing.
//   (b) The credit phrase must appear in the live bottom region. Matched on a
//       whitespace-FLATTENED join of the region, not per line, because the TUI
//       hard-wraps the body ("Continuing on Fable 5\n  uses usage credits").
//   (c) At least two numbered option lines must be present in the same region.
//       This is what separates the interactive consent MODAL from the various
//       non-interactive "... requires usage credits" banners Claude Code also
//       renders (fast-mode notice, model-policy error), and from the
//       API-error-anchored credit detectors in model-fallback.ts, which are
//       tuned for a completely different surface ("⎿ API Error: ...").
const MODEL_CREDIT_PHRASE_RX = /\b(?:uses?|runs on|requires?) usage credits\b/i
// A rendered select row: optional focus caret, the 1-based index, a dot, the
// label. Same row shape PERMISSION_YES_OPTION_RX keys on.
const MODEL_CREDIT_OPTION_RX = /^\s*❯?\s*(\d+)\.\s+(\S.*)$/
// How many trailing lines the credit-dialog scan inspects. Counted against the
// WIDEST variant the bundle can render: border + title + gap + wrapped body +
// dialog note + "you don't have usage credits yet" + wrapped monthly-limit hint
// + wrapped Help-Center consent line + gap + three options + footer + border
// ~= 18 lines. 24 keeps margin for narrower panes (more wrapping) while staying
// far short of the transcript that remains rendered above the modal. Sizing
// this too small is the dangerous direction: the phrase sits at the TOP of the
// modal, so an under-sized region silently drops back to the generic Escape.
const MODEL_CREDIT_REGION_LINES = 24

// Model id -> the SHORT name the dialog prints. Source of truth: the model
// catalog embedded in the Claude Code bundle (`display_name` per model id),
// cross-checked against a live capture. Limited to the ids an agent in this
// fleet can actually be configured to: the /api/models/available list, the
// model-fallback DEFAULT_MODEL_CHAIN, and the ids currently in
// agents/*/agent-config.json. Unknown ids resolve to null and the caller
// escalates rather than guessing a "closest" model.
export const MODEL_CREDIT_DIALOG_LABELS: Record<string, string> = {
  'claude-fable-5': 'Fable 5',
  'claude-mythos-5': 'Mythos 5',
  'claude-opus-5': 'Opus 5',
  'claude-opus-4-8': 'Opus 4.8',
  'claude-sonnet-5': 'Sonnet 5',
  'claude-sonnet-4-6': 'Sonnet 4.6',
  'claude-haiku-4-5': 'Haiku 4.5',
}

// Agent configs carry variant suffixes the catalog ids do not: the 1M-context
// marker (`claude-opus-4-8[1m]`) and the dated release pin
// (`claude-haiku-4-5-20251001`). Both name the SAME model in the dialog, so
// strip them before the lookup.
function baseModelId(modelId: string): string {
  return modelId.trim().replace(/\[1m\]$/i, '').replace(/-\d{8}$/, '')
}

function escapeForRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

interface ModelCreditOption {
  num: number
  text: string
}

function parseModelCreditOptions(lines: string[]): ModelCreditOption[] {
  const out: ModelCreditOption[] = []
  for (const line of lines) {
    const m = line.match(MODEL_CREDIT_OPTION_RX)
    if (!m) continue
    const num = Number.parseInt(m[1], 10)
    if (!Number.isFinite(num) || num < 1) continue
    out.push({ num, text: m[2].trim() })
  }
  return out
}

/**
 * True when the pane is parked in the Claude Code model-credit consent dialog
 * (the modal where the configured model has exhausted its included quota and
 * continuing on it draws paid usage credits). Pure + dependency-free.
 *
 * Callers must treat this as "do NOT auto-Escape": Escape is answered as
 * `cancelled`, which the CLI resolves by switching the session to the fallback
 * model and continuing -- a silent, invisible downgrade. Navigate explicitly
 * (findModelCreditDialogOption) or escalate instead.
 */
export function detectsModelCreditDialog(pane: string): boolean {
  if (!detectsBlockingMenu(pane)) return false
  const region = pane.split('\n').slice(-MODEL_CREDIT_REGION_LINES)
  // Flatten before matching: the body wraps mid-phrase at pane width.
  if (!MODEL_CREDIT_PHRASE_RX.test(region.join(' ').replace(/\s+/g, ' '))) return false
  return parseModelCreditOptions(region).length >= 2
}

/**
 * The 1-based option number in a model-credit dialog that selects `modelId`,
 * or null when there is no UNAMBIGUOUS match.
 *
 * Only the two option shapes that actually name a model count -- "Continue
 * with <label>" (stay on the credit-gated model) and "Switch to <label> and
 * continue" (move to the fallback). The other labels the dialog can render
 * ("Buy usage credits", "Yes, re-enable and continue", "Request usage credits
 * from your admin", an upsell row) name no model and must never be selected by
 * a watchdog.
 *
 * Returns null -- i.e. "escalate, do not act" -- when the model id is not in
 * MODEL_CREDIT_DIALOG_LABELS, when no option names it (e.g. the agent is
 * configured for Haiku but the dialog only offers Fable/Sonnet), or when more
 * than one option would match. Guessing a "closest" model is deliberately not
 * attempted: picking the wrong row here spends money or downgrades silently,
 * exactly the failure this detector exists to prevent.
 *
 * Wrapped option labels are NOT reassembled across lines. A wrap yields null,
 * which routes to escalation -- the safe direction.
 */
export function findModelCreditDialogOption(pane: string, modelId: string): number | null {
  if (!pane || !modelId) return null
  const label = MODEL_CREDIT_DIALOG_LABELS[baseModelId(modelId)]
  if (label == null) return null
  const rx = new RegExp(`^(?:Continue with|Switch to)\\s+${escapeForRegExp(label)}\\b`, 'i')
  const matches = parseModelCreditOptions(pane.split('\n').slice(-MODEL_CREDIT_REGION_LINES))
    .filter((o) => rx.test(o.text))
  return matches.length === 1 ? matches[0].num : null
}

export interface DetectPaneStateOptions {
  /** If true, the 'typing' state (text parked in input box) is
   * merged into 'busy'. Default false -- callers that care about
   * "user actively composing" vs "mid-turn" can distinguish. */
  mergeTypingAsBusy?: boolean
}

/**
 * Classify a raw `tmux capture-pane -p` string into a pane state.
 *
 * Algorithm, in order:
 *   1. Empty / whitespace-only -> 'unknown'.
 *   2. Any BUSY_INDICATOR matches in the live bottom region -> 'busy'.
 *      Covers the spinner/token-count fallbacks that catch the frame-level
 *      footer gap; region-scoped so a stale counter does not pin idle.
 *   3. No idle footer visible -> 'unknown' (pane is not Claude Code).
 *   4. Wedged thinking-block API error in the live tail -> 'error'.
 *      Checked after the busy guard (a live turn is never 'error') and
 *      after the footer guard (an 'error' surface still shows the
 *      footer) so the scheduler/router stop injecting doomed prompts.
 *   5. Pending paste placeholder -> 'busy'.
 *   6. Text parked inside the bottom input box -> 'typing'.
 *   7. Otherwise -> 'idle'.
 */
export function detectPaneState(
  pane: string,
  opts: DetectPaneStateOptions = {},
): PaneState {
  if (!pane || !pane.trim()) return 'unknown'

  const paneLines = pane.split('\n')

  // Spinner / token-counter busy signals, scoped to the live bottom region.
  // Whole-pane scanning let a completed turn's stale token-counter line pin
  // an idle session busy (see BUSY_LIVE_REGION_LINES).
  const busyRegion = paneLines.slice(-BUSY_LIVE_REGION_LINES).join('\n')
  for (const rx of BUSY_INDICATORS) {
    if (rx.test(busyRegion)) return 'busy'
  }

  // Scope `esc to interrupt` check to the live footer region only.
  // Checking the whole pane would let a scrollback quote of the phrase
  // (e.g. in a watchdog report or a log analysis) permanently classify
  // an idle session as busy.
  const footerRegion = paneLines.slice(-LIVE_FOOTER_REGION_LINES).join('\n')
  if (BUSY_ESC_TO_INTERRUPT_RX.test(footerRegion)) return 'busy'

  // Pending-paste placeholder check runs BEFORE the idle-footer gate. The
  // stub sits in the live input box; the footer below it is version-dependent
  // (the current build keeps the normal `bypass permissions ...` idle footer,
  // an older build showed `paste again to expand` instead and so failed
  // IDLE_FOOTER_RX). Running the box-scoped placeholder check first classifies
  // BOTH shapes as 'busy' -- and on the older `paste again to expand` shape it
  // also rescues the pane from being mis-read 'unknown' at the idle-footer gate
  // below. A placeholder must read 'busy' so the scheduler/router/keepalive
  // defer rather than pile a second prompt on.
  if (detectsPastePlaceholder(pane)) return 'busy'

  if (!IDLE_FOOTER_RX.test(pane)) {
    // Footer-less fresh-session / welcome-screen: a PARKED \u276F input box still
    // means the agent has a delivered message waiting to submit. Classify it
    // 'typing' (not 'unknown') so the stuck-input recovery stack can see and
    // resubmit it. An empty box / no box stays 'unknown' -- without a footer
    // there is nothing to confirm a genuine idle state.
    const box = liveInputBox(pane)
    if (box != null && box.split('\n').some(l => PARKED_INPUT_RX.test(l))) {
      return opts.mergeTypingAsBusy ? 'busy' : 'typing'
    }
    return 'unknown'
  }

  if (detectsThinkingBlockError(pane)) return 'error'

  // Find the input box: two BOX_SEP_RX lines framing the current prompt.
  // Scan UPWARDS from the footer so we stay inside the live box and
  // don't pick up historical ❯ lines from scrollback.
  const lines = pane.split('\n')
  const footerIdx = lines.findIndex(l => IDLE_FOOTER_RX.test(l))
  if (footerIdx >= 0) {
    let bottomSep = -1
    for (let i = footerIdx - 1; i >= 0; i--) {
      if (BOX_SEP_RX.test(lines[i])) { bottomSep = i; break }
    }
    let topSep = -1
    if (bottomSep > 0) {
      for (let i = bottomSep - 1; i >= 0; i--) {
        if (BOX_SEP_RX.test(lines[i])) { topSep = i; break }
      }
    }
    if (topSep >= 0 && bottomSep > topSep) {
      const inputLines = lines.slice(topSep + 1, bottomSep)
      if (inputLines.some(l => PARKED_INPUT_RX.test(l))) {
        return opts.mergeTypingAsBusy ? 'busy' : 'typing'
      }
    }
  }

  return 'idle'
}

/**
 * Canonical pure idle predicate: true iff the capture classifies as the
 * 'idle' pane state (input box live and empty, not busy / typing / menu /
 * error / unknown). This is the SINGLE place the "is this pane idle" rule
 * lives, so every caller -- the readiness check (isReadyForPrompt), the
 * auto-restart idle-guard (auto-restart-runner.paneIsIdle) and the
 * sendPromptToSession pre-flight wait-until-idle gate -- shares one
 * definition rather than re-inlining `detectPaneState(...) === 'idle'`
 * (and, worse, the busy regex) in several files.
 */
export function paneLooksIdle(capture: string): boolean {
  return detectPaneState(capture) === 'idle'
}

/**
 * True when the pane is in the specific "accepting a new prompt" state.
 * 'typing' counts as not-ready because the user has unsubmitted text
 * in the input box and a new prompt would concatenate into it. Thin alias
 * over paneLooksIdle kept for its existing call sites / tests.
 */
export function isReadyForPrompt(pane: string): boolean {
  return paneLooksIdle(pane)
}

/**
 * Idle check that tolerates DIM-only "parked text". Claude Code >=2.1.202
 * renders a placeholder hint (e.g. "Try refactor...") in dim (SGR-2 faint)
 * inside the EMPTY input box; a plain capture-pane read shows it as parked
 * text, detectPaneState classifies 'typing', and a readiness poll never turns
 * true. Ghost/placeholder text is dim while real typed input is not (the same
 * invariant clearStaleParkedInput's DIM-GUARD relies on), so when the plain
 * view says 'typing' the caller re-reads the pane through the dim-stripping
 * view (captureParkedInputView) and passes it here: if the stripped view is
 * idle, the box only ever held ghost text and the session IS ready.
 */
export function idleConsideringDimGhost(plain: string, dimStripped: string | null): boolean {
  if (paneLooksIdle(plain)) return true
  if (detectPaneState(plain) !== 'typing') return false
  return dimStripped != null && paneLooksIdle(dimStripped)
}

// Locate the live Claude Code input box and return its inner content as
// one string. Bounded strictly to the region between the two most
// recent BOX_SEP_RX separators above the idle footer, so a parked input
// in scrollback (post-turn artifact) is never mistaken for live state.
//
// Returns null when the pane does not have a live input box (no idle
// footer, only one separator, etc.) -- callers should treat null as
// "not enough signal to act, do nothing".
// Fallback for the fresh-session / welcome-screen layout (Claude Code logo +
// model line + cwd, NO idle footer): a delivered message can sit parked in the
// input box before the footer is ever rendered, and the footer-anchored path
// would miss it entirely (return null -> the whole recovery stack goes blind).
// Anchor on the LAST TWO box separators (/^\u2500{10,}/) and treat the span
// between them as the input box ONLY when its first non-empty row starts with
// the \u276F prompt -- otherwise a pair of scrollback rules would be mis-read.
function liveInputBoxFooterless(lines: string[]): string | null {
  const seps: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (BOX_SEP_RX.test(lines[i])) seps.push(i)
  }
  if (seps.length < 2) return null
  const topSep = seps[seps.length - 2]
  const bottomSep = seps[seps.length - 1]
  const inner = lines.slice(topSep + 1, bottomSep)
  const firstNonEmpty = inner.find(l => l.trim().length > 0)
  if (firstNonEmpty == null || !/^\s*\u276F/.test(firstNonEmpty)) return null
  return inner.join('\n')
}

function liveInputBox(pane: string): string | null {
  const lines = pane.split('\n')
  const footerIdx = lines.findIndex(l => IDLE_FOOTER_RX.test(l))
  if (footerIdx < 0) return liveInputBoxFooterless(lines)
  let bottomSep = -1
  for (let i = footerIdx - 1; i >= 0; i--) {
    if (BOX_SEP_RX.test(lines[i])) { bottomSep = i; break }
  }
  if (bottomSep <= 0) return null
  let topSep = -1
  for (let i = bottomSep - 1; i >= 0; i--) {
    if (BOX_SEP_RX.test(lines[i])) { topSep = i; break }
  }
  if (topSep < 0) return null
  return lines.slice(topSep + 1, bottomSep).join('\n')
}

// Marker strings from prompt-safety.ts preambles. We do NOT import them
// to keep this module dependency-free for unit testing; the markers
// here are stable opening phrases pinned to the first sentence of each
// preamble. A prompt-safety.ts test pins the preamble shape so a rename
// will surface as a failing test there, not here.
//
// Each regex requires an extended opening fragment so prose that
// merely echoes the marker ("Let me search for TEAM MEMBER NOTICE in
// the logs", "SECURITY NOTICE -- read carefully before deploying")
// does not trigger a false-positive clear. The longer tail
// (`<trusted-peer source` / `before acting`) is unique enough that a
// random typed sentence is implausible to reproduce it verbatim.
// Whitespace classes (`\s+`) intentionally include newline so a
// terminal-wrapped preamble (TUI re-flow at narrow widths) still
// matches -- that wrapped preamble is the genuine article, not a
// false-positive.
const TRUSTED_PREAMBLE_MARKER = /TEAM MEMBER NOTICE\s+--\s+the next\s+<trusted-peer\s+source/
const UNTRUSTED_PREAMBLE_MARKER = /SECURITY NOTICE\s+--\s+read carefully before acting/

// A "real" opening tag has source="<alphanumeric/colon/underscore/dash>",
// because sanitizeAgentSource() (prompt-safety.ts) strips every other
// character. The preambles themselves reference the tag shape with
// source="..." (three literal full stops), which sanitizeAgentSource
// would scrub -- so a literal "..." source can only originate from the
// preamble text, never from a real wrapped message. Distinguishing on
// the source content is what lets us tell a stale preamble (no real
// tag yet) from a fully-landed message (real tag with a sanitised
// source).
const REAL_OPENING_TAG_RX = /<(?:trusted-peer|untrusted)\s+source="[A-Za-z0-9:_-]+"/

/**
 * Returns true when the pane likely has just-sent text sitting in the
 * Claude Code prompt buffer that the trailing Enter never submitted --
 * i.e. a stuck-after-send-keys state from which a retry-Enter is
 * warranted.
 *
 * Two stuck signatures are handled:
 *
 *   1. A `[Pasted text #N]` placeholder visible in the input box. Claude
 *      Code's bracketed-paste detector lifts long bursts of input into
 *      stubs that do not auto-submit on the trailing Enter. The
 *      placeholder shape is unambiguous, so any occurrence inside the
 *      live input box is treated as stuck.
 *
 *   2. A verbatim payload sitting in the input box. The detector
 *      requires `payloadHint` to be a substring of the live input box's
 *      content, so a parked input the operator typed manually is not
 *      mistaken for a stuck send. The minimum hint length is
 *      configurable via opts.minHintChars (default 16) to keep short
 *      hints from false-positiving on common UI text.
 *
 * Negative cases (returns false):
 *
 *   - The pane is busy (spinner / token counter / esc-to-interrupt) --
 *     the prompt is being processed, no retry needed.
 *   - The pane is not a Claude Code surface (no idle footer found).
 *   - The input box is empty and no paste placeholder is visible.
 *   - The verbatim path is requested but `payloadHint` is shorter than
 *     `minHintChars` (caller passed a too-short hint).
 *
 * @param pane The raw `tmux capture-pane -p` output to inspect.
 * @param payloadHint A substring of the prompt just sent. Used by the
 *   verbatim-detection path; pass an empty string to limit the check
 *   to the placeholder path only.
 * @param opts.minHintChars Minimum length the hint must reach before
 *   the verbatim path is attempted. Default 16.
 */
export function shouldRetrySubmit(
  pane: string,
  payloadHint: string,
  opts: { minHintChars?: number } = {},
): boolean {
  if (!pane || !pane.trim()) return false

  const retryPaneLines = pane.split('\n')

  // Busy pane: the turn is mid-flight, no retry needed. Region-scoped (same
  // as detectPaneState) so a stale token-counter line does not suppress a
  // legitimate retry on an idle pane.
  const retryBusyRegion = retryPaneLines.slice(-BUSY_LIVE_REGION_LINES).join('\n')
  for (const rx of BUSY_INDICATORS) {
    if (rx.test(retryBusyRegion)) return false
  }
  // Footer-region `esc to interrupt` check (same scoping as detectPaneState).
  const retryFooterRegion = retryPaneLines.slice(-LIVE_FOOTER_REGION_LINES).join('\n')
  if (BUSY_ESC_TO_INTERRUPT_RX.test(retryFooterRegion)) return false

  // Path 1: placeholder is unambiguous, retry regardless of hint -- and it is
  // checked BEFORE the idle-footer gate below. The footer beneath a placeholder
  // is version-dependent: the current build keeps the normal idle footer, an
  // older build showed `paste again to expand` (failing IDLE_FOOTER_RX). The
  // old ordering (footer gate first) therefore returned false on the older
  // shape -- the very state the recovery exists to catch. detectsPastePlaceholder
  // scopes the match to the live input box, so a `[Pasted text #N]` quoted in a
  // reply line or scrollback cannot trigger a spurious clear-and-resend.
  if (detectsPastePlaceholder(pane)) return true

  // Without an idle footer the pane is either not Claude Code or in an
  // unknown render state. Be conservative and skip.
  if (!IDLE_FOOTER_RX.test(pane)) return false

  const inputBox = liveInputBox(pane)
  if (inputBox == null) return false

  // Path 2: verbatim payload parked in the input box.
  // Clamp the minimum hint length to >= 1. minHintChars=0 paired with
  // an empty payloadHint would otherwise let `inputBox.includes("")`
  // return true for every non-empty box, retrying Enter on every idle
  // pane. Non-finite inputs (NaN, Infinity) fall back to the default
  // so a malformed caller can't silently disable or saturate the
  // verbatim path either.
  const rawMin = opts.minHintChars
  const safeMin = typeof rawMin === 'number' && Number.isFinite(rawMin) ? rawMin : 16
  const minHint = Math.max(safeMin, 1)
  if (payloadHint.length < minHint) return false
  return inputBox.includes(payloadHint)
}

/**
 * Returns true when the pane shows a stale preamble from a wrapped
 * message that never fully landed -- a `SECURITY NOTICE` (untrusted) or
 * `TEAM MEMBER NOTICE` (trusted-peer) preamble visible in the input
 * box without a matching real opening tag (`<untrusted source="...">`
 * or `<trusted-peer source="...">` with a sanitised source value).
 *
 * When this returns true the caller must issue a buffer-clear (Ctrl-U)
 * before sending the next message. Otherwise a fresh prompt would be
 * concatenated onto the stale preamble and the receiving agent could
 * inherit its trust semantics: e.g. an untrusted external payload
 * landing behind a stale `TEAM MEMBER NOTICE` preamble could be read
 * as if it came from a trusted peer.
 *
 * The check is scoped strictly to the live input box (between the two
 * most recent box-separators above the idle footer). A preamble in
 * deep scrollback (a long-ago turn's artifact) never triggers a clear.
 *
 * Distinguishing a stale preamble from a fully-landed message relies
 * on the source-attribute content: real wrapped messages always carry
 * a sanitised `source="agent:NAME"` (or similar) value, while the
 * preambles themselves only reference the tag shape with the literal
 * placeholder `source="..."`. The literal three full stops are
 * impossible to produce from `sanitizeAgentSource()`, so their
 * presence proves we are looking at preamble text rather than a real
 * opening tag.
 */
export function shouldClearTruncatedPreamble(pane: string): boolean {
  if (!pane) return false
  const inputBox = liveInputBox(pane)
  if (inputBox == null) return false

  const hasPreamble =
    TRUSTED_PREAMBLE_MARKER.test(inputBox) ||
    UNTRUSTED_PREAMBLE_MARKER.test(inputBox)
  if (!hasPreamble) return false

  // A real opening tag means the wrapped content landed -- not stuck.
  if (REAL_OPENING_TAG_RX.test(inputBox)) return false

  return true
}

export type SubmitFollowupAction = 'retry-enter' | 'clear-and-resend' | 'done' | 'give-up'

/**
 * Decide what the post-send-keys loop should do next, given the
 * current pane snapshot and how many retry-Enter attempts have already
 * been made. Returns one of three discrete actions so the caller can
 * branch without re-running the detection logic itself.
 *
 *   - 'done'             -- the pane is no longer a RECOGNISED stuck signature
 *                           (no placeholder, no verbatim-parked payload). This
 *                           is NEGATIVE evidence only -- it does NOT prove the
 *                           prompt landed. decideSubmitVerdict wraps this action
 *                           and gates the actual 'landed' verdict on POSITIVE
 *                           evidence (busy turn / transcript echo / clean across
 *                           the budget); the send loop calls THAT, not this.
 *   - 'retry-enter'      -- the pane shows a VERBATIM stuck send; send
 *                           another Enter and re-sample. (A plain Enter
 *                           submits verbatim parked text.)
 *   - 'clear-and-resend' -- the pane shows a `[Pasted text #N]`
 *                           placeholder. A plain Enter is PROVEN not to
 *                           submit it (it merely expands the stub to
 *                           parked verbatim text, still unsubmitted), so
 *                           the caller must clear the buffer and re-send
 *                           the payload defensively instead.
 *   - 'give-up'          -- the retry budget is spent, or the capture
 *                           failed and we cannot tell whether retry would
 *                           help. Caller should log a warning and move on.
 *
 * Splitting the decision out as pure logic keeps the I/O-bound loop in
 * src/web/agent-process.ts trivially testable without mocking tmux or
 * child_process: feed snapshot strings + attempt counters in, assert
 * the action out.
 *
 * @param pane         The most recent capture-pane snapshot, or null
 *                     if the capture itself failed.
 * @param payloadHint  Substring of the just-sent prompt, used for the
 *                     verbatim-stuck detection path. Pass empty to
 *                     restrict detection to the placeholder path.
 * @param attempt      How many retry-Enters have ALREADY been sent
 *                     (0 on the first decision after the initial send).
 * @param maxAttempts  How many retry-Enters the caller is willing to
 *                     send total. The decision returns 'give-up' once
 *                     attempt >= maxAttempts and the pane is still
 *                     stuck.
 */
export function decideSubmitFollowup(
  pane: string | null,
  payloadHint: string,
  attempt: number,
  maxAttempts: number,
): SubmitFollowupAction {
  if (pane == null) return 'give-up'
  if (!shouldRetrySubmit(pane, payloadHint)) return 'done'
  if (attempt >= maxAttempts) return 'give-up'
  // A placeholder will NOT submit on a plain Enter (proven empirically: Enter
  // only expands the stub to still-parked verbatim text). Route it to the
  // clear-and-resend recovery instead of wasting a retry-Enter on it.
  if (detectsPastePlaceholder(pane)) return 'clear-and-resend'
  return 'retry-enter'
}

// =============================================================================
// Positive-evidence landing verdict (false-landed fix, incident 4fddd480)
// =============================================================================
//
// decideSubmitFollowup returns 'done' as soon as the pane is no longer a
// RECOGNISED stuck signature (no `[Pasted text #N]` placeholder, and the
// just-sent payload is not a verbatim substring of the input box). The send
// loop historically read that 'done' as "landed". That is NEGATIVE evidence
// only -- "the stuck-detector stopped matching" -- NOT proof a turn started.
//
// Incident 4fddd480 (2026-07-13, msg 1105 mr-wolfe -> charlie): bracketed-paste
// artifacts mutated the box so the full wrapped "TEAM MEMBER NOTICE ..." prompt
// no longer contained the payloadHint verbatim (a terminal hard-wrap split the
// hint mid-word). shouldRetrySubmit went false, the loop reported 'landed' in
// ~4s, the router marked the message delivered -- yet the text sat parked in
// charlie's box for 20+ minutes with no turn ever started.
//
// The fix requires POSITIVE evidence before 'landed':
//   - the live input box is provably CLEAN (empty -- no parked payload, no
//     parked TRUSTED/UNTRUSTED preamble marker, no paste placeholder), AND
//   - EITHER the pane shows real turn activity (busy: spinner / token counter /
//     esc-to-interrupt -- the existing busy detection) OR the sent payload's
//     leading fragment is echoed into the transcript region ABOVE the box (the
//     submitted user turn rendered), i.e. the prompt demonstrably ran.
//
// A box that is clean but shows NO turn/transcript evidence is AMBIGUOUS (an
// accepted-but-scrolled fast turn, or a send that silently produced nothing):
// the loop re-samples, and only at the retry budget does it settle -- 'landed'
// ONLY if the box stayed clean across every sample, otherwise 'gave-up'. A box
// holding unexplained parked content (the 1105 mutated-preamble shape) is never
// 'landed'; it resolves to 'gave-up' so the router leaves the message pending
// and the stale-parked-input janitor + readiness gate recover it, rather than a
// false delivered.

/** Landing evidence of a pane that is NOT a recognised stuck signature. */
export type LandingEvidence =
  | 'landed'       // clean box + real turn activity, or clean box + transcript echo
  | 'clean-quiet'  // clean box, but no turn/transcript evidence yet (ambiguous)
  | 'unexplained'  // parked/unreadable box, no positive evidence (never landed)

// Minimum length (after whitespace strip) the payload fragment must reach before
// the transcript-echo check trusts a match -- mirrors shouldRetrySubmit's
// minHintChars floor so a short, generic fragment cannot match arbitrary
// transcript prose.
const ECHO_MIN_HINT_CHARS = 16

// Everything ABOVE the live input box (the rendered transcript region), or null
// when the pane has no live input box (no idle footer / no framing separators).
// The box is the span between the two most recent BOX_SEP_RX separators above
// the idle footer -- the SAME anchoring liveInputBox() uses -- so what is
// returned is strictly the transcript, never the box itself. The footer is found
// from the BOTTOM so a footer-looking line quoted in scrollback cannot shift the
// scope.
function transcriptAboveInputBox(pane: string): string | null {
  const lines = pane.split('\n')
  let footerIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (IDLE_FOOTER_RX.test(lines[i])) { footerIdx = i; break }
  }
  if (footerIdx < 0) return null
  let bottomSep = -1
  for (let i = footerIdx - 1; i >= 0; i--) {
    if (BOX_SEP_RX.test(lines[i])) { bottomSep = i; break }
  }
  if (bottomSep <= 0) return null
  let topSep = -1
  for (let i = bottomSep - 1; i >= 0; i--) {
    if (BOX_SEP_RX.test(lines[i])) { topSep = i; break }
  }
  if (topSep < 0) return null
  return lines.slice(0, topSep).join('\n')
}

/**
 * True when the payload's leading fragment is echoed into the transcript region
 * ABOVE the live input box -- positive evidence the submitted user turn rendered
 * (the prompt ran, even if the turn already finished and the pane is idle again).
 *
 * Whitespace is STRIPPED (not collapsed) from both the transcript and the hint
 * before the substring test: Claude Code re-wraps the submitted user turn at the
 * pane width, and a hard wrap can split the fragment mid-word (`agent:mr-w` /
 * `olfe">`). Collapsing to single spaces would still miss that (the original had
 * no space there); stripping all whitespace makes the match wrap- AND
 * word-split-robust. The fragment is long and distinctive (a wrapped-message
 * preamble + opening tag), so an all-whitespace-stripped substring collision
 * with unrelated prose is implausible; the check is additionally only consulted
 * on a provably CLEAN box (see classifyLandingEvidence), where the payload is
 * NOT parked in the box, so a match can only come from a rendered turn.
 *
 * Returns false when the pane has no transcript region, or the stripped hint is
 * shorter than ECHO_MIN_HINT_CHARS (too short to trust).
 */
export function payloadEchoedAboveBox(pane: string, payloadHint: string): boolean {
  if (!pane || !payloadHint) return false
  const needle = payloadHint.replace(/\s+/g, '')
  if (needle.length < ECHO_MIN_HINT_CHARS) return false
  const above = transcriptAboveInputBox(pane)
  if (above == null) return false
  return above.replace(/\s+/g, '').includes(needle)
}

/**
 * Classify the landing evidence of a pane that is NOT a recognised stuck
 * signature (the caller has already ruled out placeholder / verbatim-parked via
 * shouldRetrySubmit). Pure + dependency-free.
 *
 *   - 'busy' pane    -> 'landed'. A real turn is running. sendPromptToSession's
 *     pre-flight wait-until-idle gate means the pane was idle immediately before
 *     the send, so a live turn NOW is our prompt's turn -- unambiguous positive
 *     evidence. (A paste placeholder also reads 'busy' in detectPaneState, but
 *     shouldRetrySubmit caught it upstream, so a 'busy' here is a real turn,
 *     never a placeholder.)
 *   - clean idle box -> 'landed' iff the payload echoed into the transcript
 *     above the box, else 'clean-quiet' (box provably empty, but nothing proves
 *     the turn ran yet -- resolved by the caller across samples).
 *   - anything else ('typing' = parked non-hint text, i.e. the 1105 mutated
 *     preamble; 'unknown' = unreadable surface; 'error' = wedged) ->
 *     'unexplained': no positive evidence, and a non-empty box means the payload
 *     may still be parked. Never 'landed'.
 */
export function classifyLandingEvidence(pane: string, payloadHint: string): LandingEvidence {
  const state = detectPaneState(pane)
  if (state === 'busy') return 'landed'
  if (state === 'idle') {
    return payloadEchoedAboveBox(pane, payloadHint) ? 'landed' : 'clean-quiet'
  }
  return 'unexplained'
}

/**
 * A submit verdict enriched with the positive-landing decision. Supersets the
 * SubmitFollowupAction actions: 'done' becomes an explicit evidence-gated
 * 'landed', plus a 'resample' step for the ambiguous clean-but-quiet box.
 */
export type SubmitVerdict =
  | 'retry-enter'       // verbatim stuck: a plain Enter submits it
  | 'clear-and-resend'  // paste placeholder: clear the buffer + re-send the chunks
  | 'resample'          // clean-but-quiet / unexplained parked: poll again, no action
  | 'landed'            // POSITIVE evidence, or clean across the whole budget
  | 'gave-up'           // budget spent with the box never provably landed

export interface SubmitVerdictState {
  /** Poll iterations already decided (0 before the first sample). Bounds the
   *  loop against maxAttempts exactly as the old attempt counter did. */
  attempt: number
  /** True once ANY sample held unexplained parked/unreadable box content, so a
   *  later clean-but-quiet box at the budget resolves to 'gave-up' (something was
   *  parked and never seen to land) rather than a false 'landed'. */
  sawUnexplained: boolean
}

export interface SubmitVerdictDecision {
  verdict: SubmitVerdict
  next: SubmitVerdictState
}

/**
 * Pure post-send verdict with POSITIVE-evidence landing (incident 4fddd480).
 * Layers on decideSubmitFollowup: the recognised-stuck actions (retry-enter /
 * clear-and-resend), the null-capture give-up, and the stuck-at-budget give-up
 * all pass through unchanged. Only decideSubmitFollowup's 'done' -- which means
 * merely "no recognised stuck signature" and was the false-landed site -- is
 * re-decided here against classifyLandingEvidence:
 *
 *   - positive evidence (busy turn, or clean box + transcript echo) -> 'landed'.
 *   - clean-but-quiet or unexplained parked box -> 'resample' while the budget
 *     lasts; at the budget, 'landed' ONLY if the box stayed clean across every
 *     sample (accepted-but-scrolled fast turn), else 'gave-up'.
 *
 * Dependency-free + returns {verdict, next} (the codebase's decision-state
 * convention, cf. decideStuckInputRecovery / decidePaneErrorAlert) so the
 * I/O-bound loop in agent-process.ts stays trivially testable: feed snapshot
 * strings + the persisted state in, assert the verdict + next state out.
 *
 * @param pane        The latest capture-pane snapshot, or null on capture fail.
 * @param payloadHint Substring of the just-sent prompt (verbatim + echo paths).
 * @param prev        Persisted per-loop state (attempt counter + sawUnexplained).
 * @param maxAttempts Retry/resample budget; the terminal decision is made once
 *                    prev.attempt >= maxAttempts.
 */
export function decideSubmitVerdict(
  pane: string | null,
  payloadHint: string,
  prev: SubmitVerdictState,
  maxAttempts: number,
): SubmitVerdictDecision {
  const { attempt, sawUnexplained: prevSaw } = prev
  const nextAttempt = attempt + 1
  const base = decideSubmitFollowup(pane, payloadHint, attempt, maxAttempts)

  // Recognised-stuck actions pass through unchanged -- decideSubmitFollowup
  // already owns them. (retry-enter / clear-and-resend keep their names.)
  if (base === 'retry-enter' || base === 'clear-and-resend') {
    return { verdict: base, next: { attempt: nextAttempt, sawUnexplained: prevSaw } }
  }
  // Null-capture give-up and stuck-at-budget give-up. decideSubmitFollowup spells
  // it 'give-up'; SendResult / this verdict spell it 'gave-up' -- map across.
  if (base === 'give-up') {
    return { verdict: 'gave-up', next: { attempt: nextAttempt, sawUnexplained: prevSaw } }
  }

  // base === 'done': the false-landed site. 'done' only means "no recognised
  // stuck signature", which is ALSO true of the 1105 mutated-preamble parked
  // box. Gate 'landed' on positive evidence. (base === 'done' implies pane !=
  // null -- decideSubmitFollowup gives up on a null capture -- but classify
  // defensively anyway.)
  const evidence: LandingEvidence = pane == null ? 'unexplained' : classifyLandingEvidence(pane, payloadHint)
  if (evidence === 'landed') {
    return { verdict: 'landed', next: { attempt: nextAttempt, sawUnexplained: prevSaw } }
  }
  const sawUnexplained = prevSaw || evidence === 'unexplained'
  if (attempt < maxAttempts) {
    // Ambiguous (clean-but-quiet or unexplained parked): poll again. The
    // terminal decision is made once the budget is spent.
    return { verdict: 'resample', next: { attempt: nextAttempt, sawUnexplained } }
  }
  // Budget spent. Land ONLY if every sample stayed clean (accepted-but-scrolled
  // fast turn); if any sample held unexplained parked content, give up so the
  // never-confirmed send is re-delivered rather than falsely marked delivered.
  return { verdict: sawUnexplained ? 'gave-up' : 'landed', next: { attempt: nextAttempt, sawUnexplained } }
}

/** What an unconfirmed ('gave-up') send may do with the target's input box. */
export type ParkedPromptRollback = 'preserve-then-clear' | 'hands-off'

/**
 * Decide whether a send that ended in 'gave-up' may roll its own text back out
 * of the target's input box.
 *
 * 'gave-up' historically LEFT the typed prompt parked there, and a multi-row
 * parked input blocks the pane until somebody presses Enter by hand: on
 * 2026-08-01 that wedged the coordinator's own panel for 24 minutes, and the
 * downstream queue watchdog then paged the owner about a purely internal wedge
 * (card 919b96a8). So the loop takes its own text back -- but ONLY when the box
 * provably holds OUR payload:
 *
 *   - 'preserve-then-clear' -- the box still matches the stuck signature of THIS
 *     send: the `[Pasted text #N]` placeholder our chunk stream tripped, or the
 *     payload verbatim. The caller must write the content out to a file FIRST
 *     and only then clear the buffer (preserve-before-clearing).
 *   - 'hands-off' -- anything else: a failed capture, a busy pane, a clean box,
 *     or UNEXPLAINED parked content (decideSubmitVerdict's third landing class --
 *     a human's draft, another sender's stranded message, a bracketed-paste-
 *     mutated payload we can no longer attribute to ourselves). Never cleared.
 *
 * Pure, so the "never clear what is not ours" invariant is testable without tmux.
 */
export function decideParkedPromptRollback(pane: string | null, payloadHint: string): ParkedPromptRollback {
  if (pane == null) return 'hands-off'
  return shouldRetrySubmit(pane, payloadHint) ? 'preserve-then-clear' : 'hands-off'
}

export interface PaneErrorAlertState {
  /** When the session was first observed in the error state during the
   * current spell, or null when there is no active spell. */
  firstSeenAt: number | null
  /** When the last alert was sent for this session, or null if never. */
  lastAlertAt: number | null
  /** When the session was last observed in the error state. Used to
   * keep a spell alive across brief non-error blips (a flapping
   * capture, or a busy spinner mid-flight) so the confirm window is
   * not reset to zero by a single non-error tick. */
  lastErrorAt: number | null
}

export interface PaneErrorAlertThresholds {
  /** How long the session must stay in error before the first alert, so
   * a transient one-tick error that clears on its own is not reported. */
  confirmMs: number
  /** Minimum gap between repeated alerts within one unbroken error
   * spell, so a wedged session does not alert on every monitor tick. */
  dedupMs: number
  /** How long the session must be continuously error-free before an
   * active spell is cleared. A single non-error tick (null capture, a
   * mid-flight busy spinner) must NOT reset the spell, otherwise a
   * genuinely wedged but flapping session never reaches the confirm
   * window and never alerts. */
  clearMs: number
}

export interface PaneErrorAlertDecision {
  alert: boolean
  next: PaneErrorAlertState
}

/**
 * Pure state machine for "should the monitor alert that this session is
 * wedged in the thinking-block error". Dependency-free so it is
 * unit-testable without tmux or timers: feed the current error
 * observation, the previous persisted state and a clock, get back the
 * alert decision plus the next state to persist.
 *
 * Deliberately ALERT-only -- it never decides to reset or restart a
 * session. Auto-reset destroys the agent's in-context working memory,
 * and while the deep trigger is not fully understood a false positive
 * must not nuke a healthy agent. A human (or the hub agent) acts on the
 * alert. Guards that keep it quiet: the first sighting only records
 * (never alerts, so an error must be seen on at least two ticks even
 * when confirmMs is 0), a confirm window (the error must persist), and a
 * dedup window (one alert per spell, not per tick). A non-error tick
 * does NOT immediately end a spell -- it ends only after clearMs of
 * continuous error-free time, so a flapping capture (null / mid-flight
 * busy between error frames) cannot starve the confirm window. A
 * future-dated stored timestamp (wall-clock skew, NTP correction)
 * restarts the spell instead of stalling the deltas negative.
 */
export function decidePaneErrorAlert(
  isError: boolean,
  prev: PaneErrorAlertState,
  now: number,
  thresholds: PaneErrorAlertThresholds,
): PaneErrorAlertDecision {
  if (!isError) {
    // No active spell: nothing to track.
    if (prev.firstSeenAt === null) {
      return { alert: false, next: { firstSeenAt: null, lastAlertAt: null, lastErrorAt: null } }
    }
    // Active spell: clear only after a sustained error-free gap, so a
    // single flapping non-error tick does not reset the confirm window.
    // A future-dated lastErrorAt (clock skew) counts as "clear now".
    const errorFreeFor = prev.lastErrorAt === null ? Infinity : now - prev.lastErrorAt
    if (errorFreeFor >= thresholds.clearMs || errorFreeFor < 0) {
      return { alert: false, next: { firstSeenAt: null, lastAlertAt: null, lastErrorAt: null } }
    }
    // Hold the spell unchanged.
    return { alert: false, next: { ...prev } }
  }
  // First sighting in this spell: record only, never alert. Guarantees
  // at least two observations before any alert, independent of confirmMs.
  if (prev.firstSeenAt === null) {
    return { alert: false, next: { firstSeenAt: now, lastAlertAt: prev.lastAlertAt, lastErrorAt: now } }
  }
  // Clock skew: a stored timestamp in the future relative to now would
  // drive the deltas negative and stall the machine silently. Restart
  // the spell from now and drop the stale alert time.
  if (now < prev.firstSeenAt || (prev.lastAlertAt !== null && now < prev.lastAlertAt)) {
    return { alert: false, next: { firstSeenAt: now, lastAlertAt: null, lastErrorAt: now } }
  }
  const sustained = now - prev.firstSeenAt >= thresholds.confirmMs
  if (!sustained) {
    return { alert: false, next: { firstSeenAt: prev.firstSeenAt, lastAlertAt: prev.lastAlertAt, lastErrorAt: now } }
  }
  const dedupElapsed = prev.lastAlertAt === null || now - prev.lastAlertAt >= thresholds.dedupMs
  if (dedupElapsed) {
    return { alert: true, next: { firstSeenAt: prev.firstSeenAt, lastAlertAt: now, lastErrorAt: now } }
  }
  return { alert: false, next: { firstSeenAt: prev.firstSeenAt, lastAlertAt: prev.lastAlertAt, lastErrorAt: now } }
}

export type DialogEscalationAction = 'notify-wolfe' | 'fallback-gabor' | 'none'

export interface DialogEscalationState {
  /** When the coordinator (mr-wolfe) was last flagged for the CURRENT dialog
   * spell, or null when no spell is active / not yet flagged. Doubles as the
   * phase-1 dedup anchor AND the grace-timer origin. The caller deletes the
   * whole entry when the dialog disappears, so a future dialog starts as a
   * fresh spell. */
  wolfeFlaggedAt: number | null
  /** When the direct owner (Gabor) fallback was sent during the CURRENT spell,
   * or null if not yet. Gates the fallback to at most once per spell -- a
   * phase-1 re-flag deliberately does NOT reset it. */
  gaborNotifiedAt: number | null
}

export interface DialogEscalationThresholds {
  /** How long after the coordinator was flagged, with the dialog still up,
   * before the direct owner fallback fires (the last-resort safety net). */
  graceMs: number
  /** Minimum gap before the coordinator is re-flagged for the SAME persisting
   * dialog, so a long-stuck dialog is periodically resurfaced to the
   * coordinator without flooding its inbox. */
  dedupMs: number
}

export interface DialogEscalationDecision {
  action: DialogEscalationAction
  next: DialogEscalationState
}

/**
 * Pure two-phase escalation decision for a session parked in a permission
 * dialog. Phase 1 flags the coordinator (mr-wolfe) via an inter-agent message
 * so it can resolve the dialog or humanise the decision for the owner; phase 2
 * falls back to a DIRECT owner alert only if the coordinator has not cleared
 * the dialog within the grace window. Dependency-free so it is unit-testable
 * without tmux / db: feed the persisted per-session state + a clock, get back
 * the action to take + the next state to persist.
 *
 * The caller invokes this each time the menu-recovery machine re-confirms the
 * dialog (~every MENU_RECOVER_DEDUP_MS while it persists), so the cadence is:
 *   - first sustained sighting            -> 'notify-wolfe'   (flag coordinator)
 *   - within graceMs of the flag          -> 'none'
 *   - graceMs elapsed, still up, owner not yet told -> 'fallback-gabor'
 *   - owner already told this spell        -> 'none'
 *   - dedupMs elapsed since the flag, still up -> 'notify-wolfe' again
 *     (re-engage the coordinator; the owner-fallback gate is NOT reset, so the
 *     owner is still alerted at most once per spell).
 *
 * A future-dated stored timestamp (wall-clock skew / NTP correction) counts as
 * "flag now" rather than stalling the deltas negative, mirroring
 * decidePaneErrorAlert's skew guard.
 */
export function decideDialogEscalation(
  state: DialogEscalationState,
  now: number,
  thresholds: DialogEscalationThresholds,
): DialogEscalationDecision {
  const { wolfeFlaggedAt, gaborNotifiedAt } = state
  // Clock skew: a stored flag time in the future would drive the deltas
  // negative and stall the machine. Restart the spell from now and drop the
  // stale owner-fallback time.
  if (wolfeFlaggedAt !== null && now < wolfeFlaggedAt) {
    return { action: 'notify-wolfe', next: { wolfeFlaggedAt: now, gaborNotifiedAt: null } }
  }
  // Phase 1: the first flag of the spell, or a dedup-throttled re-flag while
  // the same dialog persists. The re-flag preserves gaborNotifiedAt so the
  // owner is not re-alerted.
  if (wolfeFlaggedAt === null || now - wolfeFlaggedAt >= thresholds.dedupMs) {
    return { action: 'notify-wolfe', next: { wolfeFlaggedAt: now, gaborNotifiedAt } }
  }
  // Phase 2: coordinator flagged but the grace window has elapsed with the
  // dialog still up -> direct owner fallback, at most once per spell.
  if (now - wolfeFlaggedAt >= thresholds.graceMs && gaborNotifiedAt === null) {
    return { action: 'fallback-gabor', next: { wolfeFlaggedAt, gaborNotifiedAt: now } }
  }
  return { action: 'none', next: state }
}

// A stable signature of the text parked in the live input box, or null
// when the pane is not in the 'typing' (parked-input) state.
//
// Used by the stuck-input watcher to decide whether a swallowed Enter on
// the channel-notification path left a message stranded in the prompt
// box. Whitespace is collapsed so a cursor blink or a terminal re-flow at
// a different width does not read as "new text" and reset the recovery
// confirm window. Returns null (not an empty string) when there is no
// parked text so callers can branch on "is anything parked at all".
export function stuckInputSignature(pane: string): string | null {
  if (detectPaneState(pane) !== 'typing') return null
  const box = liveInputBox(pane)
  if (box == null) return null
  const sig = box.replace(/\s+/g, ' ').trim()
  return sig.length > 0 ? sig : null
}

export interface ParkedChannelInput {
  /** True only when the parked block is captured intact -- opening
   * <channel source="plugin:..."> tag WITH a chat_id AND a closing
   * </channel>. False when the box holds a channel block whose header has
   * scrolled/truncated out of the capture (chat_id unrecoverable), so a
   * caller must NOT verbatim re-inject it (a partial re-inject could answer
   * the wrong chat_id -- worse than a delayed submit). */
  complete: boolean
  /** The complete <channel>...</channel> block, whitespace-collapsed, when
   * complete; null when truncated. Safe to re-inject verbatim. */
  block: string | null
  /** The recovered chat_id when complete; null otherwise. */
  chatId: string | null
}

// Classify the live input box as a stranded CHANNEL notification, or null
// when it is not ours to touch. Returns null when the pane is not parked
// ('typing'), the box is empty, OR the parked text is a HUMAN's own
// hand-typed draft (no <channel source="plugin:..."> marker) -- the
// stuck-input watcher must leave a human draft alone. When a channel block
// IS parked, the `complete` flag is the truncation-guard: only a complete
// capture (header + chat_id + closing tag present) is safe to re-inject.
//
// The captured box is whitespace-collapsed first because liveInputBox()
// preserves the terminal-wrap newlines, which would otherwise split the
// <channel> tag attributes across lines and defeat the match.
export function parkedChannelInput(pane: string): ParkedChannelInput | null {
  if (detectPaneState(pane) !== 'typing') return null
  const box = liveInputBox(pane)
  if (box == null) return null
  const flat = box.replace(/\s+/g, ' ').trim()
  if (!/<channel\s+source="plugin:/.test(flat)) return null // human draft -> not ours
  const m = flat.match(/<channel\s+source="plugin:[^"]*"[^>]*>.*?<\/channel>/)
  if (!m) return { complete: false, block: null, chatId: null } // opening tag only -> truncated
  const block = m[0]
  const cm = block.match(/\bchat_id="([^"]+)"/)
  // A terminal wrap can land INSIDE chat_id="..."; whitespace-collapse then
  // yields a corrupted id with an embedded space. Reject it (stay on Enter)
  // rather than re-inject to a wrong chat_id.
  if (!cm || /\s/.test(cm[1])) return { complete: false, block, chatId: null }
  return { complete: true, block, chatId: cm[1] }
}

// The whitespace-collapsed text currently parked in the live input box when
// the pane is 'typing', or null when nothing is parked. Used by SUB-AGENT
// stuck-input recovery to re-inject a delivered message that the TUI failed to
// submit and that is NOT a <channel> block (e.g. an inter-agent notification).
// A sub-agent's input box never holds a human-typed draft -- only router- or
// plugin-delivered messages -- so re-injecting its parked text is safe there.
// The collapse mirrors parkedChannelInput(): terminal wrap is folded into
// single spaces, yielding a single-line, reliably submittable message.
export function parkedInputText(pane: string): string | null {
  if (detectPaneState(pane) !== 'typing') return null
  const box = liveInputBox(pane)
  if (box == null) return null
  // Collapse terminal wrap, then strip the leading ❯ prompt marker so the
  // re-injected text is the message itself, not the prompt glyph.
  const flat = box.replace(/\s+/g, ' ').trim().replace(/^❯\s*/, '').trim()
  return flat.length > 0 ? flat : null
}

/**
 * PURE decision for the post-resume LIVENESS probe (2026-07 audit, card
 * f8de7b37). shouldEscalateAfterResume() only proves the process + channel
 * plugin came back after a --continue resume; it CANNOT tell a resumed session
 * whose TUI actually accepts input from one whose render loop is wedged (poller
 * alive, TUI frozen -- the 2026-06-02 stdio-wedge shape). This backstops it with
 * a stdin-SAFE liveness read: the caller captures the pane TWICE, a few seconds
 * apart, WITHOUT sending any keystroke (a bare Enter would submit whatever is
 * parked in an idle box; typing would answer a permission dialog -- the aa4c659
 * precedent), then passes both samples here.
 *
 * Escalate to a fresh respawn ONLY when the pane is genuinely frozen:
 *   - not a live idle footer (paneLooksIdle) -- a ready pane is healthy;
 *   - not an active turn (detectPaneState === 'busy') -- a working pane is healthy;
 *   - not a permission/approval dialog (detectsPermissionDialog) -- that is a
 *     legitimate WAIT on operator input, never a wedge; respawning it would abort
 *     the pending turn;
 *   - no parked input text (parkedInputText) -- a stranded message is the
 *     stuck-input-watcher's job (it can re-submit it), not a render freeze, and a
 *     respawn would discard the parked message;
 *   - AND the two samples are byte-identical -- a pane still rendering / mid-boot
 *     differs between captures, so an evolving pane is given more time.
 * Every guard errs toward NOT respawning (preserving conversation context).
 * Fail-open: a null capture (tmux miss) does NOT escalate -- the pid/plugin guard
 * already ran, and a lone capture miss is not evidence of a wedge.
 */
export function shouldEscalateFrozenPane(sampleA: string | null, sampleB: string | null): boolean {
  if (sampleA == null || sampleB == null) return false
  if (paneLooksIdle(sampleA) || paneLooksIdle(sampleB)) return false
  if (detectPaneState(sampleA) === 'busy' || detectPaneState(sampleB) === 'busy') return false
  if (detectsPermissionDialog(sampleA) || detectsPermissionDialog(sampleB)) return false
  if (parkedInputText(sampleA) != null || parkedInputText(sampleB) != null) return false
  return sampleA === sampleB
}

// A scheduled prompt (heartbeat / task) whose closing Enter was swallowed sits
// PARKED in the live input box, pinning the pane 'typing' so every later task
// defers. The schedule-runner resubmit ladder must recognise that reliably --
// but the old whole-pane `pane.includes(marker)` check had two false-landed
// defects (incident class 4fddd480, card 5e5cfefc):
//   (a) a terminal hard wrap splits the marker mid-word (`[Utemezett fela` /
//       `dat: name]`), so the contiguous marker is no longer a substring: the
//       parked prompt reads as delivered and is silently dropped (stuck=false
//       -> action 'none'); and
//   (b) scanning the WHOLE pane let a marker echoed in the TRANSCRIPT from an
//       already-landed earlier run count as "stuck", firing a spurious Enter
//       into an innocent (possibly human) draft parked in the box.
//
// Positive-evidence rule, scoped strictly to the LIVE input box (liveInputBox,
// never scrollback): the pane must be 'typing' (something IS parked) AND the
// box must be provably OUR prompt -- EITHER it contains the marker OR the whole
// box is a contiguous fragment of the sent prompt (the marker scrolled out of
// the visible box). Whitespace is STRIPPED (not collapsed) on both sides so a
// mid-word hard wrap still matches (the (a) fix, mirroring payloadEchoedAboveBox);
// the leading `❯` prompt glyph is dropped so a box fragment can substring-match
// against the caret-free prompt body. The fragment path reuses the transcript-
// echo floor (ECHO_MIN_HINT_CHARS) so a trivially short box cannot coincidentally
// match the long prompt. Scoping to the box (not the pane) is the (b) fix.
//
// KNOWN LIMIT: a prompt so tall that even its first `❯` row has scrolled out of
// the visible box reads 'idle' (PARKED_INPUT_RX needs the caret), so this
// returns false -- no worse than the old whole-pane check, whose marker had
// likewise scrolled out of the capture. Pure + dependency-free.
export function scheduledPromptParked(pane: string, marker: string, fullPrompt: string): boolean {
  if (detectPaneState(pane) !== 'typing') return false
  const box = liveInputBox(pane)
  if (box == null) return false
  const strippedBox = box.replace(/\s+/g, '').replace(/^❯/, '')
  if (strippedBox.length === 0) return false
  const strippedMarker = marker.replace(/\s+/g, '')
  if (strippedMarker.length > 0 && strippedBox.includes(strippedMarker)) return true
  // Marker scrolled out of the visible box: the box then shows only a contiguous
  // slice of the parked prompt. Gate on a minimum length so a short box cannot
  // coincidentally substring-match the prompt body.
  if (strippedBox.length < ECHO_MIN_HINT_CHARS) return false
  return fullPrompt.replace(/\s+/g, '').includes(strippedBox)
}

// How many VISUAL rows the live input box content occupies, ignoring the
// bare prompt glyph and blank padding. The caller uses this to choose the
// right submit keystroke: a MULTI-row parked input must NOT be submitted with
// a bare Enter, because in the Claude TUI a plain Enter on a wrapped /
// multi-line buffer inserts a newline instead of submitting (see
// agent-process.ts:833) -- a single-row buffer submits on Enter.
//
// Counts the non-empty rows of liveInputBox() after stripping the leading `❯`
// prompt marker; an empty box (`❯ ` only) or no box at all -> 0. Pure: no
// tmux, only the captured text.
export function parkedInputRowCount(pane: string): number {
  const box = liveInputBox(pane)
  if (box == null) return 0
  return box
    .split('\n')
    .map((row) => row.replace(/^\s*❯/, '').trim())
    .filter((row) => row.length > 0).length
}

// Post-submit verification with POSITIVE-evidence landing (incident class
// 4fddd480, card 5e5cfefc). `prevSig` is stuckInputSignature(pane) captured
// BEFORE the submit attempt (the exact text that was parked). `paneAfter` is a
// fresh capture taken AFTER it. Returns true ONLY on positive evidence that the
// parked text actually became a turn -- NOT merely that the old signature
// stopped matching:
//   - paneAfter null (capture failed)             -> false: cannot confirm.
//   - pane is busy                                 -> true: a real turn started.
//   - the IDENTICAL signature is still parked      -> false: Enter was swallowed.
//   - otherwise (box cleared, or DIFFERENT text now parked) -> true ONLY if the
//     previously-parked text is echoed as a rendered turn in the transcript
//     ABOVE the box; else false.
//
// The former rule ("any signature change == landed") treated a cleared-but-
// never-ran box and a different-draft-now-parked box as landed -- negative
// evidence that hid a genuinely lost message. A box that merely went empty
// proves nothing (the text could have been cleared without ever running), and
// different parked text proves nothing about OUR text; both now require the
// transcript echo before landing.
//
// The leading `❯` input-prompt glyph is stripped from prevSig before the echo
// check: it is an input-box artifact and never appears in the rendered
// transcript (a submitted turn renders under a `>` marker, not `❯`), so leaving
// it in would defeat every echo match. payloadEchoedAboveBox additionally
// requires the stripped hint to clear ECHO_MIN_HINT_CHARS, so a very short
// prevSig can no longer prove landing -- accepted as conservative: this is a
// LOG-ONLY consumer (performStuckInputAction), where a false negative costs one
// warn line but a false positive would hide a lost message.
// Pure: builds on detectPaneState / stuckInputSignature / payloadEchoedAboveBox.
export function submitLanded(prevSig: string, paneAfter: string | null): boolean {
  if (paneAfter == null) return false
  if (detectPaneState(paneAfter) === 'busy') return true
  if (stuckInputSignature(paneAfter) === prevSig) return false
  return payloadEchoedAboveBox(paneAfter, prevSig.replace(/^❯\s*/, ''))
}

// Per-session bookkeeping for the stuck-input recovery watcher. A "spell"
// is one continuous stretch of the SAME text parked in the input box.
export interface StuckInputState {
  /** Signature of the parked text for the active spell, or null when no
   * spell is active (the box is empty / the pane is busy). */
  parkedSig: string | null
  /** When the active spell was first observed. */
  firstSeenAt: number | null
  /** When the last recovery Enter was sent in this spell, or null. */
  lastRecoverAt: number | null
  /** How many recovery Enters have been sent in the active spell. */
  attempts: number
}

export interface StuckInputThresholds {
  /** How long the SAME text must stay parked before the first recovery
   * Enter, so a turn that is about to submit on its own (frame race) is
   * not pre-empted and a human mid-typing is left alone. */
  confirmMs: number
  /** Minimum gap between recovery Enters within one spell, so a pane
   * that ignores the Enter is not hammered every tick. */
  dedupMs: number
  /** Max recovery Enters per spell before giving up (caller logs). A
   * pane still stuck after this is not the swallowed-Enter case the
   * watcher targets; further Enters would not help. */
  maxAttempts: number
}

export interface StuckInputDecision {
  recover: boolean
  next: StuckInputState
}

const NO_STUCK_INPUT: StuckInputState = {
  parkedSig: null,
  firstSeenAt: null,
  lastRecoverAt: null,
  attempts: 0,
}

/**
 * Pure decision for "should the watcher send a recovery Enter to this
 * session". Dependency-free so it is unit-testable without tmux or
 * timers: feed the current parked-input signature (from
 * stuckInputSignature), the previous persisted state and a clock, get
 * back whether to send Enter plus the next state to persist.
 *
 * The channel-notification path (inbound Telegram/Slack delivered by the
 * plugin) does not go through sendPromptToSession, so its post-send
 * Enter-retry budget cannot cover a swallowed Enter there. This watcher
 * is the backstop: it detects the symptom (text stranded in the prompt
 * box) and re-submits.
 *
 * Guards that keep it from firing on healthy panes:
 *   - A new or CHANGED parked signature restarts the confirm window
 *     (record-only), so text that is still arriving / being edited and a
 *     turn that submits on its own are never pre-empted. With confirmMs
 *     > 0 this also guarantees at least two observations before any Enter.
 *   - A confirm window: the same text must persist for confirmMs.
 *   - A dedup window between Enters, and a maxAttempts cap per spell.
 *   - Backwards clock skew (a future stored timestamp) restarts the
 *     spell instead of stalling the deltas negative.
 *
 * @param parkedSig   Signature of the parked input now, or null when the
 *                    pane is not in the parked-input state.
 * @param prev        Previously persisted state for this session.
 * @param now         Current clock (ms).
 * @param thresholds  Confirm / dedup / maxAttempts knobs.
 */
export function decideStuckInputRecovery(
  parkedSig: string | null,
  prev: StuckInputState,
  now: number,
  thresholds: StuckInputThresholds,
): StuckInputDecision {
  // Nothing parked: end any active spell.
  if (parkedSig === null) {
    return { recover: false, next: { ...NO_STUCK_INPUT } }
  }
  // New spell, or the parked text changed (still arriving / edited /
  // a different message): restart the confirm window, record only.
  if (prev.parkedSig !== parkedSig || prev.firstSeenAt === null) {
    return { recover: false, next: { parkedSig, firstSeenAt: now, lastRecoverAt: null, attempts: 0 } }
  }
  // Backwards clock skew: a stored timestamp in the future relative to
  // now would drive the deltas negative and stall. Restart the spell.
  if (now < prev.firstSeenAt || (prev.lastRecoverAt !== null && now < prev.lastRecoverAt)) {
    return { recover: false, next: { parkedSig, firstSeenAt: now, lastRecoverAt: null, attempts: 0 } }
  }
  // Retry budget spent: hold without acting.
  if (prev.attempts >= thresholds.maxAttempts) {
    return { recover: false, next: { ...prev } }
  }
  // Confirm window not yet elapsed.
  if (now - prev.firstSeenAt < thresholds.confirmMs) {
    return { recover: false, next: { ...prev } }
  }
  // Dedup gap between recovery Enters.
  if (prev.lastRecoverAt !== null && now - prev.lastRecoverAt < thresholds.dedupMs) {
    return { recover: false, next: { ...prev } }
  }
  return {
    recover: true,
    next: { parkedSig, firstSeenAt: prev.firstSeenAt, lastRecoverAt: now, attempts: prev.attempts + 1 },
  }
}

// =============================================================================
// Submit-action decision (delivery-reliability, BA56A500)
// =============================================================================
//
// Turns the parked-input facts -- built from parkedInputRowCount() and
// parkedChannelInput() above -- into a recovery MOVE. The decision is the heart
// of the fix: a plain recovery Enter on a MULTI-ROW parked message inserts a
// newline rather than submitting (corrupt), so multi-row must never bare-Enter;
// and the chat_id truncation-guard (no verbatim re-inject of an incomplete
// <channel> block) is preserved. The caller verifies the move landed with
// submitLanded() and escalates within the attempts budget if it did not.

/** A concrete recovery move for the stuck-input watcher. */
export type StuckInputAction =
  | 'reinject-block'   // clear + verbatim re-inject the COMPLETE <channel> block (chat_id-safe)
  | 'reinject-plain'   // clear + re-inject collapsed parked text (sub-agents only)
  | 'clear-preamble'   // clear a truncated/stale safety preamble, never re-inject
  | 'enter'            // a single bare Enter -- ONLY safe at rowCount <= 1
  | 'hold'             // do nothing this tick (multi-row truncated / truncation-guard)

export interface StuckInputActionFacts {
  /** attempt > MAIN_STUCK_ENTER_ATTEMPTS -- past the Enter-first budget. */
  escalate: boolean
  /** parkedInputRowCount(pane) -- >1 forbids a bare Enter. */
  rowCount: number
  /** A complete <channel> block is parked: chat_id-safe verbatim re-inject. */
  blockComplete: boolean
  /** A <channel> block is parked but truncated: chat_id unrecoverable, MUST
   * NOT re-inject (wrong chat_id) and MUST NOT corrupt via a multi-row Enter. */
  blockTruncated: boolean
  /** shouldClearTruncatedPreamble(pane): a stale safety preamble to clear. */
  truncatedPreamble: boolean
  /** Sub-agent session: re-injecting collapsed parked text is safe (no human draft). */
  allowPlainReinject: boolean
  /** parkedInputText(pane) != null -- there is collapsed text to re-inject. */
  hasPlainText: boolean
}

/**
 * Pure decision: given the parked-input facts, what recovery move to make.
 * Dependency-free so it is unit-testable without tmux.
 *
 * Invariants (the fix):
 *   - NEVER bare-Enter a multi-row box (rowCount > 1) -- it inserts a newline
 *     and corrupts the message. Multi-row escalates straight to a re-inject
 *     (when one is safe) or holds.
 *   - A complete <channel> block is the safest move (chat_id-safe re-inject);
 *     prefer it as soon as we escalate, and immediately when multi-row.
 *   - A TRUNCATED <channel> block (chat_id unrecoverable) must not be
 *     re-injected; multi-row truncated holds (awaiting the keystroke fix),
 *     single-row keeps the harmless legacy Enter.
 *   - Otherwise a bare Enter is the swallowed-Enter remedy, but only single-row.
 */
export function decideStuckInputAction(f: StuckInputActionFacts): StuckInputAction {
  const multiRow = f.rowCount > 1
  // Complete channel block: chat_id-safe verbatim re-inject. Multi-row is itself
  // a reason to escalate now (a plain Enter would corrupt it).
  if (f.blockComplete) {
    return f.escalate || multiRow ? 'reinject-block' : 'enter'
  }
  // Sub-agent non-channel parked text: clear + re-inject is safe (no human draft).
  if (f.allowPlainReinject && f.hasPlainText && !f.blockTruncated) {
    return f.escalate || multiRow ? 'reinject-plain' : 'enter'
  }
  // Truncated safety preamble: clear only (never re-inject a stale preamble).
  if (f.truncatedPreamble && f.escalate) return 'clear-preamble'
  // Truncated <channel> block: hold a multi-row (Enter would corrupt; re-inject
  // would answer the wrong chat_id), keep the harmless legacy Enter single-row.
  if (f.blockTruncated) return multiRow ? 'hold' : 'enter'
  // Default swallowed-Enter remedy -- never on multi-row.
  return multiRow ? 'hold' : 'enter'
}

// =============================================================================
// Stuck tool-call watcher (2026-06-02 incident, Worked-for >Ns freeze)
// =============================================================================
//
// Symptom: Marveen's TUI shows "Worked for 31s" (or "Brewed for", "Baked for")
// indefinitely. The claude process is at 0.3% CPU (IO-wait, no progress), bun
// poller is alive, hasChannelPluginAlive() returns true -- so the recovery
// cascade gated on bun absence (#240) never fires. Real cause: the Telegram
// reply tool-call hung server-side without a client-side timeout, taking the
// TUI render loop with it.
//
// Detection: parse the `Worked for Ns` line. If the SAME tag+seconds is
// observed across `confirmPolls` consecutive polls AND `seconds >= freezeSeconds`,
// the tool-call is frozen and the session needs a hard restart. The tag must
// stay the same too (different verb / restart of the counter means progress).

/**
 * Parse the TUI's "Worked / Brewed / Baked / Cooking / Simmered for Ns"
 * footer if present. Returns null when the pane is not in a tool-call
 * waiting state (no tool-call line, or it just changed verb).
 *
 * The verb is part of the signature so that a TUI transition from "Brewed"
 * to "Worked" -- which actually IS progress, the tool-call moved to a new
 * phase -- resets the stuck-spell.
 */
export interface ToolCallProgressSignature {
  tag: string
  seconds: number
}

const TOOL_CALL_PROGRESS_RX = /(?:✻\s*)?(Worked|Brewed|Baked|Cooking|Simmered|Sauteed|Sauted)\s+for\s+(\d+)s/i

export function stuckToolCallSignature(pane: string): ToolCallProgressSignature | null {
  const m = pane.match(TOOL_CALL_PROGRESS_RX)
  if (!m) return null
  const tag = m[1]!.toLowerCase()
  const seconds = parseInt(m[2]!, 10)
  if (!Number.isFinite(seconds) || seconds < 0) return null
  return { tag, seconds }
}

export interface StuckToolCallState {
  /** Current tool-call tag we are watching (e.g. "worked"), or null if no spell active. */
  tag: string | null
  /** The seconds value observed when the spell started -- preserved for the
   * audit log so an operator can tell at what counter value the freeze happened. */
  spellStartSeconds: number | null
  /** Highest seconds value observed in this spell. Load-bearing for the
   * spell-peak discriminator: a residual TUI footer left over from a prior
   * respawn never climbs (stays at 3-4s across every observation), while a
   * legitimately running tool-call that wedges climbed to a meaningful value
   * before stalling. Recovery is gated on spellPeakSeconds >= minPeakSeconds
   * so the residual band does not look like a wedge (2026-06-08 false-positive
   * loop: 13 self-respawns in 8h triggered by 3-4s residuals every poll). */
  spellPeakSeconds: number | null
  /** When the spell was first observed (ms). */
  firstSeenAt: number | null
  /** Last observed seconds value, used to detect stagnation across polls. */
  lastSeconds: number | null
  /** Consecutive polls in which the seconds value did NOT increase. */
  stagnantPolls: number
  /** Wall-clock timestamp (ms) at which the counter first stopped advancing
   * in this spell, or null if the counter is currently progressing. This is
   * the load-bearing measurement for the freeze decision: a wedged TUI keeps
   * displaying the same `<verb> for Ns` regardless of real time, so we
   * measure freeze duration in WALL CLOCK from stagnantSince, NOT from the
   * displayed counter value. (PR #246 review fix, 2026-06-02: the prior
   * version gated on sig.seconds >= freezeSeconds and so could never fire on
   * a counter frozen at <180s -- exactly the 2026-06-02 06:41 incident shape
   * where it sat at 31s.) */
  stagnantSince: number | null
  /** Recoveries fired in this spell (cap at 1 -- a respawn is the only
   * action, and the next sweep observes the new pane fresh). */
  attempts: number
}

export interface StuckToolCallThresholds {
  /** How long the TUI counter must remain stagnant in WALL-CLOCK terms
   * before we conclude the render loop is wedged. A healthy long-running
   * tool-call increments the counter every TUI redraw (~once per second),
   * so a counter that holds the same value for >= this many ms is wedged
   * regardless of what value it holds. The previous "displayed-value
   * threshold" reading was the PR #246 review bug. */
  freezeSeconds: number
  /** How many consecutive polls of NON-INCREASING seconds count as
   * "the TUI render loop is wedged" (anti-fluke). A real tool-call
   * increments every TUI redraw, so multi-poll stagnation is conclusive.
   * Composed WITH the wall-clock freezeSeconds check -- BOTH must hold. */
  stagnantPolls: number
  /** Spell-peak discriminator (2026-06-08 fix): the highest seconds value the
   * counter has reached in this spell must be at LEAST this many seconds for
   * the spell to qualify as a wedge. A residual TUI footer left over after a
   * prior respawn never climbs (stays at 3-4s every poll); a legitimately
   * wedged tool-call climbed to a meaningful value before freezing (the
   * 2026-06-02 incident sat at 31s). Composed AND with the wall-clock and
   * anti-fluke gates -- all three must hold. */
  minPeakSeconds: number
}

export interface StuckToolCallDecision {
  recover: boolean
  next: StuckToolCallState
}

const NO_STUCK_TOOL_CALL: StuckToolCallState = {
  tag: null,
  spellStartSeconds: null,
  spellPeakSeconds: null,
  firstSeenAt: null,
  lastSeconds: null,
  stagnantPolls: 0,
  stagnantSince: null,
  attempts: 0,
}

/**
 * Pure decision: should the watcher respawn this session because the TUI
 * tool-call counter has stopped advancing for too long?
 *
 * Load-bearing measurement is WALL-CLOCK stagnation duration, NOT the
 * displayed counter value. A wedged TUI keeps showing the same
 * `<verb> for Ns` regardless of real time; gating on `sig.seconds >=
 * freezeSeconds` (PR #246 review bug, 2026-06-02) would miss exactly the
 * incident shape the watchdog is built for (counter frozen at 31s, never
 * reaches 180s, never recovers).
 *
 * Guards against false positives on legitimate long tool-calls:
 *   - Wall-clock stagnation `(now - stagnantSince) >= freezeSeconds`. A
 *     healthy long-running call increments the counter every TUI redraw,
 *     so stagnantSince keeps resetting to null and the duration never
 *     accumulates. A wedged TUI lets it accumulate.
 *   - Anti-fluke: stagnantPolls >= thresholds.stagnantPolls (two
 *     consecutive non-incrementing observations), composed AND with the
 *     wall-clock check.
 *   - Recovery is one-shot per spell (attempts cap at 1). The next sweep
 *     reads a fresh pane after the respawn.
 *   - A tag change (e.g. Brewed -> Worked) or counter increment resets
 *     the spell -- both are genuine progress.
 */
export function decideStuckToolCallRecovery(
  sig: ToolCallProgressSignature | null,
  prev: StuckToolCallState,
  now: number,
  thresholds: StuckToolCallThresholds,
): StuckToolCallDecision {
  // No tool-call line: end any spell.
  if (sig === null) {
    return { recover: false, next: { ...NO_STUCK_TOOL_CALL } }
  }
  // Spell start, OR tag changed (a verb change is genuine progress).
  if (prev.tag !== sig.tag || prev.firstSeenAt === null) {
    return {
      recover: false,
      next: {
        tag: sig.tag,
        spellStartSeconds: sig.seconds,
        spellPeakSeconds: sig.seconds,
        firstSeenAt: now,
        lastSeconds: sig.seconds,
        stagnantPolls: 0,
        stagnantSince: null,
        attempts: 0,
      },
    }
  }
  // Backwards clock skew: restart the spell rather than stall.
  if (now < prev.firstSeenAt || (prev.stagnantSince !== null && now < prev.stagnantSince)) {
    return {
      recover: false,
      next: {
        tag: sig.tag,
        spellStartSeconds: sig.seconds,
        spellPeakSeconds: sig.seconds,
        firstSeenAt: now,
        lastSeconds: sig.seconds,
        stagnantPolls: 0,
        stagnantSince: null,
        attempts: 0,
      },
    }
  }
  // Counter advanced: real progress. Reset both the stagnant-poll counter
  // and the stagnantSince timestamp -- the TUI is alive. Keep the spell
  // open with the same tag so a LATER freeze is detected without re-running
  // the full freezeSeconds window from scratch (the wall-clock measurement
  // restarts from the next stagnation onward, which is the right thing).
  // Also raise spellPeakSeconds -- the discriminator that separates a real
  // wedge (climbed before freezing) from a leftover residual footer.
  if (prev.lastSeconds !== null && sig.seconds > prev.lastSeconds) {
    const peak = Math.max(prev.spellPeakSeconds ?? sig.seconds, sig.seconds)
    return {
      recover: false,
      next: { ...prev, spellPeakSeconds: peak, lastSeconds: sig.seconds, stagnantPolls: 0, stagnantSince: null },
    }
  }
  // Counter stagnant (same or rolled-back). Tick the stagnant counter and
  // stamp stagnantSince on the FIRST stagnant observation in this stretch.
  // Subsequent stagnant polls preserve the original stagnantSince so the
  // wall-clock duration accumulates correctly.
  const nextStagnant = prev.stagnantPolls + 1
  const nextStagnantSince = prev.stagnantSince ?? now
  // Recovery already fired in this spell: hold.
  if (prev.attempts >= 1) {
    return {
      recover: false,
      next: { ...prev, lastSeconds: sig.seconds, stagnantPolls: nextStagnant, stagnantSince: nextStagnantSince },
    }
  }
  // Recover only when ALL THREE gates hold: wall-clock freeze duration,
  // anti-fluke poll count, AND spell-peak discriminator. A 5-minute genuine
  // tool-call resets stagnantSince on every redraw, so even though the call
  // is long the duration never accumulates. A residual TUI footer left over
  // from a prior respawn never climbs past minPeakSeconds, so the peak gate
  // blocks the 2026-06-08 false-positive shape (3-4s residual every poll).
  const stagnantMs = now - nextStagnantSince
  const freezeMs = thresholds.freezeSeconds * 1000
  const peak = prev.spellPeakSeconds ?? sig.seconds
  if (
    stagnantMs < freezeMs ||
    nextStagnant < thresholds.stagnantPolls ||
    peak < thresholds.minPeakSeconds
  ) {
    return {
      recover: false,
      next: { ...prev, lastSeconds: sig.seconds, stagnantPolls: nextStagnant, stagnantSince: nextStagnantSince },
    }
  }
  return {
    recover: true,
    next: { ...prev, lastSeconds: sig.seconds, stagnantPolls: nextStagnant, stagnantSince: nextStagnantSince, attempts: 1 },
  }
}

// --- Context-saturation predicate -------------------------------------------
// Claude Code prints "100% context used" (and a few equivalent phrasings) in
// its footer when a pane can no longer accept useful work, yet the pane can
// still otherwise present as perfectly idle -- empty prompt, ready-looking
// footer. paneLooksIdle() therefore returns true for a saturated session, and
// a caller that only checks idleness will happily dispatch new work into a
// pane that cannot act on it. paneShowsContextSaturation() closes that gap.
//
// The banner renders one row ABOVE the bypass-mode footer, so the window is a
// little wider than LIVE_FOOTER_REGION_LINES (which anchors on the footer line
// itself); still tail-scoped, so a scrollback quote of the same phrase does
// not trip it.
const CTX_SAT_FOOTER_REGION_LINES = 8
const CTX_SAT_RX = /100% context used|context (?:is |limit reached|window )?full\b|context limit|auto-?compact required/i

export function paneShowsContextSaturation(capture: string): boolean {
  if (!capture || !capture.trim()) return false
  const lines = capture.split('\n')
  const footerRegion = lines.slice(-CTX_SAT_FOOTER_REGION_LINES).join('\n')
  return CTX_SAT_RX.test(footerRegion)
}

// --- Context-LOW predicate (pre-saturation warning) -------------------------
// Before a pane hits full saturation ("100% context used", above) Claude Code
// renders a lower-severity budget warning in the same footer/status region:
// "Context low", "Context left until auto-compact: 23%", "23% until
// auto-compact" (wording varies by build). Catching this EARLIER lets the
// watchdog flag the coordinator to restart a sub-agent BEFORE it saturates and
// starts silently dropping work -- the 2026-07-12 wedge (a sub-agent at 97%
// context that dropped four inter-agent messages in both directions).
//
// Conservative by construction: each alternative encodes a real footer phrase
// ("context low" as an adjacent pair; the compaction cue as the CC-specific
// "until [auto-]compact"), so ordinary conversation prose that merely mentions
// the word "context" -- without the compaction semantics -- never trips it. Same
// tail-scope as paneShowsContextSaturation so a scrollback quote cannot fire it.
const CTX_LOW_RX = /\bcontext\s+low\b|\buntil\s+(?:auto[-\s]?)?compact\b/i

export function paneShowsContextLow(capture: string): boolean {
  if (!capture || !capture.trim()) return false
  const lines = capture.split('\n')
  const footerRegion = lines.slice(-CTX_SAT_FOOTER_REGION_LINES).join('\n')
  return CTX_LOW_RX.test(footerRegion)
}

// --- Context-budget escalation (two-phase + flapping guard) ------------------
// A pane approaching ("Context low" / "N% until auto-compact") or already at
// ("100% context used") its context ceiling still reads as idle, so the
// scheduler/router keep dispatching work whose in-flight verdicts/outputs can no
// longer be trusted. This escalates that condition on the SAME coordinator-first
// two-phase model as the permission-dialog / thinking-block wedges
// (decideDialogEscalation), with one addition: the signal must persist across
// `confirmTicks` consecutive monitor ticks before the first flag, so a one-tick
// capture flake never escalates. The resolution is a RESTART recommendation --
// the watchdog NEVER auto-restarts (a false positive would nuke a healthy
// session's context).

export type ContextBudgetAction = 'notify-wolfe' | 'fallback-gabor' | 'none'

export interface ContextBudgetState {
  /** Consecutive ticks the low/saturation signal has been observed. Reset to 0
   * on any tick the signal is absent (the spell is over), so a future spell
   * re-confirms from scratch and flags the coordinator promptly. */
  consecutiveHits: number
  /** When the coordinator (mr-wolfe) was flagged for the CURRENT spell -- the
   * phase-1 dedup anchor AND the grace-timer origin -- or null before the
   * confirm threshold is reached / when no spell is active. Mirrors
   * DialogEscalationState.wolfeFlaggedAt. */
  wolfeFlaggedAt: number | null
  /** When the direct owner (Gabor) fallback was sent during the CURRENT spell,
   * or null. Gates the fallback to at most once per spell. */
  gaborNotifiedAt: number | null
}

export interface ContextBudgetThresholds {
  /** Consecutive ticks the signal must persist before the FIRST coordinator
   * flag (flapping guard). 1 == flag on first sighting. */
  confirmTicks: number
  /** How long after the coordinator flag, signal still up, before the direct
   * owner fallback fires. */
  graceMs: number
  /** Minimum gap before the coordinator is re-flagged for the SAME persisting
   * spell. */
  dedupMs: number
}

export interface ContextBudgetDecision {
  action: ContextBudgetAction
  next: ContextBudgetState
}

/**
 * Pure two-phase escalation decision for a session at/near its context ceiling.
 * Dependency-free (feed the per-tick signal + persisted state + a clock, get the
 * action + next state). Once the signal has held for `confirmTicks` consecutive
 * ticks it DELEGATES to decideDialogEscalation for the coordinator-first /
 * owner-fallback timing, so the dedup + grace + clock-skew semantics stay
 * identical to the dialog / thinking-block escalations (single source of truth).
 *
 * Cadence (caller invokes once per monitor tick while the pane shows the signal):
 *   - signal absent                         -> reset to a fresh spell ('none')
 *   - fewer than confirmTicks in a row      -> 'none' (still confirming)
 *   - confirm reached, first time           -> 'notify-wolfe' (flag coordinator)
 *   - within graceMs of the flag            -> 'none'
 *   - graceMs elapsed, still up, owner unset -> 'fallback-gabor'
 *   - dedupMs elapsed since the flag         -> 'notify-wolfe' again (owner gate
 *     NOT reset, so the owner is alerted at most once per spell)
 */
export function decideContextBudgetEscalation(
  signalPresent: boolean,
  state: ContextBudgetState,
  now: number,
  thresholds: ContextBudgetThresholds,
): ContextBudgetDecision {
  if (!signalPresent) {
    // Spell over: reset so a future ceiling re-confirms and flags promptly
    // rather than inheriting a stale dedup/grace anchor.
    return { action: 'none', next: { consecutiveHits: 0, wolfeFlaggedAt: null, gaborNotifiedAt: null } }
  }
  const hits = state.consecutiveHits + 1
  if (hits < thresholds.confirmTicks) {
    // Flapping guard: not yet seen on enough consecutive ticks to escalate.
    return { action: 'none', next: { consecutiveHits: hits, wolfeFlaggedAt: null, gaborNotifiedAt: null } }
  }
  // Confirmed: reuse the proven two-phase machine for the coordinator-first /
  // owner-fallback timing (keeps skew + dedup + grace identical everywhere).
  const inner = decideDialogEscalation(
    { wolfeFlaggedAt: state.wolfeFlaggedAt, gaborNotifiedAt: state.gaborNotifiedAt },
    now,
    { graceMs: thresholds.graceMs, dedupMs: thresholds.dedupMs },
  )
  return {
    action: inner.action,
    next: { consecutiveHits: hits, wolfeFlaggedAt: inner.next.wolfeFlaggedAt, gaborNotifiedAt: inner.next.gaborNotifiedAt },
  }
}

// ---- Pane PROGRESS (audit AC-6 / predicate P3) -------------------------------
//
// detectPaneState answers "is it typing"; it does not answer "is it MOVING".
// That gap produced the 2026-07-31 16:44 false alert: a legitimate 20-minute
// working turn tripped a 15-minute age ceiling that deliberately re-included
// healthy-busy targets. Age is not a stuck-detector -- a working agent redraws
// its pane (spinner, token counter, tool output), a wedged one does not -- so a
// pending-message alert now requires a STALLED pane rather than a big number of
// minutes. A genuinely long working turn never alerts at any age; a stalled one
// alerts at the threshold.

export interface PaneProgressState {
  /** Hash of the last capture. */
  hash: string
  /** Consecutive sweeps that produced the SAME hash. */
  unchangedSweeps: number
  /** When the last capture was taken (epoch ms), for gap detection. */
  lastSeenMs: number
}

/**
 * FNV-1a over the pane text. Non-crypto by choice: this is a change-detector,
 * not a security boundary, and pane-state.ts stays import-free (see the header)
 * so it remains trivially unit-testable. Returned as hex so a state file /log
 * line carries something comparable by eye.
 */
export function paneProgressHash(pane: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < pane.length; i++) {
    h ^= pane.charCodeAt(i)
    // >>> 0 keeps it an unsigned 32-bit value through the multiply.
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * Fold one capture into the per-session progress state.
 *
 * `pane === null` (unreadable capture) returns null: the caller must NOT treat
 * an unmeasurable pane as "progressing" -- isPaneStalled fails OPEN on null, so
 * a vanished/broken session still alerts.
 *
 * A gap longer than `maxGapMs` between captures resets the counter: the
 * watchdog only samples a session while one of its messages is stuck, so two
 * observations can be hours apart, and comparing across that gap would call a
 * session "unchanged" that in fact did a full turn in between.
 */
export function updatePaneProgress(
  prev: PaneProgressState | undefined,
  pane: string | null,
  nowMs: number,
  maxGapMs: number,
): PaneProgressState | null {
  if (pane === null) return null
  const hash = paneProgressHash(pane)
  if (!prev || nowMs - prev.lastSeenMs > maxGapMs || nowMs < prev.lastSeenMs || prev.hash !== hash) {
    return { hash, unchangedSweeps: 0, lastSeenMs: nowMs }
  }
  return { hash, unchangedSweeps: prev.unchangedSweeps + 1, lastSeenMs: nowMs }
}

/**
 * Pure decision: is the pane stalled? True once `minUnchangedSweeps` consecutive
 * sweeps produced no change (2 sweeps = 3 identical captures, ~2 min on the 60s
 * monitor tick). Fail-OPEN on a null state (unreadable pane): a control that
 * cannot measure must not claim the target is fine.
 */
export function isPaneStalled(state: PaneProgressState | null, minUnchangedSweeps: number): boolean {
  if (state === null) return true
  return state.unchangedSweeps >= minUnchangedSweeps
}
