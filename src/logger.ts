import pino from 'pino'

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport:
    process.env.NODE_ENV !== 'production'
      // Date on every line (audit M10, 2026-07-31): pino-pretty's default
      // [HH:MM:ss] made two different days' entries indistinguishable in
      // dashboard.log, which produced a wrong incident root cause. SYS: keeps
      // the fleet's local-time convention (Europe/Budapest).
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l' } }
      : undefined,
})
