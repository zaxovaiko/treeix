import { expect, test } from 'bun:test'
import type { GraphImport, ImportKind, ModuleGraph } from '../../ipc/api'
import { cycleGroups, filterGraph, findPath, folderAt, layout, levelGraph } from './graph'

const imp = (from: string, to: string | null, kind: ImportKind = 'static', extra: Partial<GraphImport> = {}): GraphImport => ({
  from,
  to,
  specifier: to ?? 'x',
  kind,
  external: null,
  unresolved: false,
  line: 1,
  ...extra,
})

const scan = (files: [string, string | null][], imports: GraphImport[]): ModuleGraph => ({
  root: '/repo',
  packages: [],
  files: files.map(([path, pkg]) => ({ path, package: pkg })),
  imports,
  cycles: [],
  errors: [],
})

test('folderAt cuts a file to its first folders', () => {
  expect(folderAt('packages/plugins/env/main/env.ts', 3)).toBe('packages/plugins/env')
  expect(folderAt('src/a.ts', 3)).toBe('src')
  expect(folderAt('index.ts', 2)).toBe('.')
})

test('the folders level counts imports between folders and drops ones inside a folder', () => {
  const graph = scan(
    [
      ['app/a/x.ts', null],
      ['app/a/y.ts', null],
      ['lib/b/z.ts', null],
      ['lib/c/w.ts', null],
    ],
    [imp('app/a/x.ts', 'app/a/y.ts'), imp('app/a/x.ts', 'lib/b/z.ts'), imp('app/a/y.ts', 'lib/b/z.ts', 'type'), imp('lib/b/z.ts', 'lib/c/w.ts')],
  )
  const folders = levelGraph(graph, 'folders', 2)
  expect(folders.nodes.map((node) => `${node.id} ${node.files}`)).toEqual(['app/a 2', 'lib/b 1', 'lib/c 1'])
  expect(folders.edges.map((edge) => `${edge.from}>${edge.to} ${edge.imports.length} ${edge.kind}`)).toEqual(['app/a>lib/b 2 static', 'lib/b>lib/c 1 static'])
  expect(levelGraph(graph, 'folders', 1).edges.map((edge) => `${edge.from}>${edge.to}`)).toEqual(['app>lib'])
})

test('the packages level links packages and shows externals; files and folders leave externals out', () => {
  const graph = scan(
    [
      ['apps/web/main.ts', 'web'],
      ['packages/ui/index.ts', 'ui'],
    ],
    [
      imp('apps/web/main.ts', 'packages/ui/index.ts', 'type'),
      imp('apps/web/main.ts', 'packages/ui/index.ts', 'dynamic'),
      imp('apps/web/main.ts', null, 'static', { external: 'react' }),
      imp('packages/ui/index.ts', null, 'static', { external: 'react' }),
      imp('packages/ui/index.ts', null, 'static', { unresolved: true, specifier: './gone' }),
    ],
  )
  const packages = levelGraph(graph, 'packages')
  expect(packages.nodes.map((node) => `${node.label}${node.external ? ' ext' : ''}`)).toEqual(['ui', 'web', 'react ext'])
  expect(packages.edges.map((edge) => `${edge.from}>${edge.to} ${edge.kind}`)).toEqual(['web>ui dynamic', 'web>ext:react static', 'ui>ext:react static'])
  expect(packages.unresolved.map((item) => `${item.from} ${item.import.specifier}`)).toEqual(['ui ./gone'])
  expect(levelGraph(graph, 'files').nodes.every((node) => !node.external)).toBe(true)
  expect(filterGraph(packages, 'WE').nodes.map((node) => node.id)).toEqual(['web'])
})

test('cycles group nodes that import each other, never through type-only imports', () => {
  const edges = [
    { from: 'a', to: 'b', kind: 'static' as const },
    { from: 'b', to: 'c', kind: 'dynamic' as const },
    { from: 'c', to: 'a', kind: 'static' as const },
    { from: 'c', to: 'd', kind: 'type' as const },
    { from: 'd', to: 'c', kind: 'static' as const },
  ]
  expect(cycleGroups(['a', 'b', 'c', 'd'], edges)).toEqual([['a', 'b', 'c']])
})

test('findPath finds the shortest chain, or none', () => {
  const edges = [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
    { from: 'a', to: 'c' },
    { from: 'c', to: 'd' },
  ]
  expect(findPath(edges, 'a', 'd')).toEqual(['a', 'c', 'd'])
  expect(findPath(edges, 'd', 'a')).toEqual([])
  expect(findPath(edges, 'a', 'a')).toEqual([])
})

test('layout puts importers left of what they import, even around a cycle', () => {
  const graph = levelGraph(
    scan(
      [
        ['a.ts', null],
        ['b.ts', null],
        ['c.ts', null],
      ],
      [imp('a.ts', 'b.ts'), imp('b.ts', 'c.ts'), imp('c.ts', 'a.ts'), imp('a.ts', null, 'static', { unresolved: true })],
    ),
    'files',
  )
  const { pos } = layout(graph)
  const x = (id: string) => pos.get(id)?.x ?? -1
  expect(x('a.ts')).toBeLessThan(x('b.ts'))
  expect(x('b.ts')).toBeLessThan(x('c.ts'))
  expect(x('unresolved:0')).toBe(x('b.ts'))
})
