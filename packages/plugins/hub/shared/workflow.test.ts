import { expect, test } from 'bun:test'
import { activeAgents, askWorkflow, projectFor, folderNamed, ticketBranch, freshNode, isWorkflow, type NodeStatus, type Run, type RunStatus, withSubagents } from './workflow'
import { ticketWorkflow } from './templates'

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

test('a ticket runs in the first project its Jira key or a label names, any case', () => {
  const rules = [
    { match: 'web', folder: '/repos/web' },
    { match: ' BF ', folder: '/repos/betfeel' },
    { match: 'api', folder: '' }
  ]
  expect(projectFor(rules, { key: 'BF-7', labels: ['Web'] })?.folder).toBe('/repos/web')
  expect(projectFor(rules, { key: 'BF-7', labels: [] })?.folder).toBe('/repos/betfeel')
  expect(projectFor(rules, { key: 'OPS-1', labels: ['api'] })).toBeNull()
  expect(projectFor([], { key: 'BF-7', labels: [] })).toBeNull()
})

test("a project's subagent picks override its steps' own, and leave the rest", () => {
  const workflow = ticketWorkflow('jira', 'agent', false)
  const picked = withSubagents(workflow, { build: 'dev', test: 'qa' })
  expect(picked.nodes.flatMap((node) => (node.kind === 'agent' ? [[node.id, node.subagent ?? null]] : []))).toEqual([
    ['plan', null],
    ['build', 'dev'],
    ['test', 'qa'],
    ['pr', null]
  ])
  expect(withSubagents(workflow)).toEqual(workflow)
})

test('without a rule, a ticket runs in a folder named like its project or a label', () => {
  const folders = ['/code/ariex', '/code/social-win']
  expect(folderNamed(folders, { key: '1f2a3b4c-0000', labels: ['Ariex', 'ready'] })).toBe('/code/ariex')
  expect(folderNamed(folders, { key: 'SW-3', labels: ['Social Win'] })).toBe('/code/social-win')
  expect(folderNamed(folders, { key: 'OPS-1', labels: [] })).toBeNull()
})

test("a ticket's branch is its Jira key, or a Notion task's title with the start of its page id", () => {
  expect(ticketBranch({ source: 'jira', key: 'BF-12', title: 'Fix login' })).toBe('bf-12')
  expect(ticketBranch({ source: 'notion', key: '29a77dc5-8f92-80aa', title: 'Calories: skip implausible weights!' })).toBe('calories-skip-implausible-weights-29a77d')
  expect(ticketBranch({ source: 'notion', key: '29a77dc5-8f92-80aa', title: 'Ćwiczenia' })).toBe('wiczenia-29a77d')
  expect(ticketBranch({ source: 'notion', key: '29a77dc5-8f92-80aa', title: '' })).toBe('29a77d')
})
