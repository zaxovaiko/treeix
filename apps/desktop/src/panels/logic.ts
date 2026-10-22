import type { ChangeStatus, PullRequest } from '../ipc/api'

/** VS Code's letters: U is untracked, ! a conflict */
export const STATUS_LETTER: Record<ChangeStatus, string> = { added: 'A', modified: 'M', renamed: 'R', deleted: 'D', untracked: 'U', conflicted: '!' }
export const STATUS_CLASS: Record<ChangeStatus, string> = { added: 'gs-A', modified: 'gs-M', renamed: 'gs-M', deleted: 'gs-D', untracked: 'gs-A', conflicted: 'gs-C' }

/** An ignored path, or one inside an ignored folder (`ignored` folders end with `/`) */
export function isIgnored(path: string, ignored: Set<string>): boolean {
  const clean = path.replace(/\/$/, '')
  if (ignored.has(clean) || ignored.has(`${clean}/`)) return true
  for (let i = clean.indexOf('/'); i !== -1; i = clean.indexOf('/', i + 1)) if (ignored.has(clean.slice(0, i + 1))) return true
  return false
}

export interface DiffLine {
  kind: ' ' | '+' | '-'
  old: number | null
  new: number | null
  text: string
}

export interface Hunk {
  header: string
  lines: DiffLine[]
}

/** Hunks of a `diff --git` text, with old/new line numbers */
export function parseHunks(patch: string): Hunk[] {
  const hunks: Hunk[] = []
  let old = 0
  let cur = 0
  for (const line of patch.split('\n')) {
    const head = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (head) {
      old = Number(head[1])
      cur = Number(head[2])
      hunks.push({ header: line, lines: [] })
      continue
    }
    const hunk = hunks.at(-1)
    const kind = line[0]
    if (!hunk || (kind !== ' ' && kind !== '+' && kind !== '-')) continue
    hunk.lines.push({ kind, old: kind === '+' ? null : old++, new: kind === '-' ? null : cur++, text: line.slice(1) })
  }
  return hunks
}

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

/** Short age like the sidebar's: now, 5m, 3h, 2d */
export function ago(ms: number, now = Date.now()): string {
  const d = Math.max(0, now - ms)
  if (d < MINUTE) return 'now'
  if (d < 60 * MINUTE) return `${Math.floor(d / MINUTE)}m`
  if (d < DAY) return `${Math.floor(d / (60 * MINUTE))}h`
  return `${Math.floor(d / DAY)}d`
}

/** History's day headers */
export function dayLabel(ms: number, now = Date.now()): string {
  const start = new Date(now).setHours(0, 0, 0, 0)
  if (ms >= start) return 'Today'
  if (ms >= start - DAY) return 'Yesterday'
  return new Date(ms).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

export const isMine = (pr: PullRequest, user: string | null) => pr.review?.state === 'yours' || (!!user && pr.author === user)

/** Badge count: open PRs waiting on your review, or yours with failing CI */
export const needsYou = (pr: PullRequest, user: string | null) =>
  pr.state === 'open' && (pr.review?.state === 'requested' || (isMine(pr, user) && pr.pipeline?.status === 'failed'))

export function ciText(pipeline: PullRequest['pipeline']): string {
  if (!pipeline) return 'No CI'
  return pipeline.status === 'running' ? `CI ${pipeline.done}/${pipeline.total}` : `CI ${pipeline.status}`
}
