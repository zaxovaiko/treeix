/** A file path printed in a terminal line, with where it sits so the terminal can underline it */
export type FileLink = { start: number; end: number; path: string; line: number | null }

// Absolute, home-relative or relative paths with at least one slash, optionally followed by :line or :line:column
const FILE_PATH = /(?<![\w/.~-])((?:~|\.{1,2})?\/?[\w@+-][\w.@+-]*(?:\/[\w.@+-]+)+)(?::(\d+)(?::\d+)?)?/g

// A bare file name like pty.ts:42; only code and doc extensions, so example.com and v1.2 stay text
const FILE_NAME = /(?<![\w/.~@-])([\w-][\w.-]*\.(?:tsx?|jsx?|mjs|cjs|json|mdx?|css|scss|html|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|sh|ya?ml|toml|sql|vue|svelte|txt|lock))(?::(\d+)(?::\d+)?)?(?![\w/])/g

/** File paths in one line of terminal text; `start` is the index of the first character, `end` the one after the last */
export function findFileLinks(text: string): FileLink[] {
  const links: FileLink[] = []
  for (const match of text.matchAll(FILE_NAME)) {
    const start = match.index ?? 0
    links.push({ start, end: start + match[0].length, path: match[1], line: match[2] ? Number(match[2]) : null })
  }
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
  return links.sort((a, b) => a.start - b.start)
}

/** Where a path that isn't there from the shell's folder is in the worktree: the shortest file path ending with it */
export function findInFiles(path: string, files: string[]): string | null {
  const suffix = `/${path.replace(/^(\.{1,2}\/)+/, '')}`
  return files.filter((file) => `/${file}`.endsWith(suffix)).sort((a, b) => a.length - b.length)[0] ?? null
}

/** A Jira key like ABC-123 in a terminal line; `project` is ABC */
export type IssueLink = { start: number; end: number; key: string; project: string }

export function findIssueLinks(text: string): IssueLink[] {
  return [...text.matchAll(/(?<![\w-])([A-Z][A-Z0-9_]+)-\d+(?![\w-])/g)].map((match) => ({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length, key: match[0], project: match[1] }))
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

/** Dropped paths as Terminal types them: backslash before anything a shell reads as special, then a space */
export const droppedPaths = (paths: string[]): string => paths.map((path) => `${path.replace(/[^\w./~@%+=:,-]/g, '\\$&')} `).join('')
