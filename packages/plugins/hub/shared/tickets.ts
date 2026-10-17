import { isJson, isString, object, parseJson, text } from '@treeix/shared/json'
import { PULL_REQUEST, runSummary } from './board'
import { type Run, type TicketSource, ticketOf } from './workflow'

/** Where a ticket is, on the Mac and on the phone; there is no To do, the watches pick tickets up */
export const TICKET_COLUMNS = [
  { id: 'progress', label: 'In progress' },
  { id: 'qa', label: 'QA' },
  { id: 'pullRequest', label: 'Pull request' },
  { id: 'done', label: 'Done' }
] as const
export type TicketColumn = (typeof TICKET_COLUMNS)[number]['id']

/** What a ticket is up to, worst first */
export const TICKET_BADGES = [
  { id: 'needsYou', label: 'Needs you' },
  { id: 'error', label: 'Error' },
  { id: 'ciFailing', label: 'CI failing' },
  { id: 'working', label: 'Working' },
  { id: 'review', label: 'In review' },
  { id: 'merged', label: 'Merged' }
] as const
export type TicketBadge = (typeof TICKET_BADGES)[number]['id']

/** The ticket flow's steps by the column they put the ticket in; any other step counts as In progress */
const STAGE_COLUMN: Record<string, TicketColumn> = { plan: 'progress', implement: 'progress', qa: 'qa', pr: 'pullRequest' }

export type TicketLogEntry = { at: number; text: string }

/** What the pull request watcher knows of a ticket past its pull request, and everything it did, for the audit trail */
export type TicketState = {
  key: string
  mergedAt: number | null
  ci: 'passed' | 'failed' | 'running' | null
  /** CI fixes in a row that didn't turn it green */
  ciFixes: number
  /** Pull request comments already handed to an agent, or written before it watched */
  seenComments: string[]
  /** No CI fix before this: right after a push the old red status still shows */
  settleUntil: number
  needsYou: string | null
  error: string | null
  log: TicketLogEntry[]
}

export const freshTicketState = (key: string): TicketState => ({
  key,
  mergedAt: null,
  ci: null,
  ciFixes: 0,
  seenComments: [],
  settleUntil: 0,
  needsYou: null,
  error: null,
  log: []
})

const isLogEntry = (value: unknown): value is TicketLogEntry => isJson(value) && typeof value.at === 'number' && isString(value.text)
const orNull = (value: unknown): value is string | null => value === null || isString(value)

export const isTicketState = (value: unknown): value is TicketState =>
  isJson(value) &&
  isString(value.key) &&
  (value.mergedAt === null || typeof value.mergedAt === 'number') &&
  (value.ci === null || value.ci === 'passed' || value.ci === 'failed' || value.ci === 'running') &&
  typeof value.ciFixes === 'number' &&
  Array.isArray(value.seenComments) &&
  value.seenComments.every(isString) &&
  typeof value.settleUntil === 'number' &&
  orNull(value.needsYou) &&
  orNull(value.error) &&
  Array.isArray(value.log) &&
  value.log.every(isLogEntry)

export type TicketCard = {
  key: string
  source: TicketSource
  url: string | null
  title: string
  /** The Jira project key, or Notion */
  project: string
  /** Every run on the ticket, newest first: the flow itself, then the fixes on its pull request */
  runs: Run[]
  state: TicketState | null
  pullRequest: string | null
  column: TicketColumn
  badge: TicketBadge
  /** Why it is where it is, in a line */
  summary: string
  /** Over every step of every run */
  tokens: number
  /** Null when no step reported a price */
  cost: number | null
  /** The last thing that happened */
  at: number
}

/** The pull request the ticket's `pr` step opened; older runs said it in their output */
export function pullRequestOf(runs: Run[]): string | null {
  for (const run of runs) {
    const found = (run.nodes.pr?.output ?? run.output)?.match(PULL_REQUEST)?.[0]
    if (found) return found
  }
  return null
}

/** The step a run is on: the running one, else the one that failed, else the last that started */
function currentStep(run: Run): string | null {
  const nodes = Object.entries(run.nodes)
  const pick = (status: string): string | undefined => nodes.find(([, node]) => node.status === status)?.[0]
  return pick('running') ?? pick('failed') ?? nodes.filter(([, node]) => node.startedAt !== null).sort(([, a], [, b]) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0]?.[0] ?? null
}

/** The watch put the item's own title in the first run's input */
const titleOf = (runs: Run[]): string => {
  const first = runs.at(-1)
  return text(object(parseJson(first?.input ?? null)).title) || first?.title || ''
}

function badgeOf(runs: Run[], state: TicketState | null, pullRequest: string | null): TicketBadge {
  const latest = runs[0]
  if (state?.mergedAt) return 'merged'
  if (state?.needsYou || Object.values(latest.nodes).some((node) => node.waiting)) return 'needsYou'
  if (latest.status === 'running') return 'working'
  if (latest.status !== 'done' || !pullRequest) return 'needsYou'
  if (state?.error) return 'error'
  return state?.ci === 'failed' ? 'ciFailing' : 'review'
}

function summaryOf(card: Pick<TicketCard, 'runs' | 'state' | 'badge' | 'pullRequest'>): string {
  const latest = card.runs[0]
  if (card.badge === 'merged') return 'Merged'
  if (card.state?.needsYou) return card.state.needsYou
  if (card.badge === 'needsYou' && latest.status === 'done') return 'Finished without opening a pull request'
  if (card.badge === 'error' && card.state?.error) return card.state.error
  if (card.badge === 'ciFailing') return 'CI fails, a fix comes next'
  if (card.badge === 'review') return card.state?.ci === 'running' ? 'CI is running' : 'Waiting for review'
  return runSummary(latest)
}

/** One card per ticket, over every run that names it */
export function ticketCards(runs: Run[], states: TicketState[]): TicketCard[] {
  const byKey = new Map<string, { source: TicketSource; runs: Run[] }>()
  for (const run of runs) {
    const ticket = run.kind === 'eval' ? null : ticketOf(run)
    if (!ticket) continue
    const entry = byKey.get(ticket.key) ?? { source: ticket.source, runs: [] }
    entry.runs.push(run)
    byKey.set(ticket.key, entry)
  }
  const stateOf = new Map(states.map((state) => [state.key, state]))
  return [...byKey].map(([key, { source, runs: own }]): TicketCard => {
    const sorted = own.sort((a, b) => b.startedAt - a.startedAt)
    const state = stateOf.get(key) ?? null
    const pullRequest = pullRequestOf(sorted)
    // The flow's own run, not a fix on its pull request, says which step it is on
    const flow = sorted.find((run) => run.workflow.nodes.some((node) => node.id in STAGE_COLUMN))
    const step = flow ? currentStep(flow) : null
    const column: TicketColumn = state?.mergedAt ? 'done' : pullRequest ? 'pullRequest' : ((step ? STAGE_COLUMN[step] : null) ?? 'progress')
    const badge = badgeOf(sorted, state, pullRequest)
    const nodes = sorted.flatMap((run) => Object.values(run.nodes))
    const costs = nodes.flatMap((node) => (node.usage?.cost == null ? [] : [node.usage.cost]))
    return {
      key,
      source,
      url: sorted.find((run) => run.ticket?.url)?.ticket?.url ?? null,
      title: titleOf(sorted),
      project: source === 'jira' ? key.split('-')[0] : 'Notion',
      runs: sorted,
      state,
      pullRequest,
      column,
      badge,
      summary: summaryOf({ runs: sorted, state, badge, pullRequest }),
      tokens: nodes.reduce((total, node) => total + (node.usage?.used ?? 0), 0),
      cost: costs.length ? costs.reduce((total, cost) => total + cost, 0) : null,
      at: Math.max(state?.mergedAt ?? 0, ...sorted.map((run) => run.endedAt ?? run.startedAt))
    }
  })
}

export type TicketFilter = { project: string; badge: TicketBadge | 'all'; sort: 'date' | 'tokens' }

export const ALL_TICKETS: TicketFilter = { project: 'all', badge: 'all', sort: 'date' }

export const filterCards = (cards: TicketCard[], filter: TicketFilter): TicketCard[] =>
  cards
    .filter((card) => (filter.project === 'all' || card.project === filter.project) && (filter.badge === 'all' || card.badge === filter.badge))
    .sort((a, b) => (filter.sort === 'tokens' ? b.tokens - a.tokens : 0) || b.at - a.at)
