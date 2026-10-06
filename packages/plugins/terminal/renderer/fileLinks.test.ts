import { expect, test } from 'bun:test'
import { droppedPaths, findFileLinks, findInFiles, findRowFileLinks, findIssueLinks, findWebLinks, resolvePath } from './fileLinks'

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

test('findFileLinks finds bare file names with code extensions, not domains or versions', () => {
  expect(paths('Edited pty.ts:42 and README.md, see example.com, v1.2, e.g. node')).toEqual(['pty.ts:42', 'README.md'])
  expect(paths('in main/pty.ts and ./a/b.ts')).toEqual(['main/pty.ts', './a/b.ts'])
})

test('findInFiles picks the shortest worktree file ending with the path', () => {
  const files = ['packages/plugins/terminal/main/pty.ts', 'main/pty.ts.bak', 'x/terminal/main/pty.ts/deep', 'a/main/pty.ts']
  expect(findInFiles('main/pty.ts', files)).toBe('a/main/pty.ts')
  expect(findInFiles('./terminal/main/pty.ts', files)).toBe('packages/plugins/terminal/main/pty.ts')
  expect(findInFiles('nope.ts', files)).toBeNull()
})

test('findIssueLinks finds Jira keys, not parts of longer words', () => {
  expect(findIssueLinks('Fixes ABC-12 and X2-7 (see UTF-8, a-ABC-1, ABC-1x)').map((link) => `${link.project}:${link.key}`)).toEqual(['ABC:ABC-12', 'X2:X2-7', 'UTF:UTF-8'])
})

test('droppedPaths escapes what a shell would split or expand, like Terminal', () => {
  expect(droppedPaths(['/Users/me/Desktop/Screenshot 2026-10-03 at 9.41.12.png', "/tmp/it's (1).jpg", '/tmp/a.png'])).toBe(
    "/Users/me/Desktop/Screenshot\\ 2026-10-03\\ at\\ 9.41.12.png /tmp/it\\'s\\ \\(1\\).jpg /tmp/a.png "
  )
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
