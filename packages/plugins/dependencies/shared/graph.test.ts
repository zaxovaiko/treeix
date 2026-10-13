import { expect, test } from 'bun:test'
import { folderAt, folderGraph, packageGraph } from './graph'
import type { Package } from './types'

test('folderAt cuts a file to its first folders', () => {
  expect(folderAt('packages/plugins/env/main/env.ts', 3)).toBe('packages/plugins/env')
  expect(folderAt('src/a.ts', 3)).toBe('src')
  expect(folderAt('index.ts', 2)).toBe('.')
})

test('folderGraph counts imports between folders and drops ones inside a folder', () => {
  const files = ['app/a/x.ts', 'app/a/y.ts', 'lib/b/z.ts', 'lib/c/w.ts']
  const imports: [number, number][] = [
    [0, 1],
    [0, 2],
    [1, 2],
    [2, 3]
  ]
  const graph = folderGraph({ files, imports }, 2)
  expect(graph.nodes.map((node) => `${node.id} ${node.detail}`)).toEqual(['app/a 2 files', 'lib/b 1 file', 'lib/c 1 file'])
  expect(graph.edges).toEqual([
    { source: 'app/a', target: 'lib/b', count: 2, kind: 'import' },
    { source: 'lib/b', target: 'lib/c', count: 1, kind: 'import' }
  ])
  expect(folderGraph({ files, imports }, 1).edges).toEqual([{ source: 'app', target: 'lib', count: 2, kind: 'import' }])
})

test('packageGraph links workspace packages and adds externals only when asked', () => {
  const packages: Package[] = [
    { name: 'web', version: '1.0.0', manifest: 'apps/web/package.json', dependencies: [
      { name: 'ui', range: 'workspace:*', kind: 'dependencies' },
      { name: 'react', range: '^19', kind: 'dependencies' }
    ] },
    { name: 'ui', version: null, manifest: 'packages/ui/package.json', dependencies: [{ name: 'react', range: '^19', kind: 'peerDependencies' }] }
  ]
  expect(packageGraph(packages, false).edges.map((edge) => `${edge.source}>${edge.target}`)).toEqual(['web>ui'])
  const withExternal = packageGraph(packages, true)
  expect(withExternal.nodes.find((node) => node.id === 'react')).toMatchObject({ external: true, detail: 'used by 2' })
  expect(withExternal.edges).toHaveLength(3)
})
