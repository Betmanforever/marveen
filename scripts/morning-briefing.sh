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
TOKEN_FILE="$INSTALL_DIR/store/.dashboard-token"
if [ -r "$TOKEN_FILE" ]; then
  DIGEST=$(curl -s -m 5 -X POST -H "Authorization: Bearer $(cat "$TOKEN_FILE")" \
    "http://localhost:3420/api/alerts/digest/consume" 2>/dev/null \
    | python3 -c 'import json,re,sys
try:
    s = json.load(sys.stdin).get("section") or ""
except Exception:
    s = ""
print(re.sub(r"[$`\"\\\\]", "", s))' 2>/dev/null)
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

echo "=== Kész $(date) ===" >> "$LOG"
