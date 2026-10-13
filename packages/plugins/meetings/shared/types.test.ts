import { expect, test } from 'bun:test'
import { dayGroup } from './types'

test('dayGroup buckets by calendar day, then month', () => {
  const now = new Date(2026, 9, 20, 9)
  expect(dayGroup(new Date(2026, 9, 20, 1), now)).toBe('Today')
  expect(dayGroup(new Date(2026, 9, 19, 23), now)).toBe('Yesterday')
  expect(dayGroup(new Date(2026, 9, 15, 12), now)).toBe('5 days ago')
  expect(dayGroup(new Date(2026, 9, 2), now)).toBe('This month')
  expect(dayGroup(new Date(2026, 8, 30), now)).toBe(new Date(2026, 8, 30).toLocaleDateString([], { month: 'long' }))
  expect(dayGroup(new Date(2025, 9, 20), now)).toContain('2025')
})
