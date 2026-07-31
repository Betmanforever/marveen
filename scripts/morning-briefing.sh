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
  export $(grep -v '^#' "$INSTALL_DIR/.env" | xargs)
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
if [ -r "$TOKEN_FILE" ]; then
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

$CLAUDE --dangerously-skip-permissions \
  --channels plugin:telegram@claude-plugins-official \
  -p "Reggeli napindító - készítsd el és küld el Telegramra (chat_id: $CHAT_ID).

1. Email check: search_emails az elmúlt 12 órából, szűrd ki a spam/promo emaileket
2. Naptár: getCalendarEvents a mai napra a $CALENDAR_ID naptárból (Europe/Budapest timezone)
3. AI hírek: WebSearch \"AI news [tegnapi dátum]\"
4. Küld el Telegramra a reply tool-lal (chat_id: $CHAT_ID)

${DIGEST_STEP}

Tömör, lényegre törő. Ékezetesen írj magyarul." >> "$LOG" 2>&1
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
