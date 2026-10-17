import { expect, test } from 'bun:test'
import { addTestsWorkflow, shipWorkflow } from './templates'
import { validate } from './validate'
import { isWorkflow } from './workflow'

test('a ship workflow is valid as made, given its agent', () => {
  for (const source of ['jira', 'notion'] as const) {
    const workflow = shipWorkflow(source, 'agent')
    expect(isWorkflow(workflow)).toBe(true)
    expect(validate(workflow, ['agent'])).toEqual([])
    // Its plan waits on approval, and changes asked for send the plan back
    expect(workflow.edges.map((edge) => edge.to)).toEqual(['plan', 'approve', 'agent', 'review', 'output'])
    expect(workflow.nodes.find((node) => node.id === 'approve')).toMatchObject({ kind: 'approval', retryStep: 'plan' })
  }
})

test('an add tests workflow is valid as made, given its agent', () => {
  const workflow = addTestsWorkflow('agent')
  expect(isWorkflow(workflow)).toBe(true)
  expect(validate(workflow, ['agent'])).toEqual([])
})
