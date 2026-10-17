import { expect, test } from 'bun:test'
import { ALL_TICKETS, filterCards, freshTicketState, isTicketState, ticketCards } from './tickets'
import { askWorkflow, freshNode, type NodeRun, type Run, type Workflow } from './workflow'

const FLOW: Workflow = {
  ...askWorkflow('a', null),
  nodes: ['input', 'plan', 'implement', 'qa', 'pr', 'output'].map((id) => ({ id, kind: 'output', template: '' }))
}

const flowRun = (key: string, nodes: Record<string, Partial<NodeRun>>, extra: Partial<Run> = {}): Run => ({
  id: `${key}-${extra.startedAt ?? 1}`,
  kind: 'workflow',
  title: `Ship: ${key} Fix login`,
  workflow: FLOW,
  input: JSON.stringify({ key, title: 'Fix login', source: 'jira', url: `https://x.atlassian.net/browse/${key}` }),
  status: 'running',
  startedAt: 1,
  endedAt: null,
  nodes: Object.fromEntries(Object.entries(nodes).map(([id, node]) => [id, { ...freshNode(), ...node }])),
  output: null,
  ticket: { key, url: `https://x.atlassian.net/browse/${key}` },
  ...extra
})

const PR = 'https://github.com/o/r/pull/7'

test('the step a ticket is on puts it in its column', () => {
  const [planning] = ticketCards([flowRun('BF-1', { plan: { status: 'running', startedAt: 1 } })], [])
  expect([planning.column, planning.badge, planning.title, planning.project]).toEqual(['progress', 'working', 'Fix login', 'BF'])
  const [testing] = ticketCards([flowRun('BF-1', { plan: { status: 'done', startedAt: 1 }, qa: { status: 'running', startedAt: 2 } })], [])
  expect(testing.column).toBe('qa')
})

test('a pull request moves it on, a merge finishes it', () => {
  const opened = flowRun('BF-1', { pr: { status: 'done', startedAt: 3, output: `Opened.\nPR: ${PR}` } }, { status: 'done', endedAt: 4 })
  const [card] = ticketCards([opened], [])
  expect([card.column, card.badge, card.pullRequest]).toEqual(['pullRequest', 'review', PR])
  const [merged] = ticketCards([opened], [{ ...freshTicketState('BF-1'), mergedAt: 9 }])
  expect([merged.column, merged.badge, merged.at]).toEqual(['done', 'merged', 9])
})

test('fix runs join their ticket, tokens add up over every run', () => {
  const flow = flowRun('BF-1', { plan: { status: 'done', usage: { used: 100, cost: 1 } }, pr: { status: 'done', output: PR, usage: { used: 50, cost: null } } }, { status: 'done' })
  const fix: Run = { ...flowRun('BF-1', { fix: { status: 'running', usage: { used: 25, cost: 0.5 } } }, { startedAt: 5 }), workflow: askWorkflow('a', null) }
  const [card] = ticketCards([flow, fix], [])
  expect([card.runs.length, card.tokens, card.cost, card.column, card.badge]).toEqual([2, 175, 1.5, 'pullRequest', 'working'])
})

test('a failed or stuck ticket needs you, and says why', () => {
  const [failed] = ticketCards([flowRun('BF-1', { plan: { status: 'failed', error: 'The ticket is unclear' } }, { status: 'failed' })], [])
  expect([failed.badge, failed.summary]).toEqual(['needsYou', 'The ticket is unclear'])
  const [noPullRequest] = ticketCards([flowRun('BF-1', { pr: { status: 'done', output: 'Pushed' } }, { status: 'done' })], [])
  expect(noPullRequest.badge).toBe('needsYou')
  const opened = flowRun('BF-1', { pr: { status: 'done', output: PR } }, { status: 'done' })
  const [capped] = ticketCards([opened], [{ ...freshTicketState('BF-1'), ci: 'failed', needsYou: 'CI still fails after 3 fixes' }])
  expect([capped.badge, capped.summary]).toEqual(['needsYou', 'CI still fails after 3 fixes'])
  const [red] = ticketCards([opened], [{ ...freshTicketState('BF-1'), ci: 'failed' }])
  expect(red.badge).toBe('ciFailing')
})

test('runs without a ticket and eval runs stay off the board', () => {
  const ask: Run = { ...flowRun('BF-1', {}), ticket: null, title: 'Hello' }
  const evaluated: Run = { ...flowRun('BF-2', {}), kind: 'eval' }
  expect(ticketCards([ask, evaluated], [])).toEqual([])
})

test('filters by project and badge, sorts by date or tokens', () => {
  const cards = ticketCards(
    [
      flowRun('BF-1', { plan: { status: 'running', usage: { used: 10, cost: null } } }, { startedAt: 3 }),
      flowRun('APP-2', { plan: { status: 'running', usage: { used: 99, cost: null } } }, { startedAt: 2 })
    ],
    []
  )
  expect(filterCards(cards, ALL_TICKETS).map((card) => card.key)).toEqual(['BF-1', 'APP-2'])
  expect(filterCards(cards, { ...ALL_TICKETS, sort: 'tokens' }).map((card) => card.key)).toEqual(['APP-2', 'BF-1'])
  expect(filterCards(cards, { ...ALL_TICKETS, project: 'APP' }).map((card) => card.key)).toEqual(['APP-2'])
  expect(filterCards(cards, { ...ALL_TICKETS, badge: 'merged' })).toEqual([])
})

test('a saved ticket state round-trips, a damaged one is dropped', () => {
  expect(isTicketState(JSON.parse(JSON.stringify(freshTicketState('BF-1'))))).toBe(true)
  expect(isTicketState({ ...freshTicketState('BF-1'), log: [{ at: 'x' }] })).toBe(false)
})
