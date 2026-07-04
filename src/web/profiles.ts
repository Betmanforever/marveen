import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'

// Each profile is a JSON file under templates/profiles/ with an allow/deny
// list that Claude Code's native permissions engine understands. Choosing a
// strict profile also drops --dangerously-skip-permissions, so Claude Code
// enforces the allow/deny list rather than bypassing it. Channels plugin
// permission prompts (the Telegram Allow/Deny inline buttons) still fire
// because they live on a different notification channel.
export interface ProfileTemplate {
  id: string
  label: string
  description: string
  permissionMode: 'strict' | 'permissive'
  filesystem: {
    allow: string[]
    deny: string[]
    // Optional Claude Code permission tuning, emitted into settings.json as-is.
    // defaultMode: e.g. 'acceptEdits' -- auto-accepts edits/creates in the
    // working dir + additionalDirectories (deny rules still apply). Used by
    // strict profiles so an allowlisted-dir file CREATION is non-interactive
    // without --dangerously-skip-permissions. additionalDirectories: dir paths
    // (placeholders resolved) that extend the acceptEdits scope, e.g. the
    // agent's own AGENT_DIR when the launch cwd is elsewhere.
    defaultMode?: string
    additionalDirectories?: string[]
  }
  // Profile-specific behavioural CLAUDE.md blocks (markdown, placeholders
  // resolved at scaffold time). Appended verbatim to the generated CLAUDE.md so
  // a NEW agent on this profile inherits the strict-profile operating rules
  // (one-command Bash, path-scope, own isolated memory path) instead of relying
  // on a hand-patch to each live file. Template is the single source.
  claudeMdSections?: string[]
}

// Claude Code settings.json permission rules anchor a SINGLE leading slash at
// the PROJECT root, not the filesystem root; a filesystem-absolute path needs a
// DOUBLE leading slash. Profile rules resolve to real absolute paths
// (/home/...), so the Read/Write/Edit (and deny Read) FILESYSTEM rules must be
// re-anchored to `//` or they never match the agent's own dir -- the root cause
// of an allowlisted Write(${AGENT_DIR}/**) still prompting on file creation.
// Bash(...) rules are command-string matches (NOT filesystem-anchored) and MUST
// stay single-slash; relative globs (**/.env) and non-path rules are untouched.
// Pure + exported so the anchor transform is unit-testable.
export function absolutizeFsPermissionRule(rule: string): string {
  const m = rule.match(/^(Read|Write|Edit)\((\/[^/].*)\)$/)
  return m ? `${m[1]}(/${m[2]})` : rule
}

export const PROFILES_DIR = join(PROJECT_ROOT, 'templates', 'profiles')

export const HARDCODED_DEFAULT_PROFILE: ProfileTemplate = {
  id: 'default',
  label: 'Alapértelmezett',
  description: 'Permissive fallback.',
  permissionMode: 'permissive',
  filesystem: { allow: [], deny: ['mcp__claude_ai_Supabase__*'] },
}

export function listProfileTemplates(): ProfileTemplate[] {
  if (!existsSync(PROFILES_DIR)) return [HARDCODED_DEFAULT_PROFILE]
  const out: ProfileTemplate[] = []
  for (const f of readdirSync(PROFILES_DIR)) {
    if (!f.endsWith('.json')) continue
    try {
      const p = JSON.parse(readFileSync(join(PROFILES_DIR, f), 'utf-8')) as ProfileTemplate
      if (p.id) out.push(p)
    } catch { /* skip malformed */ }
  }
  return out.length ? out : [HARDCODED_DEFAULT_PROFILE]
}

export function loadProfileTemplate(id: string): ProfileTemplate {
  const path = join(PROFILES_DIR, `${id}.json`)
  if (existsSync(path)) {
    try { return JSON.parse(readFileSync(path, 'utf-8')) as ProfileTemplate } catch { /* fall through */ }
  }
  if (id !== 'default') return loadProfileTemplate('default')
  return HARDCODED_DEFAULT_PROFILE
}

export function resolveProfilePlaceholders(value: string, ctx: { HOME: string; AGENT_DIR: string; INSTALL_DIR?: string }): string {
  let out = value
    .replace(/\$\{HOME\}/g, ctx.HOME)
    .replace(/\$\{AGENT_DIR\}/g, ctx.AGENT_DIR)
    .replace(/\$\{WORKDIR\}/g, ctx.AGENT_DIR)
  // Install root, for allow-listing the fixed agent-wrapper scripts
  // (scripts/agent-wrappers/*) by their exact absolute path.
  if (ctx.INSTALL_DIR) out = out.replace(/\$\{INSTALL_DIR\}/g, ctx.INSTALL_DIR)
  return out
}
