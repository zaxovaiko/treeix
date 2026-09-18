import { expect, test } from 'bun:test'
import { parseFilters } from './PullRequestFilter'

test('parseFilters keeps only well-formed saved filters', () => {
  expect(parseFilters([{ kind: 'author', value: 'ann' }, { kind: 'nope', value: 'x' }, { kind: 'repo' }, 'junk'])).toEqual([{ kind: 'author', value: 'ann' }])
  expect(parseFilters(null)).toEqual([])
})
