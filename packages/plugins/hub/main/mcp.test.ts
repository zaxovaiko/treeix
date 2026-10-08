import { expect, test } from 'bun:test'
import type { HubAgent } from '../shared/types'
import { isWorkflow } from '../shared/workflow'
import { toAgent, toWorkflow } from './mcp'

const news = toAgent({ name: 'News', instructions: 'Summarize the news', schedules: [{ cron: '0 8 * * *', prompt: 'Yesterday' }] }, [], 1)

test('a new agent gets the editor defaults', () => {
  expect(news).toMatchObject({ name: 'News', icon: 'N', runtime: { kind: 'agent', agent: 'claude' }, model: null, folder: null, autoApprove: false, updatedAt: 1 })
  expect(news.schedules).toMatchObject([{ cron: '0 8 * * *', prompt: 'Yesterday', notify: true, enabled: true }])
})

test('an edit by name changes only the fields passed', () => {
  const edited = toAgent({ name: 'news', model: 'opus', runtime: 'http://localhost:11434/v1' }, [news], 2)
  expect(edited).toMatchObject({ id: news.id, instructions: 'Summarize the news', model: 'opus', runtime: { kind: 'api', baseUrl: 'http://localhost:11434/v1' } })
  expect(edited.schedules).toEqual(news.schedules)
  expect(toAgent({ name: 'News', model: null }, [edited], 3).model).toBeNull()
})

test('bad agents are refused', () => {
  const other: HubAgent = { ...news, id: 'other', name: 'Other' }
  expect(() => toAgent({ name: 'News', rename: 'other' }, [news, other], 2)).toThrow('taken')
  expect(() => toAgent({ name: 'X', schedules: [{ cron: 'daily', prompt: 'p' }] }, [], 1)).toThrow('crontab')
  expect(() => toAgent({ name: ' ' }, [], 1)).toThrow('name is required')
})

const steps = {
  nodes: [
    { id: 'in', kind: 'input' },
    { id: 'ask', kind: 'agent', agent: 'News', prompt: '{{input}}' },
    { id: 'out', kind: 'output' }
  ],
  edges: [
    { from: 'in', to: 'ask' },
    { from: 'ask', to: 'out' }
  ]
}

test('a workflow resolves agents by name and fills step defaults', () => {
  const workflow = toWorkflow({ name: 'Digest', ...steps }, [], [news], 1)
  expect(workflow.nodes[1]).toEqual({ id: 'ask', kind: 'agent', agent: news.id, prompt: '{{input}}', folder: null, retries: 0, onError: 'stop', timeoutMin: 10 })
  expect(workflow.nodes[2]).toEqual({ id: 'out', kind: 'output', template: '{{prev}}' })
  expect(workflow.edges[0]).toEqual({ id: 'in-ask', from: 'in', to: 'ask', branch: null })
  const replaced = toWorkflow({ name: 'digest', ...steps }, [{ ...workflow, layout: { in: { x: 1, y: 2 }, gone: { x: 0, y: 0 } } }], [news], 2)
  expect(replaced.id).toBe(workflow.id)
  expect(replaced.layout).toEqual({ in: { x: 1, y: 2 } })
})

test('a workflow that cannot run is refused with what to fix', () => {
  expect(() => toWorkflow({ name: 'W', ...steps }, [], [], 1)).toThrow('No agent named News')
  expect(() => toWorkflow({ name: 'W', ...steps, edges: [{ from: 'in', to: 'nope' }] }, [], [news], 1)).toThrow('nope, which is not a step')
  expect(() => toWorkflow({ name: 'W', ...steps, edges: [{ from: 'in', to: 'ask' }] }, [], [news], 1)).toThrow('out: Connect a step to it')
})

test('a schedule keeps its command and timeout, a bad timeout is refused', () => {
  const poll = toAgent({ name: 'Poll', schedules: [{ cron: '*/2 * * * *', prompt: 'Do {{input}}', command: ' node poll.mjs ', timeoutMin: 180 }] }, [], 1)
  expect(poll.schedules).toMatchObject([{ command: 'node poll.mjs', timeoutMin: 180 }])
  expect(() => toAgent({ name: 'P', schedules: [{ cron: '* * * * *', prompt: 'p', timeoutMin: 0 }] }, [], 1)).toThrow('timeoutMin')
})

test('an input step keeps its schedules, and a bad one is refused', () => {
  const nodes = [{ id: 'in', kind: 'input', schedules: [{ cron: '*/2 * * * *', prompt: '{{input}}', command: ' node poll.mjs ' }] }, ...steps.nodes.slice(1)]
  const workflow = toWorkflow({ name: 'Tickets', nodes, edges: steps.edges }, [], [news], 1)
  expect(workflow.nodes[0]).toMatchObject({ kind: 'input', schedules: [{ cron: '*/2 * * * *', prompt: '{{input}}', command: 'node poll.mjs', notify: true, enabled: true }] })
  expect(isWorkflow(workflow)).toBe(true)
  expect(isWorkflow({ ...workflow, nodes: [{ id: 'in', kind: 'input', schedules: [{ cron: 'daily' }] }] })).toBe(false)
  expect(() =>
    toWorkflow({ name: 'Bad', nodes: [{ id: 'in', kind: 'input', schedules: [{ cron: 'daily', prompt: 'p' }] }, ...steps.nodes.slice(1)], edges: steps.edges }, [], [news], 1)
  ).toThrow('crontab')
})
