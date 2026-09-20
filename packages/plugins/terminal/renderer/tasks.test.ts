import { expect, test } from 'bun:test'
import { addTab, aggregateStatus, newTask, parseTasks, placeBeside, remapTasks, removeSession, shownPanes, type Task, taskPanes, tasksFromSessions, uniqueName } from './tasks'

const task = (...sessions: string[]) => sessions.reduce(addTab, newTask({ workspaceId: 'w', worktreePath: '/repo' }))

test('removeSession moves focus to a neighbour and closes an emptied tab', () => {
  const [split] = placeBeside([task('a')], ['b'], 'a', 'right')
  expect(split.tabs[0].focus).toBe('b')
  const [left] = removeSession([split], 'b')
  expect(left.tabs[0]).toMatchObject({ layout: [['a']], focus: 'a' })
  const two = task('a', 'b')
  const [closed] = removeSession([two], 'b')
  expect(closed.tabs.map((tab) => tab.layout)).toEqual([[['a']]])
  expect(closed.activeTab).toBe(closed.tabs[0].id)
  expect(removeSession([closed], 'a')[0]).toMatchObject({ tabs: [], activeTab: null })
})

test('remapTasks renames panes and drops tabs whose sessions are gone', () => {
  const [remapped] = remapTasks([task('a', 'b')], (id) => (id === 'a' ? 'x' : undefined))
  expect(remapped.tabs.map((tab) => tab.layout)).toEqual([[['x']]])
  expect(remapped.tabs[0].focus).toBe('x')
})

test('sessions from before tasks group into one task per worktree, in shown order', () => {
  const tasks = tasksFromSessions(
    [
      { id: 'a', worktreePath: '/one', workspaceId: 'w' },
      { id: 'b', worktreePath: '/two', workspaceId: 'w' },
      { id: 'c', worktreePath: '/one', workspaceId: 'w' }
    ],
    ['c', 'b']
  )
  expect(tasks.map((task) => [task.worktreePath, task.tabs.map((tab) => tab.layout[0][0])])).toEqual([
    ['/one', ['c', 'a']],
    ['/two', ['b']]
  ])
  expect(parseTasks(JSON.parse(JSON.stringify(tasks)))).toEqual(tasks)
  expect(parseTasks([{ id: 1 }, null])).toEqual([])
})

test('status and unique names', () => {
  expect(aggregateStatus(['idle', 'running', 'input'])).toBe('input')
  expect(aggregateStatus(['exited', 'running'])).toBe('running')
  expect(aggregateStatus([])).toBe('idle')
  expect(uniqueName('repo · dev', [])).toBe('repo · dev')
  expect(uniqueName('repo · dev', ['repo · dev', 'repo · dev 2'])).toBe('repo · dev 3')
})

const panes = (tasks: Task[]): string[] => tasks.flatMap(taskPanes).sort()

test('placeBeside never loses a session', () => {
  const one = [task('a', 'b')]
  expect(placeBeside(one, ['a'], 'a', 'left')).toBe(one)
  expect(placeBeside(one, ['x'], 'missing', 'left')).toBe(one)
  // A full tab takes the seventh session as a new tab
  let full = [task('a')]
  for (const id of ['b', 'c', 'd', 'e', 'f', 'g']) full = placeBeside(full, [id], 'a', 'bottom')
  expect(full[0].tabs.map((tab) => taskPanes({ ...full[0], tabs: [tab] }).length)).toEqual([6, 1])
  expect(panes(full)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g'])
})

test('a dragged tab merges into the target tab, a tab onto its own pane stays', () => {
  const [merged] = placeBeside([task('a', 'b')], ['b'], 'a', 'right')
  expect(merged.tabs.map((tab) => tab.layout)).toEqual([[['a'], ['b']]])
  const [split] = placeBeside([task('a')], ['b'], 'a', 'right')
  const two = addTab(split, 'c')
  const [stacked] = placeBeside([two], ['a', 'b'], 'c', 'left')
  expect(stacked.tabs.map((tab) => tab.layout)).toEqual([[['a', 'b'], ['c']]])
  expect(placeBeside([two], ['a', 'b'], 'a', 'top')).toEqual([two])
})

test('shownPanes starts only the active tab of the task shown in the workspace', () => {
  const [one, two] = [task('a', 'b'), task('c')]
  const split = placeBeside([one], ['d'], 'b', 'right')[0]
  const other = { ...task('e'), workspaceId: 'x' }
  expect(shownPanes([split, two, other], { w: split.id }, 'w')).toEqual(['b', 'd'])
  expect(shownPanes([split, two, other], { w: two.id }, 'w')).toEqual(['c'])
  expect(shownPanes([split, two, other], {}, 'w')).toEqual(['b', 'd'])
  expect(shownPanes([split, two, other], {}, 'x')).toEqual(['e'])
  expect(shownPanes([split], {}, 'none')).toEqual([])
  expect(shownPanes([{ ...split, activeTab: split.tabs[0].id }], { w: split.id }, 'w')).toEqual(['a'])
})
