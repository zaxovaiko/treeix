import { expect, test } from 'bun:test'
import { type KeyChord, terminalKey } from './keys'

const chord = (key: string, code: string, mods: Partial<KeyChord> = {}): KeyChord => ({ key, code, metaKey: false, altKey: false, ctrlKey: false, shiftKey: false, ...mods })

test('mac line and word editing', () => {
  expect(terminalKey(chord('ArrowLeft', 'ArrowLeft', { metaKey: true }), true)).toEqual({ type: 'send', data: '\x01' })
  expect(terminalKey(chord('ArrowRight', 'ArrowRight', { metaKey: true }), true)).toEqual({ type: 'send', data: '\x05' })
  expect(terminalKey(chord('Backspace', 'Backspace', { metaKey: true }), true)).toEqual({ type: 'send', data: '\x15' })
  expect(terminalKey(chord('ArrowLeft', 'ArrowLeft', { altKey: true }), true)).toEqual({ type: 'send', data: '\x1bb' })
  expect(terminalKey(chord('ArrowRight', 'ArrowRight', { altKey: true }), true)).toEqual({ type: 'send', data: '\x1bf' })
})

test('shift+enter inserts a newline for agents', () => {
  expect(terminalKey(chord('Enter', 'Enter', { shiftKey: true }), true)).toEqual({ type: 'send', data: '\x1b\r' })
  expect(terminalKey(chord('Enter', 'Enter', { shiftKey: true }), false)).toEqual({ type: 'send', data: '\x1b\r' })
  expect(terminalKey(chord('Enter', 'Enter'), true)).toEqual({ type: 'xterm' })
})

test('mac cmd chords: clear, find, the rest (copy and paste too) bubble to the app', () => {
  expect(terminalKey(chord('k', 'KeyK', { metaKey: true, shiftKey: true }), true)).toEqual({ type: 'clear' })
  expect(terminalKey(chord('K', 'KeyK', { ctrlKey: true, shiftKey: true }), false)).toEqual({ type: 'clear' })
  expect(terminalKey(chord('k', 'KeyK', { metaKey: true }), true)).toEqual({ type: 'app' })
  expect(terminalKey(chord('f', 'KeyF', { metaKey: true }), true)).toEqual({ type: 'find' })
  for (const [key, code] of [
    ['c', 'KeyC'],
    ['t', 'KeyT'],
    ['w', 'KeyW'],
    ['d', 'KeyD'],
    ['1', 'Digit1'],
    ['9', 'Digit9'],
    ['v', 'KeyV']
  ]) {
    expect(terminalKey(chord(key, code, { metaKey: true }), true)).toEqual({ type: 'app' })
  }
  expect(terminalKey(chord('P', 'KeyP', { metaKey: true, shiftKey: true }), true)).toEqual({ type: 'app' })
  expect(terminalKey(chord('Tab', 'Tab', { ctrlKey: true }), true)).toEqual({ type: 'app' })
})

test('option types characters on mac', () => {
  expect(terminalKey(chord('ą', 'KeyA', { altKey: true }), true)).toEqual({ type: 'xterm' })
  expect(terminalKey(chord('c', 'KeyC', { ctrlKey: true }), true)).toEqual({ type: 'xterm' })
})

test('linux: plain ctrl is the shell, ctrl+shift is the app', () => {
  expect(terminalKey(chord('c', 'KeyC', { ctrlKey: true }), false)).toEqual({ type: 'xterm' })
  expect(terminalKey(chord('C', 'KeyC', { ctrlKey: true, shiftKey: true }), false)).toEqual({ type: 'copy' })
  expect(terminalKey(chord('V', 'KeyV', { ctrlKey: true, shiftKey: true }), false)).toEqual({ type: 'paste' })
  expect(terminalKey(chord('F', 'KeyF', { ctrlKey: true, shiftKey: true }), false)).toEqual({ type: 'find' })
  expect(terminalKey(chord('T', 'KeyT', { ctrlKey: true, shiftKey: true }), false)).toEqual({ type: 'app' })
})

test('keys typed into an input method go to xterm untouched', () => {
  expect(terminalKey(chord('Enter', 'Enter', { shiftKey: true, isComposing: true }), true)).toEqual({ type: 'xterm' })
  expect(terminalKey(chord('Process', 'KeyK', { metaKey: true, keyCode: 229 }), true)).toEqual({ type: 'xterm' })
  expect(terminalKey(chord('Process', 'KeyC', { ctrlKey: true, shiftKey: true, keyCode: 229 }), false)).toEqual({ type: 'xterm' })
})
