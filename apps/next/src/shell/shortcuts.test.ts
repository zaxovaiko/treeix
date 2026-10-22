import { expect, test } from 'bun:test'
import { isCommandId, menuChord, shortcut } from './shortcuts'

const key = (k: string, mods: { shift?: boolean; alt?: boolean; ctrl?: boolean; meta?: boolean } = {}, code = '') => ({
  key: k,
  code,
  metaKey: mods.meta ?? true,
  shiftKey: mods.shift ?? false,
  altKey: mods.alt ?? false,
  ctrlKey: mods.ctrl ?? false,
})

test('maps the shell shortcuts', () => {
  expect(shortcut(key('t'))).toBe('new-shell')
  expect(shortcut(key('d'))).toBe('split-right')
  expect(shortcut(key('D', { shift: true }))).toBe('split-down')
  expect(shortcut(key('{', { shift: true }, 'BracketLeft'))).toBe('prev-tab')
  expect(shortcut(key('3'))).toBe('tab-3')
  expect(shortcut(key('ArrowLeft', { alt: true }))).toBe('focus-left')
  expect(shortcut(key('\\', {}, 'Backslash'))).toBe('toggle-sidebar')
  expect(shortcut(key('P', { shift: true }))).toBe('palette')
})

test('leaves other keys to the terminal', () => {
  expect(shortcut(key('t', { meta: false }))).toBeNull()
  expect(shortcut(key('c'))).toBeNull()
  expect(shortcut(key('0'))).toBeNull()
})

test('menu ids are checked', () => {
  expect(isCommandId('split-down')).toBe(true)
  expect(isCommandId('tab-9')).toBe(true)
  expect(isCommandId('rm -rf')).toBe(false)
})

test('menu chords: only what src-tauri/src/menu.rs binds', () => {
  expect(menuChord(key('\\', {}, 'Backslash'))).toBe(true)
  expect(menuChord(key(','))).toBe(true)
  expect(menuChord(key('P', { shift: true }))).toBe(true)
  expect(menuChord(key('k'))).toBe(false)
  expect(menuChord(key('t'))).toBe(false)
})
