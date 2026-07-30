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
    // marketer + researcher moved to permissionMode "permissive" on 2026-07-27
    // (Gabor: "Bypass authorised" -- alex/charlie/ive run with
    // --dangerously-skip-permissions; the hard deny rules stayed). Only
    // developer-junior remains strict, and this guard exists so the per-profile
    // loop below can never go silently empty: if developer-junior also leaves
    // strict mode one day, this fails and the whole describe must be revisited
    // instead of vacuously passing.
    expect(strict.map(p => p.id)).toEqual(
      expect.arrayContaining(['developer-junior']),
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

// A strict profile that allowlists the Skill tool must also be able to READ
// the global skills directory: the skill system routinely reads it (index
// check, level-1 SKILL.md loads by path, skill-writer overlap check), and a
// missing rule froze ive's skill-writer for 35 minutes on the dot-named
// ~/.claude/skills/.skill-index.md (2026-07-06). Probe-verified in ive's real
// environment: the ** glob DOES cover the dot-named index file once the
// render pipeline anchors the rule to // (absolutizeFsPermissionRule), so a
// single rule suffices. Since 2026-07-16 (Gabor-approved, auditor PASS) the
// strict profiles also get Write+Edit on the SHARED skills dir: the
// skill-writer subagent authors fleet skills there by design, and the missing
// pair generated a per-edit approval dialog storm (29 prompts in one night)
// that the every-spawn settings regeneration kept resurrecting.
describe('strict profiles with the Skill tool can use the global skills dir', () => {
  for (const p of listProfileTemplates().filter(
    t => t.permissionMode === 'strict' && t.filesystem.allow.includes('Skill'),
  )) {
    it(`${p.id}: allows reading \${HOME}/.claude/skills/**`, () => {
      expect(p.filesystem.allow).toContain('Read(${HOME}/.claude/skills/**)')
    })

    // The Write+Edit pair is approved for the profiles that back the live
    // fleet agents (alex/charlie/ive run marketer+researcher); the unused
    // developer-junior sandbox profile keeps the narrower default until an
    // agent on it actually needs the skill-writer lane.
    if (p.id === 'marketer' || p.id === 'researcher') {
      it(`${p.id}: allows writing/editing the shared skills dir (skill-writer lane)`, () => {
        expect(p.filesystem.allow).toContain('Write(${HOME}/.claude/skills/**)')
        expect(p.filesystem.allow).toContain('Edit(${HOME}/.claude/skills/**)')
      })
    }
  }
})

// A strict profile that can reply on Telegram must allowlist the WHOLE
// telegram-plugin MCP toolset it is instructed to use, or the first react /
// edit_message / download_attachment call freezes the session on a permission
// prompt nobody sees (observed 2026-07-06: ive froze on `react` -- reply was
// allowed, react was not). The plugin's own MCP instructions tell the model to
// use react for acknowledgements, edit_message for progress updates and
// download_attachment for inbound attachments, so a partial allowlist is a
// standing freeze hazard, not a hardening win: react/edit_message are guarded
// by assertAllowedChat in the plugin (same outward surface class as reply) and
// download_attachment only writes sanitized filenames into the agent's own
// channel inbox under AGENT_DIR.
const TELEGRAM_MCP_TOOLSET = [
  'mcp__plugin_telegram_telegram__reply',
  'mcp__plugin_telegram_telegram__react',
  'mcp__plugin_telegram_telegram__edit_message',
  'mcp__plugin_telegram_telegram__download_attachment',
]

describe('strict profiles with telegram reply allow the full plugin toolset', () => {
  const telegramProfiles = listProfileTemplates().filter(
    p => p.permissionMode === 'strict' &&
      p.filesystem.allow.includes('mcp__plugin_telegram_telegram__reply'),
  )

  it('the telegram-enabled strict profile inventory is the expected one (guards the test itself)', () => {
    // Since the 2026-07-27 permissive switch (marketer + researcher) there is
    // NO strict profile with telegram reply, so the per-profile loop below is
    // expected to generate zero tests. This pin keeps that emptiness a
    // DECISION instead of an accident: if a strict telegram-enabled profile is
    // (re)introduced, this fails, the maintainer confirms the loop below now
    // covers it, and updates this inventory.
    expect(telegramProfiles.map(p => p.id)).toEqual([])
  })

  for (const p of telegramProfiles) {
    it(`${p.id}: no telegram MCP tool is missing from the allowlist`, () => {
      for (const tool of TELEGRAM_MCP_TOOLSET) {
        expect(p.filesystem.allow).toContain(tool)
      }
    })
  }
})
