#!/usr/bin/env python3
"""PostToolUse (matcher-less) + Stop hook: SECOND capture path for MID-TURN
channel messages.

ledger-capture.py only fires on UserPromptSubmit, so a Telegram message that
arrives while a turn is already running (async injection alongside a tool
result) never passed through it -- and both the live-drain and the
SessionStart replay read only the ledger, so the message was invisible to
continuity (kanban cab2c7e3, proven lost message_ids 1600/1605).

This hook scans the session transcript (JSONL) incrementally for
<channel source="plugin:telegram:telegram"> blocks in user-role entries and
records them via ledger_lib.log_inbound. Properties:

- Idempotent: the UNIQUE(agent_id, chat_id, 'in', message_id) constraint makes
  re-scans and overlap with the UserPromptSubmit path free (INSERT OR IGNORE).
- Incremental: a per-transcript byte offset is cached in the system temp dir;
  only new complete lines are parsed on each tool call. Losing the offset file
  is harmless (full rescan, deduped).
- Ordering-safe: created_at comes from the message's own ts attribute (true
  arrival time), NOT the scan time -- a late capture must not sort after the
  outbound reply that answered it, or it would read as a phantom open question.
- Never blocks: always exit 0.

Registered on PostToolUse (fires throughout the turn, so a crash mid-turn
loses at most the tail) and on Stop (catches a message that arrived after the
last tool call).
"""
import hashlib
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ledger_lib  # noqa: E402


def _offset_path(transcript_path):
    digest = hashlib.sha1(transcript_path.encode("utf-8")).hexdigest()[:16]
    return os.path.join(tempfile.gettempdir(), f"ledger-midturn-{digest}.offset")


def _read_offset(path):
    try:
        with open(path) as f:
            return int(f.read().strip() or 0)
    except Exception:
        return 0


def _write_offset(path, offset):
    try:
        with open(path, "w") as f:
            f.write(str(offset))
    except Exception:
        pass


def _texts_from_entry(entry):
    """Text pieces of a user-role transcript entry. Mid-turn channel messages
    are injected as user messages; content is a string or a list of blocks."""
    if entry.get("type") != "user":
        message = entry.get("message")
        if not isinstance(message, dict) or message.get("role") != "user":
            return []
    message = entry.get("message") or {}
    content = message.get("content")
    if isinstance(content, str):
        return [content]
    texts = []
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict):
                if isinstance(block.get("text"), str):
                    texts.append(block["text"])
                elif isinstance(block.get("content"), str):
                    texts.append(block["content"])
                elif isinstance(block.get("content"), list):
                    for sub in block["content"]:
                        if isinstance(sub, dict) and isinstance(sub.get("text"), str):
                            texts.append(sub["text"])
    return texts


def scan(transcript_path, agent_id):
    offset_file = _offset_path(transcript_path)
    offset = _read_offset(offset_file)
    try:
        size = os.path.getsize(transcript_path)
    except OSError:
        return
    if offset > size:
        offset = 0  # transcript rotated/replaced -- rescan (dedup makes it safe)
    if offset == size:
        return
    with open(transcript_path, "rb") as f:
        f.seek(offset)
        chunk = f.read()
    # Only complete lines; a partially-written last line is re-read next time.
    end = chunk.rfind(b"\n")
    if end < 0:
        return
    new_offset = offset + end + 1
    for raw in chunk[: end + 1].splitlines():
        raw = raw.strip()
        if not raw or b"<channel" not in raw:
            continue
        try:
            entry = json.loads(raw)
        except Exception:
            continue
        for text in _texts_from_entry(entry):
            for msg in ledger_lib.extract_channel_messages(text):
                try:
                    ledger_lib.log_inbound(
                        agent_id, msg["chat_id"], msg["message_id"], msg["text"],
                        msg["ts"], created_at=ledger_lib.ts_to_epoch(msg["ts"]),
                    )
                except Exception:
                    pass
    _write_offset(offset_file, new_offset)


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)
    transcript_path = payload.get("transcript_path")
    if not transcript_path or not os.path.exists(transcript_path):
        sys.exit(0)
    agent_id = ledger_lib.agent_id_from_cwd(payload.get("cwd"))
    try:
        scan(transcript_path, agent_id)
    except Exception:
        pass  # continuity capture must never break the session
    sys.exit(0)


if __name__ == "__main__":
    main()
