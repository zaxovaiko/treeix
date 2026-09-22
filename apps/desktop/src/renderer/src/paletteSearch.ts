import type { Command } from './CommandPalette'

export const PREFIXES: [prefix: string, name: string, group: string][] = [
  ['>', 'commands', 'Actions'],
  ['#', 'pull requests', 'Pull requests'],
  ['!', 'tasks', 'Tasks'],
  ['@', 'sessions', 'Sessions'],
  ['/', 'files', 'Files'],
  [':', 'settings', 'Settings']
]

/** Before anything is typed; Files and Settings wait for a query, their lists are too long to browse */
const BROWSE_LIMITS: Record<string, number> = { Actions: 20, Worktrees: 30, Files: 0, Settings: 0 }
const BROWSE_LIMIT = 6
/** Per group once typing, so every kind of match stays in view */
const MATCH_LIMIT = 8
/** Searching one group, by prefix or because it's the only one */
const GROUP_LIMIT = 100

const WORD_BREAK = /[\s/\-_.:(!#@]/

/** Where `needle` starts a word of `haystack`, or -1 */
function wordStart(needle: string, haystack: string): number {
  for (let index = haystack.indexOf(needle); index !== -1; index = haystack.indexOf(needle, index + 1)) {
    if (index === 0 || WORD_BREAK.test(haystack[index - 1])) return index
  }
  return -1
}

/**
 * Letters of `needle` in order within `text`: runs and word starts score higher; null when one is missing. A needle
 * typed out whole at a word start wins first, so "split" matches "split" and not an s from "close" and the rest scattered
 */
export function fuzzy(needle: string, text: string): { score: number; marks: number[] } | null {
  const haystack = text.toLowerCase()
  const whole = wordStart(needle, haystack)
  if (whole !== -1) return { score: needle.length * 3 + 2, marks: Array.from(needle, (_, offset) => whole + offset) }
  const marks: number[] = []
  let score = 0
  for (let index = 0; index < haystack.length && marks.length < needle.length; index++) {
    if (haystack[index] !== needle[marks.length]) continue
    score += (index === (marks.at(-1) ?? -2) + 1 ? 3 : 1) + (index === 0 || WORD_BREAK.test(haystack[index - 1]) ? 2 : 0)
    marks.push(index)
  }
  return marks.length === needle.length ? { score, marks } : null
}

export type Result = { command: Command; score: number; marks: Set<number> }

/** Every word must match the label, or failing that the detail or path at a lower score; marks are in the label */
function score(command: Command, words: string[]): Result | null {
  let total = 0
  const marks = new Set<number>()
  for (const word of words) {
    const inLabel = fuzzy(word, command.label)
    const anywhere = inLabel ?? fuzzy(word, `${command.label} ${command.detail ?? ''} ${command.filePath ?? ''}`)
    if (!anywhere) return null
    total += anywhere.score - (inLabel ? 0 : 6)
    inLabel?.marks.forEach((mark) => marks.add(mark))
  }
  return { command, score: total - command.label.length * 0.02, marks }
}

export function paletteResults(commands: Command[], query: string, browseFiles = false): Result[] {
  const prefix = PREFIXES.find(([candidate]) => query.startsWith(candidate))
  // A pasted path like ./src/a.ts still matches src/a.ts
  const words = (prefix ? query.slice(1) : query).trim().replace(/^\.\//, '').toLowerCase().split(/\s+/).filter(Boolean)
  const pool = prefix ? commands.filter((command) => command.group === prefix[2]) : commands
  const groups = [...new Set(pool.map((command) => command.group))]
  const single = prefix !== undefined || groups.length === 1
  if (words.length === 0) {
    const order = ['Actions', ...groups.filter((group) => !(group in BROWSE_LIMITS)), 'Worktrees', 'Files', 'Settings']
    const limit = (group: string): number => (single || (group === 'Files' && browseFiles) ? GROUP_LIMIT : (BROWSE_LIMITS[group] ?? BROWSE_LIMIT))
    return order.flatMap((group) => pool.filter((command) => command.group === group).slice(0, limit(group)).map((command) => ({ command, score: 0, marks: new Set<number>() })))
  }
  const scored = pool.flatMap((command) => score(command, words) ?? []).sort((a, b) => b.score - a.score)
  // Groups in the order of their best match
  return [...new Set(scored.map((result) => result.command.group))].flatMap((group) =>
    scored.filter((result) => result.command.group === group).slice(0, single ? GROUP_LIMIT : MATCH_LIMIT)
  )
}
