import { expect, test } from 'bun:test'
import { defineActions, key } from '../../shared/keymap'
import { menuActions, registerActionRunner, runAction } from './actionRunners'

defineActions([
  { id: 'test.zen', label: 'Zen: the main zone alone', menuLabel: 'Zen', section: 'Panels', keys: key('Enter', { meta: true, shift: true }) },
  { id: 'test.page', label: 'Open worktrees (G W)', menuLabel: 'Worktrees', section: 'Go to', keys: null },
  { id: 'test.line', label: 'Move the line cursor down', section: 'Worktrees', page: 'worktrees', keys: key('KeyJ') }
])

test('only an action with a runner reaches the menu', () => {
  expect(menuActions()).toHaveLength(0)
  const drop = registerActionRunner('test.zen', () => undefined)
  expect(menuActions().map((action) => action.id)).toEqual(['test.zen'])
  drop()
  expect(menuActions()).toHaveLength(0)
})

test('a page-scoped action stays out even once it has a runner', () => {
  const drop = registerActionRunner('test.line', () => undefined)
  expect(menuActions()).toHaveLength(0)
  drop()
})

test('the menu carries the short label and the key the action answers to', () => {
  const drops = [registerActionRunner('test.page', () => undefined), registerActionRunner('test.zen', () => undefined)]
  expect(menuActions()).toEqual([
    { id: 'test.page', label: 'Worktrees', section: 'Go to' },
    { id: 'test.zen', label: 'Zen', section: 'Panels', accelerator: 'Shift+Command+Enter' }
  ])
  drops.forEach((drop) => drop())
})

test('running an id calls its runner, and an unknown id is a no-op', () => {
  let ran = 0
  const drop = registerActionRunner('test.zen', () => (ran += 1))
  runAction('test.zen')
  runAction('test.missing')
  expect(ran).toBe(1)
  drop()
})
