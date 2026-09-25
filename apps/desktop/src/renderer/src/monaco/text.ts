/** The changed middle between two texts, as offsets into `current` */
export function applyExternalText(current: string, next: string): { start: number; end: number; text: string } | null {
  if (current === next) return null
  let start = 0
  while (start < current.length && start < next.length && current[start] === next[start]) start++
  let fromEnd = 0
  while (fromEnd < current.length - start && fromEnd < next.length - start && current[current.length - 1 - fromEnd] === next[next.length - 1 - fromEnd]) fromEnd++
  return { start, end: current.length - fromEnd, text: next.slice(start, next.length - fromEnd) }
}
