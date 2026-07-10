import { describe, it, expect } from 'vitest'
import { resolveResumeFlag } from '../web/agent-process.js'

// Explicit-session resume (kanban agent-restart-resume-flag): `--continue`
// picks the latest session by mtime, which made intentional resumes after a
// file migration unreliable. resolveResumeFlag is the pure precedence and
// validation core behind startAgentProcess.

const ID = '6c1a16f1-a17d-43c0-b6c2-4aa01414f52a'
const base = { fresh: false, hasChannel: false, hasPriorSession: true, sessionFileExists: true }

describe('resolveResumeFlag', () => {
  it('emits --resume with the quoted id when an explicit session is requested', () => {
    const r = resolveResumeFlag({ ...base, resumeSessionId: ID })
    expect(r.error).toBeUndefined()
    expect(r.flag).toBe(`--resume '${ID}' `)
  })

  it('rejects a non-UUID id (also the shell-safety gate for the quoted interpolation)', () => {
    const r = resolveResumeFlag({ ...base, resumeSessionId: "x'; rm -rf /" })
    expect(r.error).toMatch(/Invalid resumeSessionId/)
    expect(r.flag).toBe('')
  })

  it('rejects resume + fresh (contradictory intent)', () => {
    expect(resolveResumeFlag({ ...base, fresh: true, resumeSessionId: ID }).error)
      .toMatch(/mutually exclusive/)
  })

  it('rejects resume on channel-having agents (plugin only registers on fresh launch)', () => {
    expect(resolveResumeFlag({ ...base, hasChannel: true, resumeSessionId: ID }).error)
      .toMatch(/channel/)
  })

  it('fails LOUDLY when the target session file is missing (no silent --continue fallback)', () => {
    const r = resolveResumeFlag({ ...base, sessionFileExists: false, resumeSessionId: ID })
    expect(r.error).toMatch(/Session file not found/)
    expect(r.flag).toBe('')
  })

  it('preserves the legacy --continue behaviour when no explicit id is given', () => {
    expect(resolveResumeFlag({ ...base }).flag).toBe('--continue ')
    expect(resolveResumeFlag({ ...base, fresh: true }).flag).toBe('')
    expect(resolveResumeFlag({ ...base, hasChannel: true }).flag).toBe('')
    expect(resolveResumeFlag({ ...base, hasPriorSession: false }).flag).toBe('')
  })
})
