/** The sentence holding character `at`, for the caption */
export function sentenceAt(text: string, at: number): { start: number; end: number } {
  let start = 0
  for (const match of text.matchAll(/[.?!]\s|\n/g)) {
    const end = match.index + match[0].length
    if (end > at) return { start, end }
    start = end
  }
  return { start, end: text.length }
}
