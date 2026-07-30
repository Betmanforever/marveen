import { CHANNEL_PROVIDER, CHANNEL_TOKEN, CHANNEL_CHAT_ID } from './config.js'
import { getProvider } from './channel-provider.js'
import { logger } from './logger.js'

export async function notifyChannel(text: string): Promise<void> {
  if (!CHANNEL_TOKEN || !CHANNEL_CHAT_ID) {
    logger.warn('Channel ertesites kihagyva: token vagy chat ID hianyzik')
    return
  }

  const provider = getProvider(CHANNEL_PROVIDER)
  const formatted = provider.formatMessage(text)
  const chunks = provider.splitMessage(formatted)

  for (const chunk of chunks) {
    try {
      const parseMode = CHANNEL_PROVIDER === 'telegram' ? 'HTML' : undefined
      await provider.sendMessage(CHANNEL_TOKEN, CHANNEL_CHAT_ID, chunk, parseMode)
    } catch (err) {
      logger.warn({ err }, 'notifyChannel: primary send failed, retrying as plain fallback')
      try {
        await provider.sendMessage(CHANNEL_TOKEN, CHANNEL_CHAT_ID, text.slice(0, 4096))
      } catch (fallbackErr) {
        // Both attempts failed: this must never be silent. Every monitoring
        // path in this codebase assumes sendAlert() delivered -- a swallowed
        // failure here means NO alert is ever provably delivered (2026-07-29
        // audit finding, projects/board-decisions/2026-07-29-hibakor-audit-eredmeny.md).
        logger.error({ err: fallbackErr }, 'notifyChannel: fallback send also failed -- alert NOT delivered')
      }
    }
  }
}

// Backward-compatible alias
export const notifyTelegram = notifyChannel
