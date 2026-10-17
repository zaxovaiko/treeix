import { isJson, isString, list, object, text } from '@treeix/shared/json'
import { fixWorkflow } from '../shared/templates'
import { type TicketCard, type TicketState, freshTicketState, isTicketState, ticketCards } from '../shared/tickets'
import type { AgentNode, Run, Ticket, Workflow } from '../shared/workflow'
import { jsonList } from './store'

/** CI fixes in a row before the ticket waits for a person */
export const MAX_CI_FIXES = 3
/** Right after a fix pushes, the old red CI still shows for a while */
export const SETTLE_MS = 5 * 60_000
/** Replies the fix agent leaves on the pull request start with this, so they never start another fix */
export const AGENT_REPLY = 'Agent:'

export type PullStatus = { state: 'open' | 'merged' | 'closed'; sourceBranch: string; pipeline: { status: 'passed' | 'failed' | 'running' } | null }
export type PullComment = { id: string; author: string; body: string; path: string | null; line: number | null }
export type PullAction = 'done' | 'ci' | 'review' | 'needsYou' | null

const isPullStatus = (value: unknown): value is PullStatus =>
  isJson(value) && (value.state === 'open' || value.state === 'merged' || value.state === 'closed') && isString(value.sourceBranch)
const isPullComment = (value: unknown): value is PullComment => isJson(value) && isString(value.id) && isString(value.body)

const logged = (state: TicketState, now: number, line: string): TicketState => ({ ...state, log: [...state.log, { at: now, text: line }] })

/**
 * What to do about a ticket's pull request, given what it looks like now: finish it when merged, fix failing CI (after the
 * last push settled, three times at most), or fix new review comments. Never called while a run on the ticket goes
 */
export function nextAction(
  previous: TicketState,
  status: PullStatus,
  comments: PullComment[],
  settledAt: number,
  now: number
): { state: TicketState; action: PullAction; comments: PullComment[] } {
  const idle = (state: TicketState, action: PullAction = null): { state: TicketState; action: PullAction; comments: PullComment[] } => ({ state, action, comments: [] })
  if (status.state === 'merged') return idle(logged({ ...previous, mergedAt: now, needsYou: null }, now, 'Pull request merged'), 'done')
  if (status.state === 'closed') {
    const needsYou = 'The pull request was closed without merging'
    return previous.needsYou === needsYou ? idle(previous) : idle(logged({ ...previous, needsYou }, now, needsYou), 'needsYou')
  }
  const ci = status.pipeline?.status ?? null
  // ponytail: a fixed wait stands in for knowing which commit the status is for; compare head SHAs if CI gets slower than it
  if (ci === 'failed' && now < settledAt) return idle(previous)
  let state = previous.ci === ci ? previous : logged({ ...previous, ci }, now, `CI ${ci ?? 'gone'}`)
  if (ci === 'passed' && (state.ciFixes || state.needsYou)) state = { ...state, ciFixes: 0, needsYou: null }
  if (ci === 'failed') {
    if (state.ciFixes < MAX_CI_FIXES) return idle(logged({ ...state, ciFixes: state.ciFixes + 1 }, now, `CI fix ${state.ciFixes + 1} of ${MAX_CI_FIXES} started`), 'ci')
    const needsYou = `CI still fails after ${MAX_CI_FIXES} fixes`
    if (state.needsYou !== needsYou) return idle(logged({ ...state, needsYou }, now, needsYou), 'needsYou')
  }
  const seen = new Set(state.seenComments)
  const fresh = comments.filter((comment) => !seen.has(comment.id) && !comment.body.trimStart().startsWith(AGENT_REPLY))
  if (!fresh.length) return idle(state)
  const reviewed = logged(
    { ...state, seenComments: [...seen, ...comments.map((comment) => comment.id)] },
    now,
    `Review fix started for ${fresh.length} comment${fresh.length === 1 ? '' : 's'}`
  )
  return { state: reviewed, action: 'review', comments: fresh }
}

/** The worktree the implement step reported; it has the repository's remote, where the agent's own folder may hold many */
const worktreeOf = (runs: Run[]): string | null => runs.map((run) => run.nodes.implement?.output?.match(/^Worktree: (.+)$/m)?.[1].trim()).find(Boolean) ?? null

const failedLogs = (reply: string): string =>
  list(JSON.parse(reply))
    .map((job) => `## ${text(job.name)}\n\n${text(job.log)}`)
    .join('\n\n')

const reviewNotes = (comments: PullComment[]): string =>
  comments.map((comment) => `- ${comment.id} by ${comment.author}${comment.path ? ` on ${comment.path}:${comment.line ?? ''}` : ''}: ${comment.body}`).join('\n')

/**
 * Follows every ticket with an open pull request: keeps its CI green and its review comments answered with fix runs on the
 * same ticket, and moves the ticket to Done once merged. Everything it does lands in the ticket's log; a failure says so once
 */
export function createPullRequests(deps: {
  file: string
  runs: () => Promise<Run[]>
  callTool: (name: string, args: Record<string, unknown>) => Promise<string>
  /** The flow's own folder, for when no worktree was reported */
  folder: (run: Run) => Promise<string | null>
  launch: (title: string, workflow: Workflow, input: string, ticket: Ticket) => void
  notify: (card: TicketCard, title: string, body: string) => void
  changed: (states: TicketState[]) => void
}): { check: () => Promise<void>; list: () => Promise<TicketState[]> } {
  const states = jsonList(deps.file, isTicketState)
  let checking = false

  const follow = async (card: TicketCard & { pullRequest: string }, previous: TicketState, now: number): Promise<TicketState> => {
    const flow = card.runs.find((run) => run.workflow.nodes.some((node) => node.id === 'pr')) ?? card.runs.at(-1)
    const repoPath = worktreeOf(card.runs) ?? (flow && (await deps.folder(flow)))
    if (!flow || !repoPath) throw new Error('No folder to find its repository in')
    const args = { url: card.pullRequest, repoPath }
    const status = object(JSON.parse(await deps.callTool('pr_status', args)))
    if (!isPullStatus(status)) throw new Error('pr_status answered without a state')
    const comments = status.state === 'open' ? list(JSON.parse(await deps.callTool('pr_comments', args))).filter(isPullComment) : []
    const settledAt = (card.runs[0].endedAt ?? 0) + SETTLE_MS
    const { state, action, comments: fresh } = nextAction(previous, status, comments, settledAt, now)
    if (action === 'done') {
      if (card.source === 'jira') await deps.callTool('jira_transition', { key: card.key, status: 'Done' })
      else await deps.callTool('notion_update_page', { page: card.key, properties: { Status: 'Done' } })
      deps.notify(card, `${card.key} is done`, card.title)
      return logged(state, now, 'Ticket moved to Done')
    }
    if (action === 'needsYou') deps.notify(card, `${card.key} needs you`, state.needsYou ?? '')
    if (action === 'ci' || action === 'review') {
      const agent = flow.workflow.nodes.find((node): node is AgentNode => node.kind === 'agent')?.agent
      if (!agent) throw new Error('Its workflow has no agent to fix it')
      const details = action === 'ci' ? `CI failed. The failed jobs:\n\n${failedLogs(await deps.callTool('pr_failed_logs', args))}` : `Review comments:\n\n${reviewNotes(fresh)}`
      const input = { key: card.key, url: card.pullRequest, repo: repoPath, sourceBranch: status.sourceBranch, details }
      deps.launch(`${action === 'ci' ? 'Fix CI' : 'Fix review'}: ${card.key} ${card.title}`, fixWorkflow(agent), JSON.stringify(input), { key: card.key, url: card.url })
    }
    return state
  }

  return {
    list: states.get,
    check: async () => {
      // A slow check is skipped on the next tick, never stacked
      if (checking) return
      checking = true
      try {
        const stored = await states.get()
        const byKey = new Map(stored.map((state) => [state.key, state]))
        const now = Date.now()
        for (const card of ticketCards(await deps.runs(), stored)) {
          // One run on a ticket at a time; a merged one is finished
          if (!card.pullRequest || card.state?.mergedAt || card.runs[0].status === 'running') continue
          const previous = card.state ?? freshTicketState(card.key)
          try {
            const next = await follow({ ...card, pullRequest: card.pullRequest }, previous, now)
            byKey.set(card.key, next.error ? logged({ ...next, error: null }, now, 'Checks work again') : next)
          } catch (reason) {
            const message = reason instanceof Error ? reason.message : String(reason)
            if (previous.error === message) continue
            deps.notify(card, `Treeix can't follow ${card.key}'s pull request`, message)
            byKey.set(card.key, logged({ ...previous, error: message }, now, `Error: ${message}`))
          }
        }
        const next = [...byKey.values()]
        if (JSON.stringify(next) === JSON.stringify(stored)) return
        await states.set(next)
        deps.changed(next)
      } finally {
        checking = false
      }
    }
  }
}
