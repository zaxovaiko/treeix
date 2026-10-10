import { expect, test } from 'bun:test'
import { toUrl } from './address'

test('toUrl keeps URLs, completes hosts and searches the rest', () => {
  expect(toUrl('https://example.com/a', 'google')).toBe('https://example.com/a')
  expect(toUrl('localhost:3000', 'google')).toBe('http://localhost:3000')
  expect(toUrl('127.0.0.1:8080/x', 'google')).toBe('http://127.0.0.1:8080/x')
  expect(toUrl('192.168.1.5:8080', 'google')).toBe('http://192.168.1.5:8080')
  expect(toUrl('app.localhost:5173/x', 'google')).toBe('http://app.localhost:5173/x')
  expect(toUrl('0.0.0.0:3000', 'google')).toBe('http://0.0.0.0:3000')
  expect(toUrl('1.2.3', 'google')).toBe('https://www.google.com/search?q=1.2.3')
  expect(toUrl('github.com/zaxovaiko', 'google')).toBe('https://github.com/zaxovaiko')
  expect(toUrl('about:blank', 'google')).toBe('about:blank')
  expect(toUrl('  ', 'google')).toBe('about:blank')
  expect(toUrl('react hooks', 'google')).toBe('https://www.google.com/search?q=react%20hooks')
  expect(toUrl('treeix', 'duckduckgo')).toBe('https://duckduckgo.com/?q=treeix')
  expect(toUrl('пример.рф', 'google')).toBe('https://пример.рф')
  expect(toUrl('medium.com/@treeix', 'google')).toBe('https://medium.com/@treeix')
  expect(toUrl('me@example.com', 'google')).toBe('https://www.google.com/search?q=me%40example.com')
  expect(toUrl('https://ex ample.com', 'google')).toBe('https://www.google.com/search?q=https%3A%2F%2Fex%20ample.com')
})
