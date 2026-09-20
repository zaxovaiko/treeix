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
