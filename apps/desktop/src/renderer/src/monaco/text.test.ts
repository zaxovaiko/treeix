import { expect, test } from 'bun:test'
import { applyExternalText } from './text'

test('a disk change becomes the smallest single edit', () => {
  expect(applyExternalText('a\nb\nc', 'a\nb\nc')).toBeNull()
  expect(applyExternalText('a\nb\nc', 'a\nB\nc')).toEqual({ start: 2, end: 3, text: 'B' })
  expect(applyExternalText('abc', 'abXc')).toEqual({ start: 2, end: 2, text: 'X' })
  expect(applyExternalText('abc', '')).toEqual({ start: 0, end: 3, text: '' })
})
