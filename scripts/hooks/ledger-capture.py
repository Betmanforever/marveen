#!/usr/bin/env python3
"""UserPromptSubmit hook: capture inbound Telegram messages into the rolling
transcript (direction='in') BEFORE the agent processes the prompt. Deterministic
and agent-independent. agent_id is derived from the session's cwd so the hook is
generic across all three channel agents and never cross-contaminates. Never
blocks the prompt (always exit 0).
"""
import sys
import os
import json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ledger_lib  # noqa: E402


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)
    agent_id = ledger_lib.agent_id_from_cwd(payload.get("cwd"))
    # Parsing lives in ledger_lib (shared with the mid-turn transcript scan --
    # kanban cab2c7e3) so the two capture paths can never drift apart.
    for msg in ledger_lib.extract_channel_messages(payload.get("prompt") or ""):
        try:
            ledger_lib.log_inbound(agent_id, msg["chat_id"], msg["message_id"], msg["text"], msg["ts"])
        except Exception:
            pass  # never block the prompt on a ledger error
    sys.exit(0)


if __name__ == "__main__":
    main()
