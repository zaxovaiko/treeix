/** A file path printed in a terminal line, with where it sits so the terminal can underline it */
export type FileLink = { start: number; end: number; path: string; line: number | null }

// Absolute, home-relative or relative paths with at least one slash, optionally followed by :line or :line:column
const FILE_PATH = /(?<![\w/.~-])((?:~|\.{1,2})?\/?[\w@+-][\w.@+-]*(?:\/[\w.@+-]+)+)(?::(\d+)(?::\d+)?)?/g

/** File paths in one line of terminal text; `start` is the index of the first character, `end` the one after the last */
export function findFileLinks(text: string): FileLink[] {
  const links: FileLink[] = []
  for (const match of text.matchAll(FILE_PATH)) {
    // Sentences end right after a path ("see docs/a.md."), the dot isn't part of it
    const path = match[1].replace(/[.,;:/]+$/, '')
    // Fractions and dates like 3/4 or 2026/09 aren't files
    if (!/[a-z]/i.test(path)) continue
    const start = match.index ?? 0
    const end = start + (match[2] ? match[0].length : path.length)
    if (/^https?:$/.test(text.slice(Math.max(0, start - 6), start)) || text.slice(Math.max(0, start - 3), start) === '://') continue
    links.push({ start, end, path, line: match[2] ? Number(match[2]) : null })
  }
  return links
}

/** An absolute path for `path` as the shell in `cwd` would read it */
export function resolvePath(path: string, cwd: string, home: string): string {
  const absolute = path.startsWith('/') ? path : path.startsWith('~/') ? `${home}${path.slice(1)}` : `${cwd}/${path}`
  const parts: string[] = []
  for (const part of absolute.split('/')) {
    if (part === '..') parts.pop()
    else if (part && part !== '.') parts.push(part)
  }
  return `/${parts.join('/')}`
}

/** A web address printed in a terminal line */
export type WebLink = { start: number; end: number; url: string }

const WEB_URL = /https?:\/\/[^\s<>"'`]+/g

/** Web addresses in one line of terminal text, without the punctuation that ends a sentence or closes brackets around them */
export function findWebLinks(text: string): WebLink[] {
  return [...text.matchAll(WEB_URL)].map((match) => {
    const url = match[0].replace(/[.,;:!?)\]}]+$/, '')
    const start = match.index ?? 0
    return { start, end: start + url.length, url }
  })
}
