import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addWorktree, createBranch, deleteBranch, discardChanges, isDefinitionLine, listBranches, parseTrack, parseWorktreeList, removeWorktree, searchText, splitPatch, worktreeDir } from './git'

test('parseWorktreeList', () => {
  const porcelain = `worktree /repo
HEAD 1234567890abcdef
branch refs/heads/main

worktree /repo/.claude/worktrees/feat
HEAD abcdef1234567890
detached

worktree /bare.git
bare
`
  expect(parseWorktreeList(porcelain)).toEqual([
    { path: '/repo', head: '1234567', branch: 'main' },
    { path: '/repo/.claude/worktrees/feat', head: 'abcdef1', branch: null }
  ])
})

test('splitPatch', () => {
  const patch = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-x
+y
diff --git a/dir/b.ts b/dir/b.ts
new file mode 100644
`
  expect(splitPatch(patch).map(({ path, additions, deletions }) => [path, additions, deletions])).toEqual([
    ['a.ts', 1, 1],
    ['dir/b.ts', 0, 0]
  ])
})

test('isDefinitionLine', () => {
  const definitions = [
    'export async function resolveBase(repo: Repo) {',
    'export const resolveBase = async (repo: Repo) => {',
    '  private async resolveBase(repo: Repo): Promise<Base> {',
    '  resolveBase: (repo) => git(repo),',
    'def resolveBase(self):',
    'pub fn resolveBase() -> Base {',
    'func (s *Server) resolveBase() error {',
    'export class resolveBase extends Base {'
  ]
  const usages = [
    'const base = await resolveBase(repo)',
    'resolveBase(repo, () => {',
    "import { resolveBase } from './base'",
    'return resolveBase(repo);'
  ]
  expect(definitions.filter((line) => !isDefinitionLine(line, 'resolveBase'))).toEqual([])
  expect(usages.filter((line) => isDefinitionLine(line, 'resolveBase'))).toEqual([])
})

test('addWorktree, discardChanges and removeWorktree on a real repository', async () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'treeix-')))
  const run = (...args: string[]): string => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
  try {
    run('init', '-q', '-b', 'main')
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    run('add', '.')
    run('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init')

    expect(worktreeDir(repo, 'feat/x')).toBe(join(repo, '.claude', 'worktrees', 'feat+x'))
    const path = await addWorktree(repo, 'feat/x')
    expect(run('worktree', 'list')).toContain('feat+x')
    await expect(addWorktree(repo, 'bad..name')).rejects.toThrow('not a valid branch name')
    // A second click before the list refreshes, and a branch that already has its worktree, both get the same one
    expect(await Promise.all([addWorktree(repo, 'feat/y'), addWorktree(repo, 'feat/y')])).toEqual([worktreeDir(repo, 'feat/y'), worktreeDir(repo, 'feat/y')])
    expect(await addWorktree(repo, 'feat/x')).toBe(path)

    writeFileSync(join(path, 'a.txt'), 'changed\n')
    writeFileSync(join(path, 'new.txt'), 'untracked\n')
    await discardChanges(path, 'a.txt')
    await discardChanges(path, 'new.txt')
    expect(readFileSync(join(path, 'a.txt'), 'utf8')).toBe('one\n')
    expect(existsSync(join(path, 'new.txt'))).toBe(false)
    await expect(discardChanges(path, '../escape.txt')).rejects.toThrow('outside the worktree')

    await expect(removeWorktree(repo, false)).rejects.toThrow('main worktree')
    await removeWorktree(path, false)
    expect(existsSync(path)).toBe(false)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('searchText finds text across worktrees with case and whole word options', async () => {
  const root = mkdtempSync(join(tmpdir(), 'treeix-search-'))
  execFileSync('git', ['init', '-q', root])
  writeFileSync(join(root, 'a:b.ts'), 'const grantBonus = 1\nGrantBonus()\n')
  const insensitive = await searchText([root], 'grantbonus', { caseSensitive: false, wholeWord: false, regex: false })
  expect(insensitive.matches.map(({ path, line, column }) => `${path}:${line}:${column}`)).toEqual(['a:b.ts:1:6', 'a:b.ts:2:0'])
  const exact = await searchText([root], 'Grant', { caseSensitive: true, wholeWord: true, regex: false })
  expect(exact.matches).toHaveLength(0)
  await expect(searchText([root], '(', { caseSensitive: true, wholeWord: false, regex: true })).rejects.toThrow()
})

test('listBranches reports tracking, merged state and remote-only branches', async () => {
  const origin = mkdtempSync(join(tmpdir(), 'treeix-origin-'))
  const run = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  run(origin, 'init', '-q', '-b', 'main')
  run(origin, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'root')
  run(origin, 'branch', 'remote-only')
  const clone = mkdtempSync(join(tmpdir(), 'treeix-clone-'))
  execFileSync('git', ['clone', '-q', origin, clone])
  run(clone, 'branch', 'merged-feature')
  await createBranch(clone, 'ahead-feature', 'main')
  run(clone, 'checkout', '-q', 'ahead-feature')
  run(clone, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'work')
  run(clone, 'branch', '-q', '--set-upstream-to=origin/main')
  run(clone, 'checkout', '-q', 'main')

  const branches = await listBranches(clone)
  const byName = new Map(branches.map((branch) => [branch.name, branch]))
  expect(byName.get('ahead-feature')).toMatchObject({ remote: false, ahead: 1, behind: 0, merged: false })
  expect(byName.get('merged-feature')).toMatchObject({ remote: false, merged: true })
  expect(byName.get('main')?.merged).toBe(false)
  expect(byName.get('origin/remote-only')).toMatchObject({ remote: true })
  expect(byName.has('origin/main')).toBe(false)
  expect(parseTrack('gone')).toEqual({ ahead: 0, behind: 0, gone: true })

  await deleteBranch(clone, 'merged-feature')
  await expect(deleteBranch(clone, 'ahead-feature')).rejects.toThrow()
  await expect(createBranch(clone, 'x', '--orphan')).rejects.toThrow()
})
