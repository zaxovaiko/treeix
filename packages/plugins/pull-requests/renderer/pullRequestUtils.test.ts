import { expect, test } from 'bun:test'
import { sortPullRequests, untilLabel } from './pullRequestUtils'

test('untilLabel picks the largest sensible unit', () => {
  const now = 1_000_000_000_000
  expect(untilLabel(now + 40 * 60_000, now)).toBe('40m')
  expect(untilLabel(now + 2.2 * 3_600_000, now)).toBe('2h')
  expect(untilLabel(now + 5 * 86_400_000, now)).toBe('5d')
  expect(untilLabel(now - 1000, now)).toBe('1m')
  expect(untilLabel(null, now)).toBe('-')
})

test('sortPullRequests orders by counts with unknown counts last', () => {
  const pr = (number: number, updatedAt: string, changedFiles: number | null, lines: number | null, commentCount: number | null) =>
    ({ number, updatedAt, changedFiles, additions: lines, deletions: lines === null ? null : 0, commentCount }) as Parameters<typeof sortPullRequests>[0][number]
  const list = [pr(1, '2026-09-01', 9, 50, 2), pr(2, '2026-09-03', null, null, 7), pr(3, '2026-09-02', 2, 500, 0)]
  const numbers = (sort: Parameters<typeof sortPullRequests>[1]) => sortPullRequests(list, sort).map((entry) => entry.number)
  expect(numbers('updated')).toEqual([2, 3, 1])
  expect(numbers('oldest')).toEqual([1, 3, 2])
  expect(numbers('fewestFiles')).toEqual([3, 1, 2])
  expect(numbers('fewestChanges')).toEqual([1, 3, 2])
  expect(numbers('mostComments')).toEqual([2, 1, 3])
})
