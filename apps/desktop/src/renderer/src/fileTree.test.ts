import { expect, test } from 'bun:test'
import { ancestorFolders, buildFolderTree } from './fileTree'

test('buildFolderTree merges single-child folder chains', () => {
  const tree = buildFolderTree(
    ['apps/backoffice/src/modules/players/hooks/a.ts', 'apps/backoffice/src/modules/wallet/b.tsx', 'apps/e2e/pages/c.ts', 'README.md'],
    (path) => path
  )
  expect(tree.files).toEqual(['README.md'])
  const [apps] = tree.folders
  expect(apps.name).toBe('apps')
  expect(apps.folders.map((folder) => [folder.name, folder.path])).toEqual([
    ['backoffice/src/modules', 'apps/backoffice/src/modules'],
    ['e2e/pages', 'apps/e2e/pages']
  ])
  expect(apps.folders[0].folders.map((folder) => folder.name)).toEqual(['players/hooks', 'wallet'])
  expect(ancestorFolders('a/b/c.ts')).toEqual(['a', 'a/b'])
})

test('allFolders collapses everything except the open file path', async () => {
  globalThis.localStorage ??= { getItem: () => null, setItem: () => undefined } as unknown as Storage
  const { allFolders } = await import('./ChangedFiles')
  const paths = ['packages/core/src', 'packages/core/src/contracts/adapters', 'packages/core/src/pam/identity']
  // Sections default to hidden, so toggles list the folders that are open
  expect([...allFolders(paths, true)]).toEqual(paths)
  expect([...allFolders(paths, false, ['packages', 'packages/core', 'packages/core/src', 'packages/core/src/pam', 'packages/core/src/pam/identity'])]).toEqual([
    'packages/core/src',
    'packages/core/src/pam/identity'
  ])
})
