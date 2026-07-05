import { describe, it, expect } from 'vitest'
import { renderProfileClaudeMdSections } from '../web/agent-scaffold.js'
import { loadProfileTemplate } from '../web/profiles.js'

// Strict-profile behavioural CLAUDE.md blocks (one-command Bash, path-scope,
// isolated memory path) are template-sourced from the profile so a NEW agent
// inherits them, instead of hand-patching each live CLAUDE.md.
const CTX = { HOME: '/home/szabgabor', AGENT_DIR: '/home/szabgabor/marveen/agents/bob', INSTALL_DIR: '/home/szabgabor/marveen' }

describe('renderProfileClaudeMdSections', () => {
  it('returns empty string when the profile has no sections', () => {
    expect(renderProfileClaudeMdSections(undefined, CTX, 'bob')).toBe('')
    expect(renderProfileClaudeMdSections([], CTX, 'bob')).toBe('')
  })

  it('resolves ${AGENT_DIR}/${INSTALL_DIR}/${AGENT_NAME} placeholders', () => {
    const out = renderProfileClaudeMdSections(
      ['dir=${AGENT_DIR} install=${INSTALL_DIR} name=${AGENT_NAME}'],
      CTX,
      'bob',
    )
    expect(out).toBe('dir=/home/szabgabor/marveen/agents/bob install=/home/szabgabor/marveen name=bob')
  })

  it('joins multiple sections with a blank line', () => {
    expect(renderProfileClaudeMdSections(['A', 'B'], CTX, 'bob')).toBe('A\n\nB')
  })
})

describe('strict profiles ship the behavioural sections', () => {
  for (const id of ['marketer', 'researcher']) {
    it(`${id}: carries the one-command, path-scope and memory-path rules`, () => {
      const p = loadProfileTemplate(id)
      const rendered = renderProfileClaudeMdSections(p.claudeMdSections, CTX, 'bob')
      expect(rendered).toContain('EGY Bash-hivasban CSAK EGY egyszeru parancsot')
      expect(rendered).toContain('a SAJAT konyvtaradon')
      expect(rendered).toContain('IZOLALT konfigod')
      // Resolvable placeholders fully resolved -- none of the renderer's own
      // tokens leak into the CLAUDE.md. Other ${...} literals are allowed:
      // the watch-wrapper section INTENTIONALLY shows `${VAR}` and
      // `${CLAUDE_SKILL_DIR}` as the exact forms the agent must never type
      // (they hard-block as "Contains expansion"), so a blanket no-${...}
      // assertion would forbid the instruction itself.
      for (const token of ['${AGENT_DIR}', '${HOME}', '${INSTALL_DIR}', '${AGENT_NAME}']) {
        expect(rendered).not.toContain(token)
      }
      // AGENT_DIR resolved to the concrete agent path
      expect(rendered).toContain('/home/szabgabor/marveen/agents/bob/')
    })
  }
})
