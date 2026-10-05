/** Each field's range, in crontab order: minute, hour, day of month, month, day of week (0 and 7 are Sunday) */
const RANGES = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7]
] as const

/** The values one field allows: `*`, `5`, `1-5`, `*\/15`, `5/15`, `1-5/2` and lists of them; null when malformed */
function field(text: string, [min, max]: readonly [number, number]): Set<number> | null {
  const values = new Set<number>()
  for (const part of text.split(',')) {
    const match = /^(?:(\*)|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part)
    if (!match) return null
    const [, star, from, to, step] = match
    const stride = step ? Number(step) : 1
    const start = star ? min : Number(from)
    // A bare `5/15` runs from 5 to the end of the range, as cron reads it
    const end = star ? max : to ? Number(to) : step ? max : start
    if (start < min || end > max || start > end || stride < 1) return null
    for (let value = start; value <= end; value += stride) values.add(value)
  }
  return values
}

const parse = (expression: string): { fields: Set<number>[]; parts: string[] } | null => {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== RANGES.length) return null
  const fields = parts.map((part, index) => field(part, RANGES[index]))
  return fields.every((entry) => entry !== null) ? { fields, parts } : null
}

export const isCron = (expression: string): boolean => parse(expression) !== null

/** Whether a five-field crontab expression fires in the minute of `date`, in local time */
export function cronMatches(expression: string, date: Date): boolean {
  const parsed = parse(expression)
  if (!parsed) return false
  const [minutes, hours, days, months, weekdays] = parsed.fields
  const dayOk = days.has(date.getDate())
  const weekdayOk = weekdays.has(date.getDay()) || (date.getDay() === 0 && weekdays.has(7))
  // Cron's rule: with both day fields restricted, either one is enough
  const day = parsed.parts[2] !== '*' && parsed.parts[4] !== '*' ? dayOk || weekdayOk : dayOk && weekdayOk
  return minutes.has(date.getMinutes()) && hours.has(date.getHours()) && months.has(date.getMonth() + 1) && day
}

/** Common schedules by name; any other crontab line works too */
export const CRON_PRESETS = [
  { cron: '0 9 * * 1', label: 'Every Monday at 9:00' },
  { cron: '0 9 * * 1-5', label: 'Every weekday at 9:00' },
  { cron: '0 9 * * *', label: 'Every day at 9:00' },
  { cron: '0 * * * *', label: 'Every hour' },
  { cron: '0 9 1 * *', label: 'On the 1st of every month at 9:00' }
] as const
