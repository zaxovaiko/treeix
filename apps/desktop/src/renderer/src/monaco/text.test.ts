import { expect, test } from 'bun:test'
import { applyExternalText, gutterRange, normalizeEol } from './text'

test('a disk change becomes the smallest single edit', () => {
  expect(applyExternalText('a\nb\nc', 'a\nb\nc')).toBeNull()
  expect(applyExternalText('a\nb\nc', 'a\nB\nc')).toEqual({ start: 2, end: 3, text: 'B' })
  expect(applyExternalText('abc', 'abXc')).toEqual({ start: 2, end: 2, text: 'X' })
  expect(applyExternalText('abc', '')).toEqual({ start: 0, end: 3, text: '' })
})

test('an EOL-only difference is not a change', () => {
  expect(normalizeEol('a\r\nb\rc\n')).toBe('a\nb\nc\n')
  expect(applyExternalText('a\r\nb\r\nc', 'a\nb\nc')).toBeNull()
  expect(applyExternalText('a\rb\rc', 'a\nb\nc')).toBeNull()
})

test('a line-number drag comments on the lines it covered', () => {
  expect(gutterRange({ startLineNumber: 4, endLineNumber: 4, endColumn: 12 })).toEqual({ start: 4, end: 4 })
  expect(gutterRange({ startLineNumber: 4, endLineNumber: 7, endColumn: 1 })).toEqual({ start: 4, end: 6 })
  expect(gutterRange({ startLineNumber: 4, endLineNumber: 7, endColumn: 9 })).toEqual({ start: 4, end: 7 })
})
