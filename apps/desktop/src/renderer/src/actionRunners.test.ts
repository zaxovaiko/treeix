import { expect, test } from 'bun:test'
import { IS_MAC } from '../../shared/platform'
import { defineActions, key } from '../../shared/keymap'
import { menuActions, registerActionRunner, runAction, runnableActionFor } from './actionRunners'

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
    { id: 'test.zen', label: 'Zen', section: 'Panels', accelerator: IS_MAC ? 'Shift+Command+Enter' : 'Control+Shift+Enter' }
  ])
  drops.forEach((drop) => drop())
})

test('an alias key and a context-guarded key are kept out of the menu payload', async () => {
  const { defineActions: define, key: bind } = await import('../../shared/keymap')
  define([
    { id: 'app.shortcuts', label: 'Keyboard sheet', section: 'Panels', keys: bind('Slash', { meta: true }) },
    { id: 'app.shortcutsBare', label: 'Keyboard sheet, second key', section: 'Panels', keys: bind('Slash', { shift: true }) }
  ])
  const drops = [registerActionRunner('app.shortcutsBare', () => undefined), registerActionRunner('app.shortcuts', () => undefined)]
  // The second key never reaches the menu, and the sheet reaches it without its key, since macOS would skip the typing guard
  expect(menuActions()).toEqual([{ id: 'app.shortcuts', label: 'Keyboard sheet', section: 'Panels' }])
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

test('an editor hands ⌘ chords with a runner back to the app, never plain keys', () => {
  const drop = registerActionRunner('test.zen', () => undefined)
  const dropLine = registerActionRunner('test.line', () => undefined)
  const press = (code: string, { primary = false, shiftKey = false } = {}) =>
    ({ code, key: code, metaKey: IS_MAC && primary, shiftKey, altKey: false, ctrlKey: !IS_MAC && primary }) as KeyboardEvent
  expect(runnableActionFor(press('Enter', { primary: true, shiftKey: true }))).toBe('test.zen')
  expect(runnableActionFor(press('KeyJ'))).toBeUndefined()
  drop()
  dropLine()
  expect(runnableActionFor(press('Enter', { primary: true, shiftKey: true }))).toBeUndefined()
})
