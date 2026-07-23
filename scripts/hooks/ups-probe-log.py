#!/usr/bin/env python3
"""THROWAWAY probe hook (comm-reliability plan, Phase-0 assumption check).

Appends one line per UserPromptSubmit event to store/ups-probe.log:
  <iso-ts> <agent-guess> <prompt-head>
Never blocks, never fails the prompt (always exit 0, no stdout).
Delete after the assumption experiment concludes (assumptions #1/#2 of the
inter-agent delivery plan: does the hook fire for every turn source, and is a
settings.json hook change picked up without a session restart).
"""
import sys, os, json, datetime

try:
    raw = sys.stdin.read()
    data = json.loads(raw) if raw.strip() else {}
    prompt = str(data.get("prompt", ""))[:120].replace("\n", "\\n")
    cwd = str(data.get("cwd", os.getcwd()))
    agent = cwd.rstrip("/").split("/")[-1]
    ts = datetime.datetime.now().astimezone().isoformat(timespec="seconds")
    with open("/home/szabgabor/marveen/store/ups-probe.log", "a") as f:
        f.write(f"{ts} agent={agent} prompt={prompt}\n")
except Exception:
    pass
sys.exit(0)
