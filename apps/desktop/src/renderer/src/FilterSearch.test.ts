import { expect, test } from 'bun:test'
import { type FilterGroup, matchesTokens, parseTokens } from './FilterSearch'

type Item = { author: string; repo: string; title: string }
const groups: FilterGroup<Item>[] = [
  { kind: 'author', label: 'People', valueOf: (item) => item.author },
  { kind: 'repo', label: 'Repositories', valueOf: (item) => item.repo },
  { kind: 'text', label: 'Text', valueOf: () => null, freeText: (item, needle) => item.title.toLowerCase().includes(needle) }
]
const item: Item = { author: 'ann', repo: 'openora', title: 'Fix login' }

test('matchesTokens treats one group as alternatives and different groups as all-of', () => {
  expect(matchesTokens(item, [], groups)).toBe(true)
  expect(matchesTokens(item, [{ kind: 'author', value: 'ann' }], groups)).toBe(true)
  expect(matchesTokens(item, [{ kind: 'author', value: 'bob' }], groups)).toBe(false)
  expect(matchesTokens(item, [{ kind: 'author', value: 'ann' }, { kind: 'author', value: 'bob' }], groups)).toBe(true)
  expect(matchesTokens(item, [{ kind: 'author', value: 'ann' }, { kind: 'repo', value: 'betfeel' }], groups)).toBe(false)
  expect(matchesTokens(item, [{ kind: 'text', value: 'LOGIN' }], groups)).toBe(true)
  expect(matchesTokens(item, [{ kind: 'text', value: 'logout' }], groups)).toBe(false)
})

test('parseTokens keeps only well-formed saved filters', () => {
  expect(parseTokens([{ kind: 'author', value: 'ann' }, { kind: 'nope', value: 'x' }, { kind: 'repo' }, 'junk'], ['author', 'repo'])).toEqual([{ kind: 'author', value: 'ann' }])
  expect(parseTokens(null, ['author'])).toEqual([])
})
