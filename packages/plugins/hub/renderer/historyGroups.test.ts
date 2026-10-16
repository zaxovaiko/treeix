import { expect, test } from 'bun:test'
import { historyGroup } from './historyGroups'

test('historyGroup buckets by calendar day, then week, then month', () => {
  const now = new Date(2026, 9, 16, 9, 0).getTime()
  const at = (month: number, day: number, hour = 12): string => historyGroup(new Date(2026, month, day, hour).getTime(), now)
  expect(at(9, 16, 1)).toBe('Today')
  expect(at(9, 15, 23)).toBe('Yesterday')
  expect(at(9, 11)).toBe('5 days ago')
  expect(at(9, 9)).toBe('1 week ago')
  expect(at(9, 2)).toBe('2 weeks ago')
  expect(at(8, 10)).toBe('1 month ago')
  expect(at(6, 1)).toBe('3 months ago')
})
