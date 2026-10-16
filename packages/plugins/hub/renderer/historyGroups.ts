const DAY_MS = 24 * 60 * 60 * 1000

/** Calendar days between `at` and `now`, so last night reads as Yesterday even a few hours later */
const daysAgo = (at: number, now: number): number => {
  const midnight = (time: number): number => new Date(time).setHours(0, 0, 0, 0)
  return Math.max(0, Math.round((midnight(now) - midnight(at)) / DAY_MS))
}

const ago = (count: number, unit: string): string => `${count} ${unit}${count === 1 ? '' : 's'} ago`

/** The separator a History row goes under: Today, Yesterday and days through the first week, then weeks, then months */
export function historyGroup(at: number, now = Date.now()): string {
  const days = daysAgo(at, now)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return ago(days, 'day')
  if (days < 30) return ago(Math.floor(days / 7), 'week')
  return ago(Math.floor(days / 30), 'month')
}

/** A row's own time: the clock within a week, where its separator names the day, the date before that */
export const historyTime = (at: number, now = Date.now()): string =>
  daysAgo(at, now) < 7 ? new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' })
