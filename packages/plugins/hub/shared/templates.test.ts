import { expect, test } from 'bun:test'
import { fixWorkflow, shipSkillWorkflow, shipsWithSkill, ticketWorkflow } from './templates'
import { validate } from './validate'
import { type Workflow, isWorkflow } from './workflow'

test('a ticket workflow is valid as made, given its agent, and runs plan, build, test and review to a pull request with nobody in the loop', () => {
  for (const source of ['jira', 'notion'] as const) {
    const workflow = ticketWorkflow(source, 'agent', true)
    expect(isWorkflow(workflow)).toBe(true)
    expect(validate(workflow, ['agent'])).toEqual([])
    expect(workflow.edges.map((edge) => [edge.to, edge.branch])).toEqual([
      ['plan', null],
      ['asked', null],
      ['build', 'false'],
      ['built', null],
      ['test', 'false'],
      ['tested', null],
      ['review', 'false'],
      ['pr', null],
      ['output', null]
    ])
    // Failed tests and any review issue send the build back
    const sendsBack = workflow.nodes.flatMap((node) => (node.kind === 'judge' ? [[node.id, node.retryStep]] : []))
    expect(sendsBack).toEqual([['review', 'build']])
    expect(workflow.nodes.some((node) => node.kind === 'approval')).toBe(false)
  }
})

test('a fix workflow is valid as made, given its agent', () => {
  const workflow = fixWorkflow('agent')
  expect(isWorkflow(workflow)).toBe(true)
  expect(validate(workflow, ['agent'])).toEqual([])
})

test('a pull request fix goes back to /ship only for a ticket /ship shipped', () => {
  const fix = (workflow: Workflow) => fixWorkflow('agent', shipsWithSkill(workflow)).nodes.find((node) => node.kind === 'agent')
  expect(fix(shipSkillWorkflow('agent', false))).toMatchObject({ prompt: expect.stringMatching(/^\/ship \{\{input\.key\}\}/) })
  expect(fix(ticketWorkflow('jira', 'agent', false))).toMatchObject({ prompt: expect.stringMatching(/^You keep one pull request green/) })
})

test("a /ship workflow is valid as made and stops on the skill's question or blocker", () => {
  const workflow = shipSkillWorkflow('agent', true)
  expect(isWorkflow(workflow)).toBe(true)
  expect(validate(workflow, ['agent'])).toEqual([])
  expect(workflow.edges.map((edge) => [edge.to, edge.branch])).toEqual([
    ['pr', null],
    ['asked', null],
    ['blocked', 'false'],
    ['output', 'false']
  ])
})
