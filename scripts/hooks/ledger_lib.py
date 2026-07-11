"""Shared helpers for the deterministic conversation-continuity ledger.

The ledger (store/claudeclaw.db -> conversation_log) is a rolling TRANSCRIPT of
every channel turn -- inbound user messages AND outbound replies -- per
agent_id + chat_id. On a respawn (a fresh --channels session with no memory of
the live conversation) the SessionStart hook injects the last ~20 turns of
context PLUS the open question, so the fresh session continues where the
connection dropped -- with ZERO agent discretion.

Generic across all three channel agents (marveen / dia / erno-ba): agent_id is
derived from the running session's cwd so each session only ever sees its OWN
chat. Pure stdlib (sqlite3) -- no node startup, no jq.
"""
import os
import re
import sqlite3
import time

# Canonical schema. MUST stay identical to the db.ts initDatabase() migration
# (asserted by a contract test). Created defensively so a hook that runs before
# the dashboard migration (fresh boot / respawn) still works.
SCHEMA = """
CREATE TABLE IF NOT EXISTS conversation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('in','out')),
  message_id TEXT,
  text TEXT,
  ts TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(agent_id, chat_id, direction, message_id)
)
"""
INDEX = "CREATE INDEX IF NOT EXISTS idx_convlog_agent ON conversation_log(agent_id, created_at)"

RECENT_LIMIT = 20

# <channel source="plugin:telegram:telegram" chat_id="X" message_id="Y" ... ts="Z">
#   TEXT
# </channel>
# Single source of truth for BOTH capture paths (UserPromptSubmit prompt text
# and the mid-turn transcript scan) so they can never drift apart.
CHANNEL_RX = re.compile(
    r'<channel\s+source="plugin:telegram:telegram"([^>]*)>(.*?)</channel>',
    re.DOTALL,
)


def _attr(attrs, name):
    m = re.search(name + r'="([^"]*)"', attrs)
    return m.group(1) if m else None


def extract_channel_messages(text):
    """All <channel source=telegram> blocks in `text` as dicts with chat_id,
    message_id, ts and text. Blocks missing chat_id or message_id are skipped
    (nothing to dedup on)."""
    out = []
    for m in CHANNEL_RX.finditer(text or ""):
        attrs, body = m.group(1), m.group(2)
        chat_id = _attr(attrs, "chat_id")
        message_id = _attr(attrs, "message_id")
        if chat_id and message_id:
            out.append({
                "chat_id": chat_id,
                "message_id": message_id,
                "ts": _attr(attrs, "ts"),
                "text": body.strip(),
            })
    return out


def ts_to_epoch(ts):
    """Channel `ts` attribute (UTC ISO-8601, trailing Z) -> unix epoch, or None.
    Used so a LATE capture (mid-turn scan running after the reply was already
    logged) still records the message at its TRUE arrival time -- otherwise the
    inbound would sort after its own answer and read as a phantom open
    question to the live-drain."""
    if not ts:
        return None
    try:
        import datetime
        return int(datetime.datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp())
    except Exception:
        return None


def db_path():
    # Hooks live in <install>/scripts/hooks/; the ledger is <install>/store/.
    # Resolve from THIS file's location so it is correct regardless of the
    # session's cwd. Test override: LEDGER_DB_PATH.
    override = os.environ.get("LEDGER_DB_PATH")
    if override:
        return override
    here = os.path.dirname(os.path.abspath(__file__))
    install = os.path.dirname(os.path.dirname(here))
    return os.path.join(install, "store", "claudeclaw.db")


def _install_dir():
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.dirname(os.path.dirname(here))


def main_agent_id():
    v = os.environ.get("MAIN_AGENT_ID")
    if v:
        return v.strip()
    try:
        with open(os.path.join(_install_dir(), ".env")) as f:
            for line in f:
                if line.startswith("MAIN_AGENT_ID="):
                    return line.split("=", 1)[1].strip()
    except Exception:
        pass
    return "marveen"


def owner_name():
    """The human owner's display name, used to label inbound turns in the
    replayed conversation context. Same resolution order as main_agent_id():
    OWNER_NAME env var first, then the install-dir .env (channels.sh does NOT
    export OWNER_NAME into the hook environment, so the .env file is the path
    that actually fires at runtime), finally a neutral default. Never hardcode
    a specific person -- every install configures its own OWNER_NAME, so a
    baked-in name (e.g. "Gyula") leaks the wrong name into every user's agent."""
    v = os.environ.get("OWNER_NAME")
    if v and v.strip():
        return v.strip()
    try:
        with open(os.path.join(_install_dir(), ".env")) as f:
            for line in f:
                if line.startswith("OWNER_NAME="):
                    name = line.split("=", 1)[1].strip()
                    if name:
                        return name
    except Exception:
        pass
    return "A felhasználó"


def agent_id_from_cwd(cwd):
    """Which channel agent is this session? Derived from cwd so the hooks are
    generic across all three agents and never cross-contaminate:
      <install>/agents/<id>  -> <id>           (sub-agent: dia, erno-ba, ...)
      <install>               -> MAIN_AGENT_ID  (the main channels agent)
    """
    cwd = (cwd or "").rstrip("/")
    install = _install_dir().rstrip("/")
    agents_root = os.path.join(install, "agents")
    if cwd.startswith(agents_root + os.sep):
        rel = cwd[len(agents_root) + 1:]
        return rel.split(os.sep)[0] or main_agent_id()
    if cwd == install:
        return main_agent_id()
    # Fallback: last path component (best effort), else main.
    base = os.path.basename(cwd)
    return base or main_agent_id()


def connect():
    con = sqlite3.connect(db_path(), timeout=10)
    con.execute("PRAGMA busy_timeout=10000")
    con.execute(SCHEMA)
    con.execute(INDEX)
    return con


def log_inbound(agent_id, chat_id, message_id, text, ts, created_at=None):
    """Record an inbound user message. Idempotent on (agent_id, chat_id, in, message_id).
    created_at defaults to now; a late capture path (mid-turn scan) passes the
    message's true arrival epoch instead, so ledger ordering stays truthful."""
    con = connect()
    try:
        con.execute(
            "INSERT OR IGNORE INTO conversation_log"
            " (agent_id, chat_id, direction, message_id, text, ts, created_at)"
            " VALUES (?, ?, 'in', ?, ?, ?, ?)",
            (str(agent_id), str(chat_id), str(message_id), text, ts,
             int(created_at) if created_at is not None else int(time.time())),
        )
        con.commit()
    finally:
        con.close()


def log_outbound(agent_id, chat_id, text):
    """Record an outbound reply (message_id NULL -> never deduped)."""
    con = connect()
    try:
        now = int(time.time())
        con.execute(
            "INSERT INTO conversation_log"
            " (agent_id, chat_id, direction, message_id, text, ts, created_at)"
            " VALUES (?, ?, 'out', NULL, ?, ?, ?)",
            (str(agent_id), str(chat_id), text, time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)), now),
        )
        con.commit()
    finally:
        con.close()


def recent(agent_id, limit=RECENT_LIMIT):
    """The last `limit` turns for this agent, oldest-first. Rows: (direction, chat_id, text, ts)."""
    con = connect()
    try:
        rows = con.execute(
            "SELECT direction, chat_id, text, ts FROM conversation_log"
            " WHERE agent_id=? ORDER BY created_at DESC, id DESC LIMIT ?",
            (str(agent_id), int(limit)),
        ).fetchall()
        return list(reversed(rows))
    finally:
        con.close()


def open_question_with_age(agent_id):
    """Like open_question() but also returns the open inbound's created_at (unix
    epoch). Returns (chat_id, message_id, text, ts, created_at) or None. Used by
    the live-drain hook, which needs the age for its grace window."""
    con = connect()
    try:
        row = con.execute(
            "SELECT chat_id, message_id, text, ts, created_at, id FROM conversation_log"
            " WHERE agent_id=? AND direction='in' ORDER BY created_at DESC, id DESC LIMIT 1",
            (str(agent_id),),
        ).fetchone()
        if not row:
            return None
        chat_id, message_id, text, ts, created_at, rid = row
        later_out = con.execute(
            "SELECT 1 FROM conversation_log"
            " WHERE agent_id=? AND direction='out'"
            "   AND (created_at > ? OR (created_at = ? AND id > ?)) LIMIT 1",
            (str(agent_id), created_at, created_at, rid),
        ).fetchone()
        if later_out:
            return None  # the last inbound has already been answered
        return (chat_id, message_id, text, ts, created_at)
    finally:
        con.close()


def open_question(agent_id):
    """The most recent inbound with NO later outbound (the unanswered question),
    or None. Returns (chat_id, message_id, text, ts)."""
    oq = open_question_with_age(agent_id)
    return oq[:4] if oq else None
