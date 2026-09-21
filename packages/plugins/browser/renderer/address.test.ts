import { expect, test } from 'bun:test'
import { isLocalUrl, toUrl } from './address'

test('toUrl keeps URLs, completes hosts and searches the rest', () => {
  expect(toUrl('https://example.com/a', 'google')).toBe('https://example.com/a')
  expect(toUrl('localhost:3000', 'google')).toBe('http://localhost:3000')
  expect(toUrl('127.0.0.1:8080/x', 'google')).toBe('http://127.0.0.1:8080/x')
  expect(toUrl('github.com/zaxovaiko', 'google')).toBe('https://github.com/zaxovaiko')
  expect(toUrl('about:blank', 'google')).toBe('about:blank')
  expect(toUrl('  ', 'google')).toBe('about:blank')
  expect(toUrl('react hooks', 'google')).toBe('https://www.google.com/search?q=react%20hooks')
  expect(toUrl('treeix', 'duckduckgo')).toBe('https://duckduckgo.com/?q=treeix')
})

test('isLocalUrl spots dev servers', () => {
  expect(isLocalUrl('http://localhost:5173/')).toBe(true)
  expect(isLocalUrl('http://127.0.0.1:3000')).toBe(true)
  expect(isLocalUrl('https://example.com')).toBe(false)
})
