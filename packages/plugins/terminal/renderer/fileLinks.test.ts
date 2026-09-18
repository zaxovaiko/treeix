import { expect, test } from 'bun:test'
import { findFileLinks, findWebLinks, resolvePath } from './fileLinks'

const paths = (text: string) => findFileLinks(text).map(({ path, line }) => (line ? `${path}:${line}` : path))

test('findFileLinks finds absolute, home, relative and line-numbered paths', () => {
  expect(paths('Gotowe w /Users/me/oss/betfeel/docs/aml-cases.md (plik)')).toEqual(['/Users/me/oss/betfeel/docs/aml-cases.md'])
  expect(paths('see ~/notes/todo.md and ./src/a.ts:42:7, ../b/c.ts.')).toEqual(['~/notes/todo.md', './src/a.ts:42', '../b/c.ts'])
  expect(paths('Zmiany: docs/wallet-qa.md, docs/assets/wallet-qa/.')).toEqual(['docs/wallet-qa.md', 'docs/assets/wallet-qa'])
  expect(paths('open https://example.com/a/b.md or 3/4 done')).toEqual([])
})

test('findFileLinks covers the whole path including the line number', () => {
  const [link] = findFileLinks('x src/a.ts:12 y')
  expect([link.start, link.end]).toEqual([2, 13])
})

test('resolvePath reads paths like the shell', () => {
  expect(resolvePath('docs/a.md', '/repo', '/Users/me')).toBe('/repo/docs/a.md')
  expect(resolvePath('../x/./b.ts', '/repo/app', '/Users/me')).toBe('/repo/x/b.ts')
  expect(resolvePath('~/n.md', '/repo', '/Users/me')).toBe('/Users/me/n.md')
  expect(resolvePath('/abs/c.md', '/repo', '/Users/me')).toBe('/abs/c.md')
})

test('findWebLinks finds addresses and leaves closing punctuation out', () => {
  const text = 'MR: https://gitlab.blurify.com/betfeel/betfeel/-/merge_requests/437 (branch), see https://x.dev/a).'
  expect(findWebLinks(text).map((link) => link.url)).toEqual(['https://gitlab.blurify.com/betfeel/betfeel/-/merge_requests/437', 'https://x.dev/a'])
  expect(findWebLinks('no links here')).toEqual([])
})
