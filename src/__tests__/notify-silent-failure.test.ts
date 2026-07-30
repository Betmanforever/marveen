import { describe, it, expect, vi, beforeEach } from 'vitest'

// Deterministic proof for the 2026-07-29 audit finding: notifyChannel() must
// leave a VISIBLE trace when delivery fails end-to-end, not swallow it
// silently (the bug that made every alert in the system unprovable). Mocks
// config + channel-provider so the test never touches a real network/token.
vi.mock('../config.js', () => ({
  CHANNEL_PROVIDER: 'telegram',
  CHANNEL_TOKEN: 'test-token',
  CHANNEL_CHAT_ID: 'test-chat-id',
}))

const sendMessage = vi.fn().mockRejectedValue(new Error('deliberately broken send'))
vi.mock('../channel-provider.js', () => ({
  getProvider: () => ({
    sendMessage,
    formatMessage: (t: string) => t,
    splitMessage: (t: string) => [t],
  }),
}))

const loggerError = vi.fn()
const loggerWarn = vi.fn()
vi.mock('../logger.js', () => ({
  logger: { error: loggerError, warn: loggerWarn, info: vi.fn() },
}))

describe('notifyChannel silent-failure fix (2026-07-29 audit)', () => {
  beforeEach(() => {
    sendMessage.mockClear()
    loggerError.mockClear()
    loggerWarn.mockClear()
  })

  it('logs an ERROR when both the primary send and the fallback send fail -- never silent', async () => {
    const { notifyChannel } = await import('../notify.js')
    await notifyChannel('deliberately broken delivery path')

    // Both attempts must actually have been made (primary + fallback retry).
    expect(sendMessage).toHaveBeenCalledTimes(2)
    // Before the fix this path was `catch { /* last resort, give up */ }` --
    // zero log calls, zero trace. The fix requires a visible ERROR log.
    expect(loggerError).toHaveBeenCalledTimes(1)
    expect(loggerError.mock.calls[0][1]).toMatch(/fallback send also failed/i)
    // The primary failure should also be visible (not just the final one).
    expect(loggerWarn).toHaveBeenCalledTimes(1)
  })
})
