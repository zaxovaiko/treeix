import type { SearchOptions } from '../../shared/types'

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The same pattern git grep ran, rebuilt in JS to highlight every hit on a line; null when JS can't parse it */
export function matcherFor(query: string, options: SearchOptions): RegExp | null {
  if (!query) return null
  const source = options.regex ? query : escapeRegExp(query)
  try {
    return new RegExp(options.wholeWord ? `(?<![\\w$])(?:${source})(?![\\w$])` : source, options.caseSensitive ? 'g' : 'gi')
  } catch {
    return null
  }
}
