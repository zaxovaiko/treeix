import { expect, test } from 'bun:test'
import { validate } from './validate'
import type { Workflow } from './workflow'

const agent = (id: string, prompt: string) => ({ id, kind: 'agent' as const, agent: 'scout', prompt, folder: null, retries: 0, onError: 'stop' as const, timeoutMin: 1 })

const workflow: Workflow = {
  id: 'w',
  name: 'W',
  updatedAt: 0,
  layout: {},
  nodes: [
    { id: 'input', kind: 'input' },
    agent('a', '{{input}}'),
    agent('b', 'Check {{nodes.a.output}}'),
    { id: 'output', kind: 'output', template: '{{nodes.a.output}} {{prev}}' }
  ],
  edges: [
    { id: '1', from: 'input', to: 'a', branch: null },
    { id: '2', from: 'a', to: 'b', branch: null },
    { id: '3', from: 'b', to: 'output', branch: null }
  ]
}

test('a chain of known agents reading earlier outputs is fine', () => {
  expect(validate(workflow, ['scout'])).toEqual([])
})

test('names loops, loose steps, gone agents, later references and the missing output', () => {
  const broken: Workflow = {
    ...workflow,
    nodes: [...workflow.nodes.filter((node) => node.kind !== 'output'), agent('loose', 'Read {{nodes.b.output}}'), { id: 'if', kind: 'condition', source: '{{prev}}', test: 'regex', value: '(' }],
    edges: [...workflow.edges, { id: '4', from: 'b', to: 'a', branch: null }, { id: '5', from: 'input', to: 'if', branch: null }]
  }
  expect(validate(broken, [])).toEqual([
    { node: null, message: 'Add an output step' },
    { node: 'a', message: 'Loops back to itself' },
    { node: 'a', message: 'Pick an agent' },
    { node: 'b', message: 'Loops back to itself' },
    { node: 'b', message: 'Pick an agent' },
    { node: 'loose', message: 'Connect a step to it' },
    { node: 'loose', message: 'Pick an agent' },
    { node: 'loose', message: '{{nodes.b.output}} is not a step before this one' },
    { node: 'if', message: 'Connect its yes or no side' },
    { node: 'if', message: 'The pattern is not a valid regular expression' }
  ])
})
