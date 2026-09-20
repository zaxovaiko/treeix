import { expect, test } from 'bun:test'
import type { PullRequest, ReviewThread } from '../shared/types'
import { groupPullRequests, involvesYou, sortPullRequests, threadReference, untilLabel } from './pullRequestUtils'

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

test('groupPullRequests puts reviewable first and conflicts last, keeping order', () => {
  type PullRequest = Parameters<typeof groupPullRequests>[0][number]
  const pr = (number: number, extra: Partial<PullRequest>) => ({ number, draft: false, conflicts: false, review: null, ...extra }) as PullRequest
  const groups = groupPullRequests([
    pr(1, { conflicts: true }),
    pr(2, {}),
    pr(3, { review: { state: 'approved', newCommits: 0 } }),
    pr(4, { draft: true }),
    pr(5, { review: { state: 'approved', newCommits: 2 } }),
    pr(6, { draft: true, conflicts: true })
  ])
  expect(groups.map((group) => [group.id, group.pullRequests.map((entry) => entry.number)])).toEqual([
    ['ready', [2, 5]],
    ['settled', [3]],
    ['drafts', [4]],
    ['conflicts', [1, 6]]
  ])
  expect(groupPullRequests([pr(1, {})]).map((group) => group.id)).toEqual(['ready'])
})

test('involvesYou needs a known review state other than unreviewed', () => {
  type PullRequest = Parameters<typeof involvesYou>[0]
  const withReview = (review: PullRequest['review']) => ({ review }) as PullRequest
  expect(involvesYou(withReview({ state: 'requested', newCommits: 0 }))).toBe(true)
  expect(involvesYou(withReview({ state: 'yours', newCommits: 0 }))).toBe(true)
  expect(involvesYou(withReview({ state: 'unreviewed', newCommits: 0 }))).toBe(false)
  expect(involvesYou(withReview(null))).toBe(false)
})

test('threadReference points at the thread without copying bodies or code', () => {
  const github = { provider: 'github', number: 12, url: 'https://github.com/o/r/pull/12' } as PullRequest
  const gitlab = { provider: 'gitlab', number: 5, url: 'https://gitlab.com/o/r/-/merge_requests/5' } as PullRequest
  const comment = (id: string) => ({ id, author: 'ann', avatarUrl: null, body: 'secret body', createdAt: '', reactions: { '+1': 0, '-1': 0, laugh: 0, hooray: 0, confused: 0, heart: 0, rocket: 0, eyes: 0 } })
  const thread = (id: string, path: string | null, line: number | null): ReviewThread => ({ id: '1', path, line, side: 'additions', comments: [comment(id)], resolved: null, resolveId: null })
  expect(threadReference(github, thread('review:7', 'src/a.ts', 42))).toBe(
    'PR #12 https://github.com/o/r/pull/12 review thread by @ann on src/a.ts:42: https://github.com/o/r/pull/12#discussion_r7'
  )
  expect(threadReference(github, thread('issue:9', null, null))).toBe(
    'PR #12 https://github.com/o/r/pull/12 review thread by @ann on conversation: https://github.com/o/r/pull/12#issuecomment-9'
  )
  expect(threadReference(gitlab, { ...thread('note:3', 'b.ts', 4), side: 'deletions' })).toBe(
    'MR !5 https://gitlab.com/o/r/-/merge_requests/5 review thread by @ann on b.ts:4 (old): https://gitlab.com/o/r/-/merge_requests/5#note_3'
  )
  expect(threadReference(github, thread('review:7', 'src/a.ts', 42))).not.toContain('secret body')
})
