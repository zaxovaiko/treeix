import { expect, test } from 'bun:test'
import { IS_MAC } from './platform'
import { actionForEvent, actionKeys, conflictsOf, defineActions, isRebound, key, matchesAction, setKeymapOverrides, shortcutOf } from './keymap'

// `primary` is ⌘ on macOS and Ctrl elsewhere, which is what a ⌘ default turns into there
const event = (code: string, { primary = false, ...modifiers }: Partial<Record<'primary' | 'shiftKey' | 'altKey', boolean>> = {}): KeyboardEvent =>
  ({ code, metaKey: IS_MAC && primary, shiftKey: false, altKey: false, ctrlKey: !IS_MAC && primary, ...modifiers }) as KeyboardEvent

defineActions([
  { id: 'test.zen', label: 'Zen', section: 'Test', keys: key('Enter', { meta: true, shift: true }) },
  { id: 'test.open', label: 'Open', section: 'Test', keys: key('KeyO') },
  { id: 'test.unbound', label: 'Unbound', section: 'Test', keys: null }
])

test('an action runs on the key it ships with, modifiers and all', () => {
  expect(matchesAction(event('Enter', { primary: true, shiftKey: true }), 'test.zen')).toBe(true)
  // A stray modifier is a different combination
  expect(matchesAction(event('Enter', { primary: true, shiftKey: true, altKey: true }), 'test.zen')).toBe(false)
  expect(matchesAction(event('KeyO'), 'test.unbound')).toBe(false)
  expect(actionForEvent(event('KeyO'), ['test.zen', 'test.open'])).toBe('test.open')
  expect(actionForEvent(event('KeyX'), ['test.zen', 'test.open'])).toBeUndefined()
  expect(actionKeys('test.zen')).toBe(IS_MAC ? '⇧⌘ ↵' : 'Ctrl+Shift+↵')
  expect(actionKeys('test.unbound')).toBe('')
})

test('rebinding wins over the shipped key, and resetting brings it back', () => {
  setKeymapOverrides({ 'test.open': key('KeyG', { meta: true }), 'test.zen': null })
  expect(matchesAction(event('KeyO'), 'test.open')).toBe(false)
  expect(matchesAction(event('KeyG', { primary: true }), 'test.open')).toBe(true)
  // Unbound on purpose: the key it ships with stops working
  expect(shortcutOf('test.zen')).toBeNull()
  expect(isRebound('test.zen')).toBe(true)
  setKeymapOverrides({})
  expect(matchesAction(event('KeyO'), 'test.open')).toBe(true)
  expect(isRebound('test.zen')).toBe(false)
})

test('two actions on one key are reported as a clash', () => {
  setKeymapOverrides({ 'test.unbound': key('KeyO') })
  expect(conflictsOf('test.open')).toEqual(['test.unbound'])
  setKeymapOverrides({})
  expect(conflictsOf('test.open')).toEqual([])
})
