import { expect, test } from 'bun:test'
import { matchesFilters, parseFilters } from './PullRequestFilter'

test('parseFilters keeps only well-formed saved filters', () => {
  expect(parseFilters([{ kind: 'author', value: 'ann' }, { kind: 'nope', value: 'x' }, { kind: 'repo' }, 'junk'])).toEqual([{ kind: 'author', value: 'ann' }])
  expect(parseFilters(null)).toEqual([])
})

test('a text filter matches title, number and branch', () => {
  const pr = { provider: 'github', number: 42, title: 'Fix login', sourceBranch: 'fix/auth', author: 'ann', repoPath: '/r', targetBranch: 'main' } as Parameters<typeof matchesFilters>[0]
  expect(matchesFilters(pr, [{ kind: 'text', value: 'LOGIN' }])).toBe(true)
  expect(matchesFilters(pr, [{ kind: 'text', value: '#42' }])).toBe(true)
  expect(matchesFilters(pr, [{ kind: 'text', value: 'auth' }, { kind: 'author', value: 'bob' }])).toBe(false)
})

test('review and comment filters match by state and count bucket', () => {
  const base = { provider: 'github', number: 1, title: '', sourceBranch: '', author: '', repoPath: '/r', targetBranch: 'main' }
  const pr = (review: object | null, commentCount: number | null) => ({ ...base, review, commentCount }) as Parameters<typeof matchesFilters>[0]
  expect(matchesFilters(pr({ state: 'approved', newCommits: 0 }, 0), [{ kind: 'review', value: 'approved' }])).toBe(true)
  expect(matchesFilters(pr({ state: 'approved', newCommits: 0, changesRequested: true }, 0), [{ kind: 'review', value: 'changes' }])).toBe(true)
  expect(matchesFilters(pr({ state: 'unreviewed', newCommits: 0 }, 0), [{ kind: 'review', value: 'approved' }])).toBe(false)
  expect(matchesFilters(pr(null, 0), [{ kind: 'comments', value: 'No comments' }])).toBe(true)
  expect(matchesFilters(pr(null, 7), [{ kind: 'comments', value: '6-20 comments' }])).toBe(true)
  expect(matchesFilters(pr(null, null), [{ kind: 'comments', value: 'No comments' }])).toBe(false)
})
