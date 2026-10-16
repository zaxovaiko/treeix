import { expect, test } from 'bun:test'
import { activeAgents, askWorkflow, freshNode, isWorkflow, latestCardRuns, type NodeStatus, onCard, type Run, type RunStatus } from './workflow'

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

test('a pull request sits where its newest run put it', () => {
  const on = (id: string, card: string | null): Run => ({ ...run(id, 'done', 'done'), id, card })
  const latest = latestCardRuns([on('new', 'pr/1'), on('plain', null), on('old', 'pr/1'), on('other', 'pr/2')])
  expect([...latest].map(([card, entry]) => [card, entry.id])).toEqual([
    ['pr/2', 'other'],
    ['pr/1', 'new']
  ])
})

test('steps without a folder work in the pull request repo', () => {
  const card = { url: 'u', title: 't', number: 1, repoPath: '/repo', sourceBranch: 'b', targetBranch: 'main' }
  const kept = { ...askWorkflow('a', '/mine'), nodes: [...askWorkflow('a', null).nodes, { ...askWorkflow('a', '/mine').nodes[1], id: 'kept' }] }
  const folders = onCard(kept, card).nodes.flatMap((node) => (node.kind === 'agent' ? [node.folder] : []))
  expect(folders).toEqual(['/repo', '/mine'])
})
