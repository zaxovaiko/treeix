import { expect, test } from 'bun:test'
import { fixWorkflow, ticketWorkflow } from './templates'
import { validate } from './validate'
import { isWorkflow } from './workflow'

test('a ticket workflow is valid as made, given its agent, and runs to a pull request with nobody in the loop', () => {
  for (const source of ['jira', 'notion'] as const) {
    const workflow = ticketWorkflow(source, 'agent', true)
    expect(isWorkflow(workflow)).toBe(true)
    expect(validate(workflow, ['agent'])).toEqual([])
    expect(workflow.edges.map((edge) => [edge.to, edge.branch])).toEqual([
      ['plan', null],
      ['asked', null],
      ['implement', 'false'],
      ['built', null],
      ['qa', 'false'],
      ['verified', null],
      ['pr', 'false'],
      ['output', null]
    ])
    expect(workflow.nodes.some((node) => node.kind === 'approval' || node.kind === 'judge')).toBe(false)
  }
})

test('a fix workflow is valid as made, given its agent', () => {
  const workflow = fixWorkflow('agent')
  expect(isWorkflow(workflow)).toBe(true)
  expect(validate(workflow, ['agent'])).toEqual([])
})
