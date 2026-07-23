import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  parseDeliveryConfig,
  resolveDeliveryMode,
  loadDeliveryConfigFromFile,
  getDeliveryMode,
  DEFAULT_DELIVERY_MODE,
} from '../web/delivery-config.js'

// Phase-0 delivery-mode registry. The one invariant that MUST hold: any bad
// input resolves to 'legacy' (the delivery path that exists today), never to an
// unimplemented mode.

describe('parseDeliveryConfig (fail-safe normaliser)', () => {
  it('defaults to { agents:{}, default:legacy } for junk input', () => {
    for (const bad of [null, undefined, 'nope', 42, [], true]) {
      expect(parseDeliveryConfig(bad as unknown)).toEqual({ agents: {}, default: 'legacy' })
    }
  })

  it('keeps valid per-agent modes and a valid default', () => {
    const cfg = parseDeliveryConfig({ agents: { neo: 'hook', ive: 'legacy' }, default: 'hook' })
    expect(cfg).toEqual({ agents: { neo: 'hook', ive: 'legacy' }, default: 'hook' })
  })

  it('drops invalid per-agent modes (that agent then falls through to default)', () => {
    const cfg = parseDeliveryConfig({ agents: { neo: 'wild', ive: 'hook', '': 'hook' }, default: 'legacy' })
    expect(cfg.agents).toEqual({ ive: 'hook' }) // 'neo' junk dropped, empty id dropped
    expect(cfg.default).toBe('legacy')
  })

  it('coerces an invalid or missing default back to legacy', () => {
    expect(parseDeliveryConfig({ agents: {}, default: 'garbage' }).default).toBe('legacy')
    expect(parseDeliveryConfig({ agents: { neo: 'hook' } }).default).toBe('legacy')
  })
})

describe('resolveDeliveryMode', () => {
  const cfg = { agents: { neo: 'hook' as const }, default: 'legacy' as const }
  it('returns an explicit agent entry when present', () => {
    expect(resolveDeliveryMode(cfg, 'neo')).toBe('hook')
  })
  it('falls back to the config default for an unlisted agent', () => {
    expect(resolveDeliveryMode(cfg, 'ive')).toBe('legacy')
  })
  it('DEFAULT_DELIVERY_MODE is legacy (fail-safe constant)', () => {
    expect(DEFAULT_DELIVERY_MODE).toBe('legacy')
  })
})

describe('loadDeliveryConfigFromFile (fs fail-safe)', () => {
  it('returns the legacy default for a missing file', () => {
    const cfg = loadDeliveryConfigFromFile(join(tmpdir(), 'does-not-exist-' + Date.now() + '.json'))
    expect(cfg).toEqual({ agents: {}, default: 'legacy' })
  })

  it('returns the legacy default for a corrupt (non-JSON) file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'delivery-cfg-'))
    try {
      const p = join(dir, 'agent-delivery-config.json')
      writeFileSync(p, '{ this is not valid json ')
      const cfg = loadDeliveryConfigFromFile(p)
      expect(cfg).toEqual({ agents: {}, default: 'legacy' })
      // and an unlisted agent still resolves to legacy through it
      expect(resolveDeliveryMode(cfg, 'neo')).toBe('legacy')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('parses a valid file and applies per-agent overrides', () => {
    const dir = mkdtempSync(join(tmpdir(), 'delivery-cfg-'))
    try {
      const p = join(dir, 'agent-delivery-config.json')
      writeFileSync(p, JSON.stringify({ agents: { neo: 'hook' }, default: 'legacy' }))
      const cfg = loadDeliveryConfigFromFile(p)
      expect(resolveDeliveryMode(cfg, 'neo')).toBe('hook')
      expect(resolveDeliveryMode(cfg, 'mr-wolfe')).toBe('legacy')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('getDeliveryMode (live store reader)', () => {
  it('always returns a valid mode and is stable across calls (cache)', () => {
    // Reads the live store/agent-delivery-config.json. Whatever it holds, the
    // result MUST be a valid mode -- the fail-safe guarantees an unknown agent
    // resolves to the file's (legacy) default. Two calls agree (TTL cache).
    const a = getDeliveryMode('no-such-agent-' + Date.now())
    const b = getDeliveryMode('no-such-agent-' + Date.now())
    expect(['legacy', 'hook']).toContain(a)
    expect(a).toBe(b)
  })
})
