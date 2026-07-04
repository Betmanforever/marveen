import { describe, it, expect } from 'vitest'
import { listProfileTemplates } from '../web/profiles.js'
import { absolutizeFsPermissionRule } from '../web/profiles.js'

// The Skill tool was missing from every strict profile's allowlist, so ANY
// skill load (e.g. ive loading dataviz for a chart, as its CLAUDE.md mandates)
// froze the session on a permission prompt nobody sees. Fix: strict profiles
// allow the Skill tool broadly -- loading a skill only injects fleet-authored
// instruction text; every side effect still goes through the profile-gated
// Bash/Write/Edit/MCP tools -- and DENY the access/permission/self-pace
// management family. Deny rules are evaluated before allow and reject without
// prompting, so a denied skill fails clean instead of freezing.

// Both the exact-name form Skill(name) and the with-arguments prefix form
// Skill(name *) are needed per the documented matcher semantics
// (code.claude.com/docs/en/skills: "Skill(name) for exact match ...
// Skill(name *) for prefix match with any arguments").
const DENIED_SKILLS = [
  'telegram:access',            // channel pairing/allowlist -- owner-terminal only
  'telegram:configure',         // bot token setup -- owner-terminal only
  'update-config',              // settings.json / permission self-modification
  'fewer-permission-prompts',   // writes its own permission allowlist
  'schedule',                   // self-pace family (mirrors the governance hard-gate)
  'loop',                       // self-pace family
]

describe('every strict profile allowlists the Skill tool', () => {
  const strict = listProfileTemplates().filter(p => p.permissionMode === 'strict')

  it('there are strict profiles to check (guards the test itself)', () => {
    expect(strict.map(p => p.id)).toEqual(
      expect.arrayContaining(['marketer', 'researcher', 'developer-junior']),
    )
  })

  for (const p of listProfileTemplates().filter(t => t.permissionMode === 'strict')) {
    it(`${p.id}: allows Skill broadly (no skill-load can freeze the session)`, () => {
      expect(p.filesystem.allow).toContain('Skill')
    })

    it(`${p.id}: denies the access/permission/self-pace skill family in both matcher forms`, () => {
      for (const s of DENIED_SKILLS) {
        expect(p.filesystem.deny).toContain(`Skill(${s})`)
        expect(p.filesystem.deny).toContain(`Skill(${s} *)`)
      }
    })
  }
})

describe('Skill rules survive the settings.json render pipeline', () => {
  it('the fs-anchor transform leaves Skill rules untouched', () => {
    expect(absolutizeFsPermissionRule('Skill')).toBe('Skill')
    expect(absolutizeFsPermissionRule('Skill(dataviz)')).toBe('Skill(dataviz)')
    expect(absolutizeFsPermissionRule('Skill(telegram:access *)')).toBe('Skill(telegram:access *)')
  })
})
