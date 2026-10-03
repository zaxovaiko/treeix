import { expect, test } from 'bun:test'
import { freshNode, type NodeRun, type Workflow } from '../shared/workflow'
import { holds, nextSteps } from './schedule'

// input → check → (true) yes, (false) no → after-no; yes and after-no → merge
const workflow: Workflow = {
  id: 'w',
  name: 'W',
  updatedAt: 0,
  layout: {},
  nodes: [
    { id: 'input', kind: 'input' },
    { id: 'check', kind: 'condition', source: '{{input}}', test: 'contains', value: 'go' },
    { id: 'yes', kind: 'output', template: '' },
    { id: 'no', kind: 'output', template: '' },
    { id: 'after-no', kind: 'output', template: '' },
    { id: 'merge', kind: 'merge', template: '' }
  ],
  edges: [
    { id: '1', from: 'input', to: 'check', branch: null },
    { id: '2', from: 'check', to: 'yes', branch: 'true' },
    { id: '3', from: 'check', to: 'no', branch: 'false' },
    { id: '4', from: 'no', to: 'after-no', branch: null },
    { id: '5', from: 'yes', to: 'merge', branch: null },
    { id: '6', from: 'after-no', to: 'merge', branch: null }
  ]
}

test('a condition runs one side, the skip carries down the other, and a merge takes what finished', () => {
  const nodes: Record<string, NodeRun> = Object.fromEntries(workflow.nodes.map((node) => [node.id, freshNode()]))
  const settle = (ids: string[], change: Partial<NodeRun>): void => ids.forEach((id) => (nodes[id] = { ...nodes[id], ...change }))

  expect(nextSteps(workflow, nodes)).toEqual({ ready: ['input'], skip: [] })
  settle(['input'], { status: 'done' })
  expect(nextSteps(workflow, nodes)).toEqual({ ready: ['check'], skip: [] })
  settle(['check'], { status: 'done', branch: 'true' })
  expect(nextSteps(workflow, nodes)).toEqual({ ready: ['yes'], skip: ['no'] })
  settle(['yes'], { status: 'running' })
  settle(['no'], { status: 'skipped' })
  expect(nextSteps(workflow, nodes)).toEqual({ ready: [], skip: ['after-no'] })
  settle(['after-no'], { status: 'skipped' })
  expect(nextSteps(workflow, nodes)).toEqual({ ready: [], skip: [] })
  settle(['yes'], { status: 'done' })
  expect(nextSteps(workflow, nodes)).toEqual({ ready: ['merge'], skip: [] })
})

test('conditions test the text', () => {
  const condition = (test: 'contains' | 'equals' | 'regex' | 'empty', value: string) => ({ id: 'c', kind: 'condition' as const, source: '', test, value })
  expect(holds(condition('contains', 'LGTM'), 'Verdict: LGTM')).toBe(true)
  expect(holds(condition('equals', 'yes'), ' yes\n')).toBe(true)
  expect(holds(condition('regex', '^\\d+ issues?$'), '3 issues')).toBe(true)
  expect(holds(condition('empty', ''), '  ')).toBe(true)
  expect(() => holds(condition('regex', '('), 'x')).toThrow()
})
