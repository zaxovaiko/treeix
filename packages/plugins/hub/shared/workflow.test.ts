import { expect, test } from 'bun:test'
import { activeAgents, askWorkflow, freshNode, type NodeStatus, type Run, type RunStatus } from './workflow'

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
  const runs = [run('news', 'running', 'running'), run('news', 'running', 'running'), run('scout', 'running', 'running'), run('idle', 'running', 'pending'), run('old', 'done', 'done')]
  expect([...activeAgents(runs)].sort()).toEqual(['news', 'scout'])
})
