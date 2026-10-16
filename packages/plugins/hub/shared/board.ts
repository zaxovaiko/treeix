import { isWaiting, type Run } from './workflow'

/** The board's columns, on the Mac and on the phone */
export const BOARD_COLUMNS = [
  { id: 'needs', label: 'Needs you' },
  { id: 'running', label: 'Running' },
  { id: 'done', label: 'Done' }
] as const
export type BoardColumn = (typeof BOARD_COLUMNS)[number]['id']

export const DAY_MS = 24 * 60 * 60 * 1000

export function boardColumn(run: Run, now = Date.now()): BoardColumn | null {
  if (isWaiting(run) || run.status === 'failed' || run.status === 'interrupted') return 'needs'
  if (run.status === 'running') return 'running'
  // Old runs stay in the history, not on the board
  return run.status === 'done' && now - (run.endedAt ?? run.startedAt) < DAY_MS ? 'done' : null
}

/** A GitHub or Bitbucket pull request, or a GitLab merge request */
const PULL_REQUEST = /https?:\/\/\S+?\/(?:pull|pull-requests|-\/merge_requests)\/\d+/

/** The ticket a run is for and the PR or MR it opened */
export function runLinks(run: Run): { label: string; url: string }[] {
  const pullRequest = run.output?.match(PULL_REQUEST)?.[0]
  return [
    ...(run.ticket?.url ? [{ label: 'Open ticket', url: run.ticket.url }] : []),
    ...(pullRequest ? [{ label: pullRequest.includes('merge_requests') ? 'Open MR' : 'Open PR', url: pullRequest }] : [])
  ]
}

const firstLine = (text: string | null | undefined): string => text?.trim().split('\n')[0] ?? ''

/** What the run is on, or how it ended, in a line */
export function runSummary(run: Run): string {
  const nodes = Object.values(run.nodes)
  const waiting = nodes.find((node) => node.waiting)
  if (waiting) return waiting.waiting === 'approval' ? firstLine(waiting.prompt) || 'Waiting for approval' : 'Asks for permission'
  const failed = nodes.find((node) => node.error)
  if (run.status === 'failed' && failed) return firstLine(failed.error)
  if (run.status === 'interrupted') return 'The app quit while it ran'
  return firstLine(run.output) || firstLine(run.input)
}
