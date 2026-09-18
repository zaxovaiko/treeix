import { expect, test } from 'bun:test'
import { terminalTitle } from './terminalTitle'

test('terminalTitle drops spinner prefixes and keeps the topic', () => {
  expect(terminalTitle('✳ Fix hotkey Dock')).toBe('Fix hotkey Dock')
  expect(terminalTitle('⠐ Fix hotkey Dock')).toBe('Fix hotkey Dock')
  expect(terminalTitle('~/Documents/oss')).toBe('~/Documents/oss')
  expect(terminalTitle('  ✳  ')).toBe('')
  expect(terminalTitle('a'.repeat(80))).toHaveLength(60)
})
