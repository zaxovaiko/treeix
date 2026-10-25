import { expect, test } from 'bun:test'
import { clearOf } from './xterm'

test('a see-through background keeps the theme color, only its alpha drops', () => {
  expect(clearOf('#fff')).toBe('#fff0')
  expect(clearOf('#faf9f5')).toBe('#faf9f500')
  expect(clearOf('rgb(1 2 3)')).toBe('rgba(0, 0, 0, 0)')
  expect(clearOf(undefined)).toBe('rgba(0, 0, 0, 0)')
})
