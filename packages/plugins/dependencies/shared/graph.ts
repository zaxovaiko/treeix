import type { DependencyKind, DependencyScan, Package } from './types'

export type GraphNode = { id: string; label: string; detail: string; external: boolean; manifest: string | null }
export type GraphEdge = { source: string; target: string; count: number; kind: DependencyKind | 'import' }
export type Graph = { nodes: GraphNode[]; edges: GraphEdge[] }

/** The first `depth` folders of a file's folder; files above that depth stay in their own folder */
export const folderAt = (file: string, depth: number): string => {
  const parts = file.split('/').slice(0, -1)
  return parts.slice(0, depth).join('/') || '.'
}

/** Workspace packages and what they depend on: each other always, everything else only when `external` */
export function packageGraph(packages: Package[], external: boolean): Graph {
  const internal = new Map(packages.map((item) => [item.name, item]))
  const nodes: GraphNode[] = packages.map((item) => ({
    id: item.name,
    label: item.name,
    detail: [item.version, `${item.dependencies.length} deps`].filter(Boolean).join(' · '),
    external: false,
    manifest: item.manifest
  }))
  const externals = new Map<string, number>()
  const edges: GraphEdge[] = []
  for (const item of packages)
    for (const dependency of item.dependencies) {
      if (!internal.has(dependency.name) && !external) continue
      if (!internal.has(dependency.name)) externals.set(dependency.name, (externals.get(dependency.name) ?? 0) + 1)
      edges.push({ source: item.name, target: dependency.name, count: 1, kind: dependency.kind })
    }
  for (const [name, users] of [...externals].sort(([a], [b]) => a.localeCompare(b)))
    nodes.push({ id: name, label: name, detail: `used by ${users}`, external: true, manifest: null })
  return { nodes, edges }
}

/** Source folders cut at `depth`, joined by how many file imports cross from one to the other */
export function folderGraph({ files, imports }: Pick<DependencyScan, 'files' | 'imports'>, depth: number): Graph {
  const folders = files.map((file) => folderAt(file, depth))
  const sizes = new Map<string, number>()
  for (const folder of folders) sizes.set(folder, (sizes.get(folder) ?? 0) + 1)
  const counts = new Map<string, number>()
  for (const [from, to] of imports) {
    if (folders[from] === folders[to]) continue
    const key = `${folders[from]}\n${folders[to]}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return {
    nodes: [...sizes]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([folder, size]) => ({
        id: folder,
        label: folder,
        detail: `${size} file${size === 1 ? '' : 's'}`,
        external: false,
        manifest: null
      })),
    edges: [...counts].map(([key, count]) => {
      const [source, target] = key.split('\n')
      return { source, target, count, kind: 'import' as const }
    })
  }
}
