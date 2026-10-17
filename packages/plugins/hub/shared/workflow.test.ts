import { expect, test } from 'bun:test'
import { activeAgents, askWorkflow, freshNode, isWorkflow, type NodeStatus, type Run, type RunStatus } from './workflow'

const run = (agent: string, status: RunStatus, node: NodeStatus): Run => ({
  id: `${agent}-${status}-${node}`,
  kind: 'ask',
  title: agent,
  workflow: askWorkflow(agent, null),
  input: '',
  status,
  startedAt: 0,
  endedAt: null,
  nodes: { agent: { ...freshNode(), status: node } },
  output: null
})

test('active agents are those a running step asks, each once', () => {
  const runs = [
    run('news', 'running', 'running'),
    run('news', 'running', 'running'),
    run('scout', 'running', 'running'),
    run('idle', 'running', 'pending'),
    run('old', 'done', 'done')
  ]
  expect([...activeAgents(runs)].sort()).toEqual(['news', 'scout'])
})

test('an input watches Jira or Notion, nothing else', () => {
  const watching = (watch: unknown): unknown => ({
    ...askWorkflow('a', null),
    nodes: [{ id: 'input', kind: 'input', watches: [watch] }]
  })
  expect(isWorkflow(watching({ id: 'w', source: 'jira', query: 'labels = x', enabled: true }))).toBe(true)
  expect(
    isWorkflow(
      watching({
        id: 'w',
        source: 'notion',
        query: 'Agent = ready',
        dataSource: 'ds',
        enabled: false
      })
    )
  ).toBe(true)
  expect(isWorkflow(watching({ id: 'w', source: 'github', query: '', enabled: true }))).toBe(false)
  expect(isWorkflow(watching({ id: 'w', source: 'jira', query: 'x' }))).toBe(false)
})
