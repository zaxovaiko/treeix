import { expect, test } from 'bun:test'
import { addTestsWorkflow, shipWorkflow } from './templates'
import { validate } from './validate'
import { isWorkflow } from './workflow'

test('a ship workflow is valid as made, given its agent', () => {
  for (const source of ['jira', 'notion'] as const) {
    const workflow = shipWorkflow(source, 'agent')
    expect(isWorkflow(workflow)).toBe(true)
    expect(validate(workflow, ['agent'])).toEqual([])
  }
})

test('an add tests workflow is valid as made, given its agent', () => {
  const workflow = addTestsWorkflow('agent')
  expect(isWorkflow(workflow)).toBe(true)
  expect(validate(workflow, ['agent'])).toEqual([])
})
