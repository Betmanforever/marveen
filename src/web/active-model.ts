import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// Claude Code writes one .jsonl session log per session under
// ~/.claude/projects/<encoded-working-dir>/. Every assistant turn carries the
// model id that answered it. We use that to surface the *live* running model
// (vs. the configured value in agent-config.json), so the dashboard can show
// what the running process is actually using, including across restarts.
//
// When an agent is launched with --continue, Claude Code appends to the same
// session jsonl across restarts, so the latest "model" field may reflect a
// pre-restart turn rather than the freshly-spawned process. Callers that know
// when the current session started should pass sinceUnixSec; we then ignore
// any line whose own timestamp predates that, leaving the caller to fall back
// to the configured model until the new session writes its first turn.
const cache = new Map<string, { value: string | null; expiresAt: number }>()
const TTL_MS = 3000

// Resolve the session-log directory Claude Code writes for a working dir.
// Logs live under <config-root>/projects/<encoded-working-dir>/, where the
// config root is ~/.claude by default but an alternate one when the agent was
// launched with CLAUDE_CONFIG_DIR. Pass that absolute config root as configDir
// so we read the right project dir for agents on a non-default config.
export function projectsDirFor(workingDir: string, configDir?: string, homeDirOverride?: string): string {
  const base = configDir ?? join(homeDirOverride ?? homedir(), '.claude')
  const encoded = workingDir.replace(/[/.]/g, '-')
  return join(base, 'projects', encoded)
}

export function readActiveModelFromProjectDir(workingDir: string, sinceUnixSec?: number, configDir?: string): string | null {
  const now = Date.now()
  const cacheKey = `${workingDir}:${sinceUnixSec ?? ''}:${configDir ?? ''}`
  const cached = cache.get(cacheKey)
  if (cached && cached.expiresAt > now) return cached.value
  let value: string | null = null
  try {
    const dir = projectsDirFor(workingDir, configDir)
    if (!existsSync(dir)) {
      cache.set(cacheKey, { value: null, expiresAt: now + TTL_MS })
      return null
    }
    const jsonls = readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
    if (jsonls.length === 0) {
      cache.set(cacheKey, { value: null, expiresAt: now + TTL_MS })
      return null
    }
    const content = readFileSync(join(dir, jsonls[0].f), 'utf-8')
    const lines = content.split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim()
      if (!line) continue
      try {
        const entry = JSON.parse(line)
        const msg = entry?.message
        const model = msg?.model
        if (typeof model !== 'string' || model.startsWith('<')) continue
        if (sinceUnixSec !== undefined) {
          const ts = entry?.timestamp
          if (typeof ts !== 'string') continue
          const lineUnix = Math.floor(new Date(ts).getTime() / 1000)
          if (!Number.isFinite(lineUnix) || lineUnix < sinceUnixSec) continue
        }
        value = model
        break
      } catch { /* skip malformed JSON line */ }
    }
  } catch { /* fall through */ }
  cache.set(cacheKey, { value, expiresAt: now + TTL_MS })
  return value
}

// How far back from the end of the newest transcript we look for the current
// process boot. A drift check needs the FIRST models a boot answered with (see
// deriveMeasuredModel), so it has to find the boot boundary in the file; the
// transcripts are append-only and grow to tens of MB (measured: 34MB for one
// live agent), which rules out reading them whole every sweep.
//
// 2MB covers roughly 250 assistant turns at the measured ~8-14KB/turn -- i.e.
// hours of work -- and is read at most once per agent per sweep. Past that the
// scan reports "unmeasurable" (empty) rather than guessing, which is the safe
// direction: no measurement means no restart. That blind spot is by design --
// this reader exists to close the RESTART window, where the boundary is always
// within a few KB of the end; a long-running session's drift is the hourly
// scripts/check-model-drift.sh detector's job.
const BOOT_SCAN_TAIL_BYTES = 2 * 1024 * 1024

// The tmux session's own transcript is not always the newest file in the
// project dir: headless `claude -p` runs (the fallback runner's own model
// probe, the audit-brief exporter) write their session logs to the SAME
// directory, and they are short-lived, so one of them is routinely the most
// recently modified. Measured 2026-07-31 in the main agent's dir: 8dff4bdf and
// 7431a458 (both `sdk-cli`, both answering on Sonnet) were newer than the live
// Fable session -- reading either would have reported a drift that does not
// exist and restarted Mr. Wolfe for it. They are told apart by `entrypoint`.
//
// Requiring the interactive value (rather than excluding the known headless
// one) is a deliberate fail-MUTE: if this field ever changes shape the
// detector stops correcting instead of restarting agents on a misread. The
// hourly scripts/check-model-drift.sh stays the independent backstop.
const INTERACTIVE_ENTRYPOINT = 'cli'

// How many recent logs to try before giving up. Enough to step past a couple
// of concurrent headless runs; the mtime filter already removes the rest.
const MAX_CANDIDATE_LOGS = 4

function noSample(): BootModelSample {
  return { bootModels: [], latestModel: null }
}

export interface BootModelSample {
  /**
   * Model ids of the first `limit` assistant turns the CURRENT process boot
   * produced, in order. EMPTY means "no measurement", which callers must treat
   * as "take no action": no transcript, a session too young to have answered
   * yet, or -- crucially -- a boot boundary outside the scanned tail, where the
   * earliest visible turns are NOT the boot's first turns and could be
   * sub-agent traffic.
   */
  bootModels: string[]
  /** Model of the MOST RECENT turn since the boot, or null when there is none. */
  latestModel: string | null
}

/**
 * Sample the live session log for what a boot started on and what it is
 * answering with right now, in ONE tail read.
 *
 * Both halves are needed and neither is sufficient alone. `bootModels` is the
 * structurally sound measurement -- a sub-agent cannot answer before the main
 * loop's own first turn -- but it never changes for the life of the boot, so
 * after a mid-session `/model` fix it keeps reporting the drift the operator
 * already cleared (verified on the 2026-07-31 incident log: the boot rows read
 * Sonnet long after the owner had switched the session back to Fable).
 * `latestModel` is current but sub-agent-pollutable, so it is only ever used to
 * VETO a correction, never to trigger one -- the direction where a wrong read
 * costs a delayed fix instead of a wrong restart.
 *
 * NOT cached: the caller is a 10-60s sweep and a stale hit would delay exactly
 * the detection this exists for. Only the TOP level of the project dir is
 * listed, so the `<session>/subagents/agent-*.jsonl` sidecars Claude Code
 * 2.1.220 writes for Task-tool runs cannot be mistaken for the session log.
 */
export function readBootModelSample(
  workingDir: string,
  sinceUnixSec: number,
  configDir?: string,
  limit = 7,
): BootModelSample {
  try {
    const dir = projectsDirFor(workingDir, configDir)
    if (!existsSync(dir)) return noSample()
    const candidates = readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
      // A log untouched since the boot cannot hold a turn from it. This is
      // what keeps the scan off the ~150 historical session logs a long-lived
      // project dir accumulates.
      .filter(x => x.mtime >= sinceUnixSec * 1000)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, MAX_CANDIDATE_LOGS)
    for (const c of candidates) {
      const sample = scanSessionLog(join(dir, c.f), sinceUnixSec, limit)
      if (sample) return sample
    }
  } catch { /* fall through */ }
  return noSample()
}

/**
 * Scan ONE session log's tail. Returns null when it carries no interactive
 * turn from this boot -- i.e. it is not the log we are looking for.
 */
function scanSessionLog(path: string, sinceUnixSec: number, limit: number): BootModelSample | null {
  const bootModels: string[] = []
  let latestModel: string | null = null
  const size = statSync(path).size
  const from = Math.max(0, size - BOOT_SCAN_TAIL_BYTES)
  const fd = openSync(path, 'r')
  let chunk: string
  try {
    const buf = Buffer.allocUnsafe(size - from)
    const read = readSync(fd, buf, 0, buf.length, from)
    chunk = buf.subarray(0, read).toString('utf-8')
  } finally {
    closeSync(fd)
  }
  const lines = chunk.split('\n')
  // Reading from a byte offset lands mid-line (and possibly mid-UTF-8-char).
  if (from > 0) lines.shift()
  // Proof that the boot boundary is inside the scanned tail: a turn from
  // BEFORE it. Trivially true when the whole file was read.
  let sawPreBoot = from === 0
  // Cleared the moment a post-boot turn shows up without that proof: the
  // boot-row sample is then unusable, but the scan continues because
  // latestModel stays valid (every tail turn is post-boot in that case).
  let bootRowsUsable = true
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    let entry: any
    try { entry = JSON.parse(line) } catch { continue }
    const rawTs = entry?.timestamp
    if (typeof rawTs !== 'string') continue
    const ts = Math.floor(new Date(rawTs).getTime() / 1000)
    if (!Number.isFinite(ts)) continue
    if (ts < sinceUnixSec) { sawPreBoot = true; continue }
    if (!sawPreBoot) bootRowsUsable = false
    if (entry?.type !== 'assistant') continue
    if (entry?.entrypoint !== INTERACTIVE_ENTRYPOINT) continue
    const model = entry?.message?.model
    if (typeof model !== 'string' || !model || model.startsWith('<')) continue
    latestModel = model
    if (bootRowsUsable && bootModels.length < limit) bootModels.push(model)
  }
  if (latestModel === null) return null
  return { bootModels: bootRowsUsable ? bootModels : [], latestModel }
}

const ctxCache = new Map<string, { value: number | null; expiresAt: number }>()

// Current context size of the live session, in tokens. Claude Code records a
// `usage` object on each assistant turn; the context that gets re-read every
// turn is input_tokens + cache_read_input_tokens + cache_creation_input_tokens
// (output_tokens is the new reply, not context). We scan the newest transcript
// from the end for the last turn carrying a usage and sum those three. Returns
// null when there is no transcript / no usage yet (fresh session). This is what
// the dashboard surfaces so the operator can see a session growing heavy and
// decide to restart it.
export function readContextTokensFromProjectDir(workingDir: string, configDir?: string): number | null {
  const now = Date.now()
  const cacheKey = `${workingDir}:${configDir ?? ''}`
  const cached = ctxCache.get(cacheKey)
  if (cached && cached.expiresAt > now) return cached.value
  let value: number | null = null
  try {
    const dir = projectsDirFor(workingDir, configDir)
    if (existsSync(dir)) {
      const jsonls = readdirSync(dir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
      if (jsonls.length > 0) {
        const content = readFileSync(join(dir, jsonls[0].f), 'utf-8')
        const lines = content.split('\n')
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i].trim()
          if (!line) continue
          try {
            const u = JSON.parse(line)?.message?.usage
            if (u && typeof u === 'object') {
              const inp = Number(u.input_tokens) || 0
              const cr = Number(u.cache_read_input_tokens) || 0
              const cc = Number(u.cache_creation_input_tokens) || 0
              const total = inp + cr + cc
              if (total > 0) { value = total; break }
            }
          } catch { /* skip malformed JSON line */ }
        }
      }
    }
  } catch { /* fall through */ }
  ctxCache.set(cacheKey, { value, expiresAt: now + TTL_MS })
  return value
}
