import { expect, test } from 'bun:test'
import { filesEndingWith, findFileLinks, findRowFileLinks, findWebLinks } from './fileLinks'

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

test('findWebLinks finds addresses and leaves closing punctuation out', () => {
  const text = 'MR: https://gitlab.blurify.com/betfeel/betfeel/-/merge_requests/437 (branch), see https://x.dev/a).'
  expect(findWebLinks(text).map((link) => link.url)).toEqual(['https://gitlab.blurify.com/betfeel/betfeel/-/merge_requests/437', 'https://x.dev/a'])
  expect(findWebLinks('no links here')).toEqual([])
})

test('findFileLinks finds bare file names with code extensions, not domains or versions', () => {
  expect(paths('Edited pty.ts:42 and README.md, see example.com, v1.2, e.g. node')).toEqual(['pty.ts:42', 'README.md'])
  expect(paths('in main/pty.ts and ./a/b.ts')).toEqual(['main/pty.ts', './a/b.ts'])
})

test('findRowFileLinks joins a path an agent cut over two rows', () => {
  const first = '  /Users/me/projects/treeix/packages/plugin'
  const second = '  s/terminal/renderer/fileLinks.ts:12'
  const targets = (text: string, before: string | null, after: string | null) => findRowFileLinks(text, before, after).map((link) => link.targets)
  const whole = { path: '/Users/me/projects/treeix/packages/plugins/terminal/renderer/fileLinks.ts', line: 12 }
  expect(targets(first, null, second)[0][0]).toEqual(whole)
  expect(targets(second, first, null)[0][0]).toEqual(whole)
  expect(findRowFileLinks(second, first, null)[0]).toMatchObject({ start: 2, end: second.length })
})

test('findRowFileLinks keeps a path that only looks cut', () => {
  expect(findRowFileLinks('see src/a.ts', null, 'and more').map((link) => link.targets)).toEqual([
    [
      { path: 'src/a.tsand', line: null },
      { path: 'src/a.ts', line: null }
    ]
  ])
  expect(findRowFileLinks('edit pty.ts', null, 'and more').map((link) => link.targets)).toEqual([[{ path: 'pty.ts', line: null }]])
})

test('filesEndingWith finds a cut or relative path in the checkout, shallowest first', () => {
  const files = ['apps/desktop/src/a.ts', 'src/a.ts', 'docs/src/b.md', 'xsrc/a.ts']
  expect(filesEndingWith(files, '/src/a.ts')).toEqual(['src/a.ts', 'apps/desktop/src/a.ts'])
  expect(filesEndingWith(files, '../../b.md')).toEqual(['docs/src/b.md'])
  expect(filesEndingWith(files, 'a.ts')).toEqual(['src/a.ts', 'xsrc/a.ts', 'apps/desktop/src/a.ts'])
  expect(filesEndingWith(files, './')).toEqual([])
})
