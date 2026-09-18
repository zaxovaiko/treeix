import { expect, test } from 'bun:test'
import { isStale, trimEntries } from './cache'

test('isStale counts a missing or old entry as stale', () => {
  const now = 1_000_000
  expect(isStale(null, 1000, now)).toBe(true)
  expect(isStale({ value: 1, fetchedAt: now - 500 }, 1000, now)).toBe(false)
  expect(isStale({ value: 1, fetchedAt: now - 1500 }, 1000, now)).toBe(true)
})

test('trimEntries keeps the newest entries', () => {
  const entries: [string, { value: number; fetchedAt: number }][] = [
    ['a', { value: 1, fetchedAt: 10 }],
    ['b', { value: 2, fetchedAt: 30 }],
    ['c', { value: 3, fetchedAt: 20 }]
  ]
  expect(trimEntries(entries, 2).map(([id]) => id)).toEqual(['b', 'c'])
})
