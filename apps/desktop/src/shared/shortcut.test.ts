import { expect, test } from 'bun:test'
import { IS_MAC } from './platform'
import { carbonModifiers, forPlatform, isShortcut, keysText, macKeyCode, matchesShortcut, shortcutLabel, toAccelerator } from './shortcut'

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
  expect(shortcutLabel(combo)).toBe(IS_MAC ? '⌃⌥⇧⌘ K' : 'Ctrl+Super+Alt+Shift+K')
  expect(macKeyCode(combo)).toBe(40)
  expect(carbonModifiers(combo)).toBe(256 | 512 | 2048 | 4096)
  expect(toAccelerator(combo)).toBe(IS_MAC ? 'Control+Alt+Shift+Command+K' : 'Control+Alt+Shift+Super+K')
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

test('macOS defaults: Ctrl stands in for ⌘ elsewhere, and ⌃⌘ becomes Ctrl+Alt', () => {
  expect(forPlatform(shortcut('KeyK', { meta: true }))).toEqual(IS_MAC ? shortcut('KeyK', { meta: true }) : shortcut('KeyK', { ctrl: true }))
  expect(forPlatform(shortcut('ArrowUp', { meta: true, ctrl: true }))).toEqual(
    IS_MAC ? shortcut('ArrowUp', { meta: true, ctrl: true }) : shortcut('ArrowUp', { ctrl: true, alt: true })
  )
  expect(forPlatform(shortcut('Tab', { ctrl: true }))).toEqual(shortcut('Tab', { ctrl: true }))
})

test('key glyphs in copy are spelled out off macOS', () => {
  const copy = [
    ['⇧⌘T', 'Ctrl+Shift+T'],
    ['Close (⌘ W)', 'Close (Ctrl+W)'],
    ['⌘ [ ]', 'Ctrl+[ ]'],
    ['⌘-click a link', 'Ctrl-click a link'],
    ['Chords with ⌘ work everywhere', 'Chords with Ctrl work everywhere']
  ] as const
  for (const [mac, other] of copy) expect(keysText(mac)).toBe(IS_MAC ? mac : other)
})
