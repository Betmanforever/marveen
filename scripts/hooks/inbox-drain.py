#!/usr/bin/env python3
"""UserPromptSubmit hook: PULL the MAIN agent's inter-agent inbox into context.

The main agent's channel session is effectively always busy, so the message
router cannot reliably tmux-inject inter-agent messages into it -- they stall as
'pending' (the ~1h silent-delivery incidents). This hook delivers them the other
way: on each main-agent turn it calls the dashboard
  POST /api/agents/<main>/drain-inbox
which ATOMICALLY claims the pending messages and returns them ALREADY WRAPPED
(the trusted/untrusted/channel-inbound security framing is single-sourced in TS
-- never duplicated here), and prints them so they enter the agent's context.

Identity (Phase 1, reliability plan de234905): the agent id is resolved by
precedence -- explicit --agent argument, then the per-agent CLAUDE_CONFIG_DIR
env (<install>/agents/<id>/.claude-config, set by the dashboard for every
sub-agent session), then cwd. The cwd branch treats ANY path inside the install
dir that is not agents/<id> as the MAIN agent: the old basename fallback turned
a main session parked in projects/<x> into a phantom agent "<x>" and silently
drained nothing for 20+ minutes (2026-07-17 starvation incident).

Whether an agent may drain is the SERVER's decision (main agent always; a
sub-agent only when its delivery_mode is 'hook' -- the same gate that makes the
router skip it, so push and pull can never double-deliver). A legacy sub-agent
that runs this hook just gets a 400 and keeps the router push path.
Never blocks the prompt (always exit 0); a drain error just retries next turn.
"""
import sys
import os
import json
import urllib.error
import urllib.request

_HOOKS_DIR = os.path.dirname(os.path.abspath(__file__))
# scripts/hooks/ -> the install dir, independent of ledger_lib so _trace still
# works when the ledger_lib import itself fails (audit a2f27d28 point 1: an
# import-time exception above the try/except was the one untraceable death).
_INSTALL_DIR = os.path.dirname(os.path.dirname(_HOOKS_DIR))


def _trace(line):
    """Append a one-line trace to store/inbox-drain.log. The silent `except:
    pass` below made a 2026-07-13 delivery outage undiagnosable (the hook
    stopped claiming for hours with zero evidence of WHERE it died -- gate,
    token, HTTP, or never invoked at all). Never raises; tracing must not
    break the never-block-the-prompt contract."""
    try:
        import datetime
        path = os.path.join(_INSTALL_DIR, "store", "inbox-drain.log")
        with open(path, "a") as f:
            f.write("%s %s\n" % (datetime.datetime.now().strftime("%m-%d %H:%M:%S"), line))
    except Exception:
        pass


sys.path.insert(0, _HOOKS_DIR)
try:
    import ledger_lib  # noqa: E402
except Exception as e:  # import-time death must leave a trace, then not block
    _trace("EXIT ledger_lib-import-failed %s: %s" % (type(e).__name__, e))
    sys.exit(0)


def _web_port():
    """Dashboard port: WEB_PORT env, then the install .env, default 3420. Never
    hardcode an install-specific value (distribution rule)."""
    v = os.environ.get("WEB_PORT")
    if v and v.strip().isdigit():
        return v.strip()
    try:
        with open(os.path.join(ledger_lib._install_dir(), ".env")) as f:
            for line in f:
                if line.startswith("WEB_PORT="):
                    p = line.split("=", 1)[1].strip()
                    if p.isdigit():
                        return p
    except Exception:
        pass
    return "3420"


def _resolve_agent_id(cwd):
    """Agent identity, most-reliable source first. Returns (agent_id, source)
    so the trace shows WHICH rung resolved it -- the 07-17 incident was
    undiagnosable partly because the log could not say how the (wrong) id was
    derived."""
    # 1. Explicit --agent from the hook command line: operator override, wins.
    argv = sys.argv[1:]
    for i, a in enumerate(argv):
        if a == "--agent" and i + 1 < len(argv) and argv[i + 1].strip():
            return argv[i + 1].strip(), "arg"
        if a.startswith("--agent=") and a.split("=", 1)[1].strip():
            return a.split("=", 1)[1].strip(), "arg"

    # 2. CLAUDE_CONFIG_DIR: the dashboard exports <install>/agents/<id>/
    #    .claude-config into every sub-agent session, and it never changes when
    #    the session cd-s around -- unlike cwd.
    install = ledger_lib._install_dir().rstrip("/")
    cfg = (os.environ.get("CLAUDE_CONFIG_DIR") or "").rstrip("/")
    agents_root = os.path.join(install, "agents") + os.sep
    if cfg.startswith(agents_root):
        rel = cfg[len(agents_root):]
        head = rel.split(os.sep)[0]
        if head:
            return head, "env"

    # 3. cwd, with the phantom-agent fallback FIXED: inside the install dir,
    #    only agents/<id> means a sub-agent; anything else (projects/<x>, the
    #    root, scripts/...) is the main agent wandering, NOT an agent named
    #    after the directory (ledger_lib.agent_id_from_cwd's basename fallback
    #    caused the 2026-07-17 starvation: cwd=projects/books-source resolved
    #    to phantom agent_id=books-source and the drain exited every turn).
    c = (cwd or "").rstrip("/")
    if c.startswith(agents_root):
        rel = c[len(agents_root):]
        head = rel.split(os.sep)[0]
        if head:
            return head, "cwd"
    return ledger_lib.main_agent_id(), "cwd-main-default"


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        _trace("EXIT bad-stdin-payload")
        sys.exit(0)

    agent_id, id_source = _resolve_agent_id(payload.get("cwd"))

    try:
        token_path = os.path.join(ledger_lib._install_dir(), "store", ".dashboard-token")
        with open(token_path) as f:
            token = f.read().strip()
        if not token:
            sys.exit(0)
        url = "http://127.0.0.1:%s/api/agents/%s/drain-inbox" % (_web_port(), agent_id)
        req = urllib.request.Request(
            url,
            data=b"{}",
            method="POST",
            headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.load(resp)
        text = (data or {}).get("text") or ""
        _trace("OK agent=%s src=%s count=%s" % (agent_id, id_source, (data or {}).get("count")))
        if text:
            # UserPromptSubmit hook stdout is prepended to the agent's context.
            sys.stdout.write(text)
            sys.stdout.write("\n")
        # Two-phase ack (claim-lease model, de234905): only AFTER the response
        # body was fully received -- and thus the content is guaranteed to enter
        # this turn's context -- finalize the claim. If the drain response is
        # lost (the msg#1791 timeout class), no ack happens and the server-side
        # lease expiry returns the message to pending for redelivery. An ack
        # failure here is harmless: the lease just expires and the message is
        # redelivered with a dedup marker (at-least-once, never silent loss).
        ids = (data or {}).get("ids") or []
        if ids:
            # Flush BEFORE acking: stdout is block-buffered to a pipe, so without
            # this the content could still sit in the userspace buffer when the
            # lease is finalized -- a kill in that window would ack undelivered
            # content. Flush first makes the "received -> in context -> ack"
            # ordering airtight.
            sys.stdout.flush()
            try:
                ack = urllib.request.Request(
                    "http://127.0.0.1:%s/api/agents/%s/drain-ack" % (_web_port(), agent_id),
                    data=json.dumps({"ids": ids}).encode(),
                    method="POST",
                    headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
                )
                with urllib.request.urlopen(ack, timeout=5) as aresp:
                    adata = json.load(aresp)
                _trace("ACK agent=%s acked=%s" % (agent_id, (adata or {}).get("acked")))
            except Exception as e:
                _trace("ACK-FAIL agent=%s %s: %s (lease will expire -> redelivery)" % (agent_id, type(e).__name__, e))
    except urllib.error.HTTPError as e:
        # 400 = this agent is not allowed to pull (legacy sub-agent): expected
        # between hook-install and the mode flip, the router still pushes.
        _trace("DENIED agent=%s src=%s http=%s" % (agent_id, id_source, e.code)
               if e.code == 400 else
               "FAIL agent=%s src=%s HTTPError: %s" % (agent_id, id_source, e.code))
    except Exception as e:
        # never block the prompt on a drain error -- the next turn retries
        _trace("FAIL agent=%s src=%s %s: %s" % (agent_id, id_source, type(e).__name__, e))

    sys.exit(0)


if __name__ == "__main__":
    main()
