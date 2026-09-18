import { expect, test } from 'bun:test'
import { insideWorktree } from './paths'

test('insideWorktree rejects paths that leave the worktree', () => {
  expect(insideWorktree('/repo', 'src/a.ts')).toBe('/repo/src/a.ts')
  expect(() => insideWorktree('/repo', '../other/a.ts')).toThrow()
  expect(() => insideWorktree('/repo', '/etc/passwd')).toThrow()
  expect(() => insideWorktree('/repo', '')).toThrow()
})

test('saveFile refuses to overwrite a file that changed since it was loaded', async () => {
  const { mkdtempSync, readFileSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { saveFile } = await import('./paths')
  const root = mkdtempSync(join(tmpdir(), 'treeix-save-'))
  writeFileSync(join(root, 'a.ts'), 'loaded')
  await saveFile(root, 'a.ts', 'mine', 'loaded')
  expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('mine')
  writeFileSync(join(root, 'a.ts'), 'agent edit')
  await expect(saveFile(root, 'a.ts', 'mine again', 'mine')).rejects.toThrow('SAVE_CONFLICT')
  expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('agent edit')
  await saveFile(root, 'a.ts', 'forced', null)
  expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('forced')
})
