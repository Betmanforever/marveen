// Fleet-wide quiet hours (22:00-06:00 Europe/Budapest).
//
// Overnight an alert is not actionable: every fix behind one (a manual browser
// /login, a look at a wedged session, a DB cleanup) waits for the morning
// anyway, so the alert only costs sleep. Gabor made this a standing rule on
// 2026-07-30 ("Ejjel szunet 22 es 6 kozott"): it moved the start from 23:00 to
// 22:00 and extended the window from the reauth-healer (where it originated,
// after the 2026-07-09 all-night re-alert night) to EVERY notification path.
//
// The rule is about SENDING only: probes and collectors keep running inside the
// window so state stays accurate. How the window is honoured is the caller's
// choice -- drop (the heartbeat filter re-evaluates its whole state every run,
// so nothing is lost) or buffer for a morning summary (reauth-healer,
// channel-monitor, whose alerts are one-off events).
export const QUIET_START_HOUR = 22 // inclusive
export const QUIET_END_HOUR = 6    // exclusive

export function isQuietHour(hourLocal: number): boolean {
  return hourLocal >= QUIET_START_HOUR || hourLocal < QUIET_END_HOUR
}

// Local wall-clock hour in Europe/Budapest regardless of the host TZ (the
// same explicit-TZ rule the rest of the fleet follows for time handling).
export function budapestHour(nowMs: number): number {
  return parseInt(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Budapest', hour: '2-digit', hour12: false }).format(new Date(nowMs)),
    10,
  )
}
