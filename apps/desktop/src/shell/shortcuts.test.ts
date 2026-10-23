import { expect, test } from 'bun:test'
import { accelerator, acceleratorLabel, isCommandId, keyHint, menuChord, shortcut } from './shortcuts'

const key = (k: string, mods: { shift?: boolean; alt?: boolean; ctrl?: boolean; meta?: boolean } = {}, code = '') => ({
  key: k,
  code,
  metaKey: mods.meta ?? true,
  shiftKey: mods.shift ?? false,
  altKey: mods.alt ?? false,
  ctrlKey: mods.ctrl ?? false,
})
const mac = (e: ReturnType<typeof key>) => shortcut(e, true)
const linux = (e: ReturnType<typeof key>) => shortcut(e, false)
const ctrl = (k: string, code: string, mods: { shift?: boolean; alt?: boolean } = {}) => key(k, { ...mods, ctrl: true, meta: false }, code)

test('maps the macOS shell shortcuts', () => {
  expect(mac(key('t'))).toBe('new-shell')
  expect(mac(key('o'))).toBe('open-folder')
  expect(mac(key('d'))).toBe('split-right')
  expect(mac(key('D', { shift: true }))).toBe('split-down')
  expect(mac(key('{', { shift: true }, 'BracketLeft'))).toBe('prev-tab')
  expect(mac(key('3'))).toBe('tab-3')
  expect(mac(key('ArrowLeft', { alt: true }))).toBe('focus-left')
  expect(mac(key('\\', {}, 'Backslash'))).toBe('toggle-sidebar')
  expect(mac(key('P', { shift: true }))).toBe('palette')
})

test('macOS leaves other keys to the terminal', () => {
  expect(mac(key('t', { meta: false }))).toBeNull()
  expect(mac(key('c'))).toBeNull()
  expect(mac(key('0'))).toBeNull()
  expect(mac(ctrl('c', 'KeyC'))).toBeNull()
})

test('Ctrl+Tab cycles tabs everywhere', () => {
  for (const run of [mac, linux]) {
    expect(run(ctrl('Tab', 'Tab'))).toBe('next-tab')
    expect(run(ctrl('Tab', 'Tab', { shift: true }))).toBe('prev-tab')
  }
})

test('maps the Linux shell shortcuts to Ctrl+Shift', () => {
  expect(linux(ctrl('T', 'KeyT', { shift: true }))).toBe('new-shell')
  expect(linux(ctrl('W', 'KeyW', { shift: true }))).toBe('close-pane')
  expect(linux(ctrl('P', 'KeyP', { shift: true }))).toBe('palette')
  expect(linux(ctrl('D', 'KeyD', { shift: true }))).toBe('split-right')
  expect(linux(ctrl('E', 'KeyE', { shift: true }))).toBe('split-down')
  expect(linux(ctrl('O', 'KeyO', { shift: true }))).toBe('open-folder')
  expect(linux(ctrl(',', 'Comma'))).toBe('settings')
  expect(linux(ctrl('PageUp', 'PageUp'))).toBe('prev-tab')
  expect(linux(ctrl('PageDown', 'PageDown'))).toBe('next-tab')
  expect(linux(key('2', { alt: true, meta: false }, 'Digit2'))).toBe('tab-2')
})

test('Linux: plain Ctrl chords and Cmd-style chords go to the terminal', () => {
  for (const [k, code] of [['t', 'KeyT'], ['w', 'KeyW'], ['d', 'KeyD'], ['c', 'KeyC'], ['p', 'KeyP'], ['e', 'KeyE']]) expect(linux(ctrl(k, code))).toBeNull()
  expect(linux(key('t', {}, 'KeyT'))).toBeNull()
  expect(linux(ctrl('C', 'KeyC', { shift: true }))).toBeNull()
  expect(linux(key('0', { alt: true, meta: false }, 'Digit0'))).toBeNull()
  expect(linux(key('b', { alt: true, meta: false }, 'KeyB'))).toBeNull()
})

test('hints follow the platform', () => {
  expect(keyHint('new-shell', true)).toBe('⌘T')
  expect(keyHint('new-shell', false)).toBe('Ctrl+Shift+T')
  expect(keyHint('new-claude', true)).toBeUndefined()
})

test('menu ids are checked', () => {
  expect(isCommandId('split-down')).toBe(true)
  expect(isCommandId('open-folder')).toBe(true)
  expect(isCommandId('tab-9')).toBe(true)
  expect(isCommandId('rm -rf')).toBe(false)
})

test('menu chords: only what src-tauri/src/menu.rs binds, and only on macOS', () => {
  expect(menuChord(key('\\', {}, 'Backslash'), {}, true)).toBe(true)
  expect(menuChord(key(',', {}, 'Comma'), {}, true)).toBe(true)
  expect(menuChord(key('P', { shift: true }, 'KeyP'), {}, true)).toBe(true)
  expect(menuChord(key('k', {}, 'KeyK'), {}, true)).toBe(false)
  expect(menuChord(key('t', {}, 'KeyT'), {}, true)).toBe(false)
  expect(menuChord(key(',', {}, 'Comma'), {}, false)).toBe(false)
})

test('menu chords follow settings.keys', () => {
  expect(menuChord(key('P', { shift: true }, 'KeyP'), { palette: 'Shift+Super+KeyO' }, true)).toBe(false)
  expect(menuChord(key('O', { shift: true }, 'KeyO'), { palette: 'Shift+Super+KeyO' }, true)).toBe(true)
  expect(menuChord(key(',', {}, 'Comma'), { settings: '' }, true)).toBe(false)
})

test('records global shortcut accelerators', () => {
  expect(accelerator(ctrl('`', 'Backquote'))).toBe('Control+Backquote')
  expect(accelerator(key(' ', { alt: true, meta: false }, 'Space'))).toBe('Alt+Space')
  expect(accelerator(key('T', { shift: true }, 'KeyT'))).toBe('Shift+Super+KeyT')
  expect(accelerator(key('F5', { meta: false }, 'F5'))).toBe('F5')
  expect(accelerator(key('§', { meta: false }, 'IntlBackslash'))).toBe('IntlBackslash')
  expect(accelerator(key('a', { meta: false }, 'KeyA'))).toBeNull()
  expect(accelerator(key('Shift', { shift: true, meta: false }, 'ShiftLeft'))).toBeNull()
})

test('labels accelerators per platform', () => {
  expect(acceleratorLabel('Control+Backquote', true)).toBe('⌃`')
  expect(acceleratorLabel('Control+Backquote', false)).toBe('Ctrl+`')
  expect(acceleratorLabel('Shift+Super+KeyT', true)).toBe('⇧⌘T')
  expect(acceleratorLabel('Alt+Digit1', false)).toBe('Alt+1')
  expect(acceleratorLabel('Control+IntlBackslash', true)).toBe('⌃§')
})
