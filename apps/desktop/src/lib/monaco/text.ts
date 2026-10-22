/** \r\n and \r both read as \n, so an EOL-only difference (e.g. Monaco's own normalization) doesn't count as a change */
export function normalizeEol(text: string): string {
  return text.replace(/\r\n|\r/g, '\n')
}

/** The lines a line-number drag selected; a selection ending at column 1 stops on the line before */
export function gutterRange(selection: { startLineNumber: number; endLineNumber: number; endColumn: number }): { start: number; end: number } {
  const end = selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber ? selection.endLineNumber - 1 : selection.endLineNumber
  return { start: selection.startLineNumber, end }
}

/** The changed middle between two texts, as offsets into `current` */
export function applyExternalText(current: string, next: string): { start: number; end: number; text: string } | null {
  if (current === next || normalizeEol(current) === normalizeEol(next)) return null
  let start = 0
  while (start < current.length && start < next.length && current[start] === next[start]) start++
  let fromEnd = 0
  while (fromEnd < current.length - start && fromEnd < next.length - start && current[current.length - 1 - fromEnd] === next[next.length - 1 - fromEnd]) fromEnd++
  return { start, end: current.length - fromEnd, text: next.slice(start, next.length - fromEnd) }
}
