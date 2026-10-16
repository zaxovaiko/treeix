import { expect, test } from 'bun:test'
import { askWorkflow, type NodeRun, type Run } from '../shared/workflow'
import { type Attention, createAttention } from './attention'

const node = (waiting: NodeRun['waiting'] = null): NodeRun => ({
  status: 'running',
  attempt: 1,
  startedAt: 0,
  endedAt: null,
  prompt: null,
  output: null,
  branch: null,
  error: null,
  usage: null,
  waiting
})
const run = (status: Run['status'], nodes: Record<string, NodeRun>): Run => ({
  id: 'r1',
  kind: 'workflow',
  title: 'Ship',
  workflow: askWorkflow('a', null),
  input: '',
  status,
  startedAt: 0,
  endedAt: null,
  nodes,
  output: null
})

test('tells each wait and the end once, and when runs start and stop', () => {
  const told: string[] = []
  const busy: boolean[] = []
  const see = createAttention(
    (attention: Attention) => told.push(attention.kind === 'waiting' ? `waiting ${attention.node}` : `ended ${attention.run.status}`),
    (going) => busy.push(going)
  )
  see(run('running', { agent: node() }))
  see(run('running', { agent: node('permission') }))
  see(run('running', { agent: node('permission') }))
  see(run('running', { agent: node() }))
  see(run('running', { agent: node('permission') }))
  see(run('failed', { agent: node() }))
  see(run('failed', { agent: node() }))
  expect(told).toEqual(['waiting agent', 'waiting agent', 'ended failed'])
  expect(busy).toEqual([true, false])
})
