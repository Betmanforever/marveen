#!/usr/bin/env node
// Thin, transparent MCP stdio proxy.
//
// Sits between an MCP client (Claude Code) and a downstream MCP server spawned
// as a child, relaying newline-delimited JSON-RPC UNCHANGED in both directions
// -- with ONE deliberate exception: the tool list advertised in a `tools/list`
// *response* is filtered down to an allowlist. This exists to cut tool-context
// bloat: the @piotr-agier/google-drive-mcp server advertises ~104 tools; we
// want the fleet to see only the handful it actually uses.
//
// This process sits in the path of EVERY fleet Drive call, so the guiding rule
// is: when in doubt, forward verbatim. Only the tools/list response is ever
// rewritten; every other byte reaches the other side untouched.
//
// Usage:
//   node drive-tool-filter.mjs <child-cmd> [child-args...]
// Example (exactly how the fleet .mcp.json invokes it):
//   node drive-tool-filter.mjs npx -y @piotr-agier/google-drive-mcp start
//
// Allowlist: env DRIVE_TOOL_ALLOWLIST = comma-separated tool names (whitespace
// around each name is trimmed). Unset or empty => NO filtering; every tool
// passes through. That is the safe, fail-open default.
//
// Zero external deps: Node stdlib only, ESM, Node >= 18.

import { spawn } from 'node:child_process'
import os from 'node:os'
import process from 'node:process'

const TAG = '[drive-tool-filter]'
const NL = Buffer.from('\n')
const NL_BYTE = 0x0a
// Cheap pre-parse gate: a tools/list response must literally carry the `tools`
// JSON key. Lines without these bytes cannot be one, so we skip JSON.parse for
// them -- important because Drive tools/call responses can be large (file
// contents) and this proxy is in the hot path of every Drive call.
const TOOLS_NEEDLE = Buffer.from('"tools"')

// --- allowlist -------------------------------------------------------------

function parseAllowlist(raw) {
  if (!raw) return null // unset/empty -> no filtering
  const names = raw
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0)
  return names.length > 0 ? new Set(names) : null
}

const allowlist = parseAllowlist(process.env.DRIVE_TOOL_ALLOWLIST)

// --- child command comes from our own argv ---------------------------------

const cmd = process.argv[2]
const args = process.argv.slice(3)
if (!cmd) {
  process.stderr.write(`${TAG} usage: node drive-tool-filter.mjs <child-cmd> [child-args...]\n`)
  process.exit(2)
}

// Inherit the current env verbatim -- the .mcp.json sets GOOGLE_DRIVE_* vars the
// child needs. shell:false (default) avoids any shell-injection surface.
const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env })

let shuttingDown = false
let forceTimer = null

// Spawn failure (e.g. ENOENT / EACCES): 'error' fires and 'exit' does not.
child.on('error', err => {
  process.stderr.write(`${TAG} failed to spawn "${cmd}": ${err.message}\n`)
  process.exit(1)
})

// --- helpers ---------------------------------------------------------------

// Errors we expect when the peer on one side goes away mid-stream. Swallow them
// so a dying child or a departing client cannot crash the proxy.
function isBenign(err) {
  const code = err && err.code
  return (
    code === 'EPIPE' ||
    code === 'ECONNRESET' ||
    code === 'ERR_STREAM_DESTROYED' ||
    code === 'ERR_STREAM_WRITE_AFTER_END'
  )
}

// A JSON-RPC *response* (no `method`) whose result carries a `tools` array. In
// MCP only tools/list shapes its result this way, so this heuristic needs no
// cross-stream request-id tracking. False negatives fail OPEN (all tools pass
// through unchanged); false positives are effectively impossible.
function isToolsListResponse(msg) {
  return (
    msg !== null &&
    typeof msg === 'object' &&
    !Array.isArray(msg) &&
    typeof msg.method === 'undefined' &&
    msg.result !== null &&
    typeof msg.result === 'object' &&
    !Array.isArray(msg.result) &&
    Array.isArray(msg.result.tools)
  )
}

function isAllowedTool(tool) {
  return (
    tool !== null &&
    typeof tool === 'object' &&
    typeof tool.name === 'string' &&
    allowlist.has(tool.name)
  )
}

function signalExitCode(signal) {
  const n = os.constants.signals[signal]
  return typeof n === 'number' ? 128 + n : 1
}

// --- client -> child : verbatim, byte-for-byte -----------------------------
// Nothing in this direction is inspected, so pipe() is the safest possible
// relay: byte-perfect (no re-serialization), backpressure-aware, and on client
// EOF it ends child.stdin for us (the required stdin-close -> child-stdin-end).
process.stdin.pipe(child.stdin)
child.stdin.on('error', err => {
  if (!isBenign(err)) process.stderr.write(`${TAG} child stdin: ${err.message}\n`)
})
process.stdin.on('error', err => {
  if (!isBenign(err)) process.stderr.write(`${TAG} stdin: ${err.message}\n`)
})

// --- child stderr -> our stderr : verbatim diagnostics ---------------------
// Never routed to stdout (the protocol channel). No line framing needed.
child.stderr.on('data', chunk => {
  process.stderr.write(chunk)
})

// --- child stdout -> client : line-framed, filter only tools/list ----------

let outBuf = Buffer.alloc(0)

function forwardChildLine(line, terminated) {
  // Only a tools/list response is ever rewritten, and it must contain the
  // `"tools"` key. Everything else -- notifications, errors, initialize and
  // tools/call responses (incl. large file payloads) -- skips JSON.parse and
  // is forwarded byte-for-byte.
  if (allowlist !== null && line.length > 0 && line.includes(TOOLS_NEEDLE)) {
    let msg = null
    try {
      msg = JSON.parse(line.toString('utf8'))
    } catch {
      msg = null // not JSON -> fall through, forward raw
    }
    if (msg !== null && isToolsListResponse(msg)) {
      const before = msg.result.tools.length
      msg.result.tools = msg.result.tools.filter(isAllowedTool)
      process.stderr.write(`${TAG} tools/list filtered: ${before} -> ${msg.result.tools.length}\n`)
      // The one message we are allowed to change: reserialize compact + \n.
      // Only result.tools is touched; id, jsonrpc, nextCursor, etc. are kept.
      process.stdout.write(Buffer.from(JSON.stringify(msg) + '\n'))
      return
    }
  }
  // Everything else: forward verbatim. The defensive copy decouples from the
  // stream read buffer; the original trailing newline is preserved (and its
  // absence, on a final unterminated line, is preserved too).
  process.stdout.write(terminated ? Buffer.concat([line, NL]) : Buffer.from(line))
}

child.stdout.on('data', chunk => {
  // Accumulate and split on '\n'. Complete lines are dispatched; the trailing
  // partial stays buffered for the next chunk.
  outBuf = outBuf.length === 0 ? chunk : Buffer.concat([outBuf, chunk])
  let idx
  while ((idx = outBuf.indexOf(NL_BYTE)) !== -1) {
    const line = outBuf.subarray(0, idx) // excludes the '\n'
    outBuf = outBuf.subarray(idx + 1)
    forwardChildLine(line, true)
  }
})

child.stdout.on('end', () => {
  // Stream ended without a trailing newline: flush the final partial line.
  if (outBuf.length > 0) {
    forwardChildLine(outBuf, false)
    outBuf = Buffer.alloc(0)
  }
})

process.stdout.on('error', err => {
  if (!isBenign(err)) process.stderr.write(`${TAG} stdout: ${err.message}\n`)
})

// --- lifecycle -------------------------------------------------------------

child.on('exit', (code, signal) => {
  if (shuttingDown) return
  shuttingDown = true
  if (forceTimer) {
    clearTimeout(forceTimer)
    forceTimer = null
  }
  // Propagate status via exitCode (NOT process.exit) so Node finishes emitting
  // any buffered child.stdout and flushes our stdout before the event loop
  // drains and the process ends -- no truncation of the last response.
  process.exitCode = code === null ? signalExitCode(signal) : code
  // Release the client read side so the loop can empty and we exit.
  if (!process.stdin.destroyed) process.stdin.destroy()
})

// Orphan prevention (beyond the literal spec; see the delivery note). Forward a
// terminating signal to the child so it can shut down cleanly; its 'exit' then
// drives ours. If the child ignores the signal, a short unref'd timer force-
// kills it and bails, so the proxy can never hang unkillable.
function onSignal(sig) {
  if (child.exitCode === null && !child.killed) {
    try {
      child.kill(sig)
    } catch {
      /* already gone */
    }
  }
  if (!forceTimer) {
    forceTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      process.exit(typeof process.exitCode === 'number' ? process.exitCode : 1)
    }, 2000)
    forceTimer.unref?.() // never keep the loop alive on the timer's account
  }
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => onSignal(sig))
}

// Last-resort guard: if the proxy exits by any path while the child still runs,
// don't leave an orphan (it holds OAuth creds + live network sockets).
process.on('exit', () => {
  if (child.exitCode === null && !child.killed) {
    try {
      child.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }
})

// One-line startup diagnostic (stderr only; no secrets, no env dump).
process.stderr.write(
  `${TAG} up; child="${[cmd, ...args].join(' ')}"; ` +
    `filter=${allowlist ? `${allowlist.size} tool(s)` : 'disabled'}\n`
)
