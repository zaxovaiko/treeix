import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHistory } from './history'

test('snapshots the previous version at most once a minute and skips duplicates', async () => {
  const worktree = mkdtempSync(join(tmpdir(), 'treeix-wt-'))
  const history = createHistory(mkdtempSync(join(tmpdir(), 'treeix-history-')))
  writeFileSync(join(worktree, 'a.ts'), 'one')
  await history.snapshotBeforeSave(worktree, 'a.ts', 1_000_000)
  writeFileSync(join(worktree, 'a.ts'), 'two')
  await history.snapshotBeforeSave(worktree, 'a.ts', 1_030_000)
  await history.snapshotBeforeSave(worktree, 'a.ts', 1_100_000)
  await history.snapshotBeforeSave(worktree, 'a.ts', 1_200_000)
  const entries = await history.list(worktree, 'a.ts')
  expect(entries.map((entry) => entry.savedAt)).toEqual([1_100_000, 1_000_000])
  expect(await history.read(worktree, 'a.ts', '1000000')).toBe('one')
  expect(await history.read(worktree, 'a.ts', '1100000')).toBe('two')
  expect(() => history.read(worktree, 'a.ts', '../x')).toThrow()
  await history.snapshotBeforeSave(worktree, 'missing.ts')
  expect(await history.list(worktree, 'missing.ts')).toEqual([])
})
