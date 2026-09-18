export function timeAgo(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  const units: [number, string][] = [[31_536_000, 'y'], [2_592_000, 'mo'], [86_400, 'd'], [3600, 'h'], [60, 'm']]
  const [size, unit] = units.find(([unitSeconds]) => seconds >= unitSeconds) ?? [1, 's']
  return `${Math.floor(seconds / size)}${unit}`
}

/** "2h", "5d", "40m" until the given time */
export function untilLabel(at: number | null, now = Date.now()): string {
  if (at === null) return '-'
  const minutes = Math.max(1, Math.round((at - now) / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`
}
