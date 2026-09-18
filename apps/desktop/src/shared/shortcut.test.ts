import { expect, test } from 'bun:test'
import { carbonModifiers, isShortcut, macKeyCode, matchesShortcut, shortcutLabel, toAccelerator } from './shortcut'

const shortcut = (code: string, modifiers: Partial<{ meta: boolean; alt: boolean; ctrl: boolean; shift: boolean }> = {}) => ({
  code,
  meta: false,
  alt: false,
  ctrl: false,
  shift: false,
  ...modifiers
})

test('section key works natively but has no Electron accelerator', () => {
  const section = shortcut('IntlBackslash')
  expect(shortcutLabel(section)).toBe('§')
  expect(macKeyCode(section)).toBe(10)
  expect(toAccelerator(section)).toBeNull()
})

test('labels, key codes, modifiers and accelerators', () => {
  const combo = shortcut('KeyK', { meta: true, shift: true, alt: true, ctrl: true })
  expect(shortcutLabel(combo)).toBe('⌃⌥⇧⌘ K')
  expect(macKeyCode(combo)).toBe(40)
  expect(carbonModifiers(combo)).toBe(256 | 512 | 2048 | 4096)
  expect(toAccelerator(combo)).toBe('Control+Alt+Shift+Command+K')
  expect(toAccelerator(shortcut('Backquote', { alt: true }))).toBe('Alt+`')
  expect(shortcutLabel(shortcut('F12'))).toBe('F12')
  expect(isShortcut(combo)).toBe(true)
  expect(isShortcut({ code: 'KeyK' })).toBe(false)
})

test('matchesShortcut compares the physical key and every modifier', () => {
  const event = (code: string, modifiers: Partial<{ metaKey: boolean; shiftKey: boolean }> = {}) =>
    ({ code, metaKey: false, altKey: false, ctrlKey: false, shiftKey: false, ...modifiers }) as KeyboardEvent
  expect(matchesShortcut(event('F12', { shiftKey: true }), shortcut('F12', { shift: true }))).toBe(true)
  expect(matchesShortcut(event('F12', { shiftKey: true, metaKey: true }), shortcut('F12', { shift: true }))).toBe(false)
  expect(matchesShortcut(event('F12'), null)).toBe(false)
})
