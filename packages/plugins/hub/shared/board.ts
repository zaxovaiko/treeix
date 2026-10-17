import type { Run } from './workflow'

export const DAY_MS = 24 * 60 * 60 * 1000

/** A GitHub or Bitbucket pull request, or a GitLab merge request */
export const PULL_REQUEST = /https?:\/\/\S+?\/(?:pull|pull-requests|-\/merge_requests)\/\d+/

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
