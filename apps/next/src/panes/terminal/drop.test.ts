import { expect, test } from 'bun:test'
import { dropText, shellEscape } from './drop'

test('escapes what a shell would parse', () => {
  expect(shellEscape('/Users/me/plain.txt')).toBe('/Users/me/plain.txt')
  expect(shellEscape('/Users/me/My Files/a (1).png')).toBe('/Users/me/My\\ Files/a\\ \\(1\\).png')
  expect(shellEscape(`it's $HOME & "more"`)).toBe(`it\\'s\\ \\$HOME\\ \\&\\ \\"more\\"`)
  expect(shellEscape('a\\b*?[x]')).toBe('a\\\\b\\*\\?\\[x\\]')
  expect(shellEscape('zażółć/файл.md')).toBe('zażółć/файл.md')
})

test('several files go in space-separated', () => {
  expect(dropText(['/a b', '/c'])).toBe('/a\\ b /c')
})
