import { describe, it, expect } from 'vitest'
import { absolutizeFsPermissionRule, resolveProfilePlaceholders, loadProfileTemplate } from '../web/profiles.js'

// Root cause of "allowlisted-dir file creation still prompts": Claude Code
// settings.json rules anchor a SINGLE leading slash at the project root, not the
// filesystem root. A resolved profile rule Write(/home/.../agents/x/**) therefore
// never matches the real path; it needs a DOUBLE slash. absolutizeFsPermissionRule
// re-anchors the filesystem Read/Write/Edit rules; command-string Bash rules and
// relative/tool-name rules are left untouched.
const CTX = {
  HOME: '/home/szabgabor',
  AGENT_DIR: '/home/szabgabor/marveen/agents/alex',
  INSTALL_DIR: '/home/szabgabor/marveen',
}

describe('absolutizeFsPermissionRule', () => {
  it('re-anchors Read/Write/Edit absolute filesystem paths to //', () => {
    expect(absolutizeFsPermissionRule('Write(/home/szabgabor/marveen/agents/alex/**)'))
      .toBe('Write(//home/szabgabor/marveen/agents/alex/**)')
    expect(absolutizeFsPermissionRule('Read(/home/szabgabor/.ssh/**)'))
      .toBe('Read(//home/szabgabor/.ssh/**)')
    expect(absolutizeFsPermissionRule('Edit(/a/b/**)')).toBe('Edit(//a/b/**)')
  })

  it('leaves Bash command-string rules untouched (NOT filesystem-anchored)', () => {
    // A wrapper invoked by absolute path is still a command string, not a path rule.
    expect(absolutizeFsPermissionRule('Bash(/home/szabgabor/marveen/scripts/agent-wrappers/memo.sh:*)'))
      .toBe('Bash(/home/szabgabor/marveen/scripts/agent-wrappers/memo.sh:*)')
    expect(absolutizeFsPermissionRule('Bash(ls:*)')).toBe('Bash(ls:*)')
  })

  it('leaves relative globs, tool-name and MCP rules untouched', () => {
    expect(absolutizeFsPermissionRule('Read(**/.env)')).toBe('Read(**/.env)')
    expect(absolutizeFsPermissionRule('WebFetch(*)')).toBe('WebFetch(*)')
    expect(absolutizeFsPermissionRule('ScheduleWakeup')).toBe('ScheduleWakeup')
    expect(absolutizeFsPermissionRule('mcp__plugin_telegram_telegram__reply')).toBe('mcp__plugin_telegram_telegram__reply')
  })

  it('is idempotent (an already-// path is not touched)', () => {
    expect(absolutizeFsPermissionRule('Write(//a/b/**)')).toBe('Write(//a/b/**)')
  })
})

describe('resolved + anchored profile rules (what the generated settings.json contains)', () => {
  const fix = (r: string) => absolutizeFsPermissionRule(resolveProfilePlaceholders(r, CTX))

  it('turns a profile AGENT_DIR rule into a // absolute rule', () => {
    expect(fix('Write(${AGENT_DIR}/**)')).toBe('Write(//home/szabgabor/marveen/agents/alex/**)')
    expect(fix('Read(${AGENT_DIR}/**)')).toBe('Read(//home/szabgabor/marveen/agents/alex/**)')
  })

  it('turns a profile HOME deny rule into a // absolute rule', () => {
    expect(fix('Read(${HOME}/.ssh/**)')).toBe('Read(//home/szabgabor/.ssh/**)')
  })

  it('keeps the wrapper Bash rules functional (single-slash command path)', () => {
    expect(fix('Bash(${INSTALL_DIR}/scripts/agent-wrappers/memo.sh:*)'))
      .toBe('Bash(/home/szabgabor/marveen/scripts/agent-wrappers/memo.sh:*)')
  })

  it('keeps the **/.env deny relative (still blocks any .env)', () => {
    expect(fix('Read(**/.env)')).toBe('Read(**/.env)')
  })
})

describe('strict profiles deny self-modification of their own privilege files', () => {
  // The // fix makes AGENT_DIR writable; deny rules (checked in every mode,
  // incl. acceptEdits) stop the agent rewriting its own settings.json / hooks /
  // CLAUDE.md, which would be a privilege/persistence escalation. skills and the
  // memory dir stay writable (self-learning).
  const fix = (r: string) => absolutizeFsPermissionRule(resolveProfilePlaceholders(r, CTX))
  for (const id of ['marketer', 'researcher']) {
    it(`${id}: denies Write/Edit of settings.json, hooks, CLAUDE.md (// anchored)`, () => {
      const deny = loadProfileTemplate(id).filesystem.deny.map(fix)
      expect(deny).toContain('Write(//home/szabgabor/marveen/agents/alex/.claude/settings.json)')
      expect(deny).toContain('Edit(//home/szabgabor/marveen/agents/alex/.claude/hooks/**)')
      expect(deny).toContain('Write(//home/szabgabor/marveen/agents/alex/CLAUDE.md)')
    })
    it(`${id}: acceptEdits is DEFERRED (stage 1 is //-only, unmasked validation)`, () => {
      const p = loadProfileTemplate(id)
      expect(p.filesystem.defaultMode).toBeUndefined()
      expect(p.filesystem.additionalDirectories).toBeUndefined()
    })
  }
})

describe('the code still supports the optional acceptEdits tuning (stage 2)', () => {
  // Even though the shipped profiles defer it, absolutize + the schema fields
  // remain wired so stage 2 (add acceptEdits) is a pure profile-JSON change.
  it('a profile that sets defaultMode/additionalDirectories keeps them resolvable', () => {
    const synthetic = { filesystem: { allow: [], deny: [], defaultMode: 'acceptEdits', additionalDirectories: ['${AGENT_DIR}'] } }
    expect(synthetic.filesystem.defaultMode).toBe('acceptEdits')
    expect(synthetic.filesystem.additionalDirectories.map(d => resolveProfilePlaceholders(d, CTX)))
      .toEqual(['/home/szabgabor/marveen/agents/alex'])
  })
})
