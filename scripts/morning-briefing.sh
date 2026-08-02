#!/bin/bash
# Marveen - Reggeli napindító
# LaunchAgent hívja minden nap 7:27-kor

export PATH="$HOME/.local/bin:$HOME/.bun/bin:/home/linuxbrew/.linuxbrew/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CLAUDE="$(command -v claude)"
[ -z "$CLAUDE" ] && echo "ERROR: claude not found on PATH" >&2 && exit 1
LOG="$INSTALL_DIR/store/morning.log"

# Load config
if [ -f "$INSTALL_DIR/.env" ]; then
  while IFS='=' read -r key value; do
    case "$key" in ''|\#*) continue ;; esac
    export "$key=$value"
  done < "$INSTALL_DIR/.env"
fi

CHAT_ID="${ALLOWED_CHAT_ID:-0}"
CALENDAR_ID="${HEARTBEAT_CALENDAR_ID:-primary}"

echo "=== Reggeli napindító $(date) ===" >> "$LOG"

cd "$INSTALL_DIR"

# Riasztas-osszesito (audit AC-7): a 24 oras digest a napindito RESZEKENT megy
# ki, nem kulon uzenetkent -- egy plusz utemezett uzenet pont az a zaj, amit ez
# a policy megszuntet. A /consume vegpont uriti a puffert, igy ugyanaz a tetel
# nem megy ki ketszer. Ures napon a section null, ilyenkor a szekcio teljesen
# kimarad. Ha a dashboard nem valaszol, a napindito ettol meg elmegy.
#
# A szoveg PROMPTBA kerul, ezert a kinyereskor kiszurjuk a shell- es
# prompt-veszelyes karaktereket ($ ` " \): a digest sorai kozvetve
# tartalmazhatnak kivulrol irt mezot (agent_messages.from_agent), es egy
# $(...) egy dupla idezojeles promptban vegrehajtodna.
DIGEST=""
ACK_TOKEN=""
TOKEN_FILE="$INSTALL_DIR/store/.dashboard-token"
# Dry-run must be side-effect-free: consume PARKS entries under an ack token
# for the TTL, so a test assembly would hide real findings from a briefing
# that runs within that window.
if [ "${MORNING_DRY_RUN:-0}" = "1" ]; then
  DIGEST="(dry-run: digest-szekcio helye)"
elif [ -r "$TOKEN_FILE" ]; then
  # Two-phase consume (close condition C-4): the fetch PARKS the entries under
  # an ack token; the delete happens only at the ack after claude -p exited 0.
  # A briefing that dies mid-flight never acks, and the entries return to the
  # buffer after the TTL instead of being lost with the failed message.
  CONSUME_JSON=$(curl -s -m 5 -X POST -H "Authorization: Bearer $(cat "$TOKEN_FILE")" \
    "http://localhost:3420/api/alerts/digest/consume" 2>/dev/null)
  DIGEST=$(printf '%s' "$CONSUME_JSON" | python3 -c 'import json,re,sys
try:
    s = json.load(sys.stdin).get("section") or ""
except Exception:
    s = ""
print(re.sub(r"[$`\"\\\\]", "", s))' 2>/dev/null)
  ACK_TOKEN=$(printf '%s' "$CONSUME_JSON" | python3 -c 'import json,sys
try:
    print(json.load(sys.stdin).get("ackToken") or "")
except Exception:
    print("")' 2>/dev/null)
fi

# Unnumbered, so a zero-finding day leaves no gap in the numbered list.
DIGEST_STEP=""
if [ -n "$DIGEST" ]; then
  DIGEST_STEP="Rendszer-osszesito - vedd at SZO SZERINT a briefing vegere, kulon szekciokent, ne ertelmezd ujra es ne egeszitsd ki:
$DIGEST

"
fi

# Single prompt source (2026-08-02): the full briefing prompt lives in
# morning-briefing-prompt.md, NOT inline -- the old two-path setup (this
# script's inline prompt + the reggeli-napindito scheduled task's SKILL.md)
# meant an edit to one path silently never reached the other. Placeholder
# substitution is python (no shell expansion of the file's $-bearing code
# blocks); the digest section is appended by the script because its
# consume/ack lifecycle is this script's mechanism.
PROMPT_FILE="$INSTALL_DIR/scripts/morning-briefing-prompt.md"
if [ -r "$PROMPT_FILE" ]; then
  PROMPT="$(CHAT_ID="$CHAT_ID" CALENDAR_ID="$CALENDAR_ID" python3 -c '
import os,sys
t = open(sys.argv[1]).read()
t = t.replace("{{CHAT_ID}}", os.environ.get("CHAT_ID",""))
t = t.replace("{{CALENDAR_ID}}", os.environ.get("CALENDAR_ID",""))
print(t)' "$PROMPT_FILE")"
else
  # Fallback: a missing prompt file must not silence the whole briefing.
  echo "WARN: $PROMPT_FILE missing -- falling back to minimal inline prompt" >> "$LOG"
  PROMPT="Reggeli napindító - készítsd el és küld el Telegramra (chat_id: $CHAT_ID).

1. Email check: search_emails az elmúlt 12 órából, szűrd ki a spam/promo emaileket
2. Naptár: getCalendarEvents a mai napra a $CALENDAR_ID naptárból (Europe/Budapest timezone)
3. AI hírek: WebSearch \"AI news [tegnapi dátum]\"
4. Küld el Telegramra a reply tool-lal (chat_id: $CHAT_ID)

Tömör, lényegre törő. Ékezetesen írj magyarul."
fi

PROMPT="$PROMPT

${DIGEST_STEP}"

if [ "${MORNING_DRY_RUN:-0}" = "1" ]; then
  # Test hook: print the assembled prompt instead of launching claude.
  printf '%s\n' "$PROMPT"
  exit 0
fi

$CLAUDE --dangerously-skip-permissions \
  --channels plugin:telegram@claude-plugins-official \
  -p "$PROMPT" >> "$LOG" 2>&1
CLAUDE_EXIT=$?

# Ack only on success: exit 0 is the best delivery signal this script has (the
# send happens inside the claude -p session). On failure the parked entries
# revert after the TTL and the next briefing carries them.
if [ "$CLAUDE_EXIT" -eq 0 ] && [ -n "$ACK_TOKEN" ] && [ -r "$TOKEN_FILE" ]; then
  curl -s -m 5 -X POST -H "Authorization: Bearer $(cat "$TOKEN_FILE")" \
    "http://localhost:3420/api/alerts/digest/ack?token=$ACK_TOKEN" >> "$LOG" 2>&1
  echo "" >> "$LOG"
elif [ -n "$ACK_TOKEN" ]; then
  echo "digest ack SKIPPED (claude exit=$CLAUDE_EXIT) -- parked entries will revert" >> "$LOG"
fi

echo "=== Kész $(date) ===" >> "$LOG"
