import { expect, test } from 'bun:test'
import { chordOf, conflict, defaultKeys, keyFor, resolveShortcut } from '.'

test('defaults come from the built-in shortcuts', () => {
  const mac = defaultKeys(true)
  expect(mac['new-shell']).toBe('Super+KeyT')
  expect(mac.palette).toBe('Super+KeyK')
  expect(mac.settings).toBe('Super+Comma')
  expect(mac['split-down']).toBe('Shift+Super+KeyD')
  expect(mac['new-claude']).toBe('Shift+Super+KeyC')
  expect([mac['zoom-in'], mac['zoom-out'], mac['zoom-reset']]).toEqual(['Super+Equal', 'Super+Minus', 'Super+Digit0'])
  const linux = defaultKeys(false)
  expect(linux['new-shell']).toBe('Control+Shift+KeyT')
  expect(linux.settings).toBe('Control+Comma')
  expect(linux['new-claude']).toBeUndefined()
  expect(linux['zoom-in']).toBe('Control+Shift+Equal')
})

test('an override moves an action, an empty one unbinds it', () => {
  const keys = { 'new-shell': 'Super+KeyY', palette: '' }
  expect(resolveShortcut(chordOf('Super+KeyY'), keys, true)).toBe('new-shell')
  expect(resolveShortcut(chordOf('Super+KeyT'), keys, true)).toBeNull()
  expect(resolveShortcut(chordOf('Super+KeyK'), keys, true)).toBeNull()
  expect(keyFor('palette', keys, true)).toBeNull()
  // Untouched actions and the unlisted tab chords keep working
  expect(resolveShortcut(chordOf('Super+KeyD'), keys, true)).toBe('split-right')
  expect(resolveShortcut(chordOf('Super+Digit2'), keys, true)).toBe('tab-2')
  expect(resolveShortcut(chordOf('Shift+Super+KeyC'), {}, true)).toBe('new-claude')
})

test('conflicts name what already owns the chord', () => {
  expect(conflict('new-shell', 'Super+KeyK', {}, true)).toBe('Same keys as Command palette')
  expect(conflict('new-shell', 'Shift+Super+KeyN', {}, true)).toBe('Same keys as Open worktree')
  expect(conflict('new-shell', 'Super+KeyF', {}, true)).toBe('⌘F goes to the terminal')
  expect(conflict('new-shell', 'Control+Shift+KeyC', {}, false)).toBe('Ctrl+Shift+C goes to the terminal')
  expect(conflict('new-shell', 'Control+KeyR', {}, false)).toBe('Ctrl+R goes to the terminal')
  expect(conflict('new-shell', 'Super+KeyY', {}, true)).toBeNull()
  // A freed default is free
  expect(conflict('new-shell', 'Super+KeyK', { palette: '' }, true)).toBeNull()
  expect(conflict('hotkey', 'Control+Backquote', {}, true)).toBeNull()
})
