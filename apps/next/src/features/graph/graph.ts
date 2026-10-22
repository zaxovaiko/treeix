import type { GraphImport, ImportKind, ModuleGraph } from '../../ipc/api'

// The module graph cut to a level, its cycles, layout and paths; the page draws what these return

export type Level = 'packages' | 'folders' | 'files'

export interface Node {
  id: string
  label: string
  /** A package outside the repo */
  external: boolean
  files: number
}

export interface Edge {
  from: string
  to: string
  /** The strongest import behind it: a static or require one beats import(), which beats type-only */
  kind: ImportKind
  /** The imports it stands for, the evidence for "why does A import B" */
  imports: GraphImport[]
}

export interface LevelGraph {
  nodes: Node[]
  edges: Edge[]
  /** Unresolved imports with the node they come from */
  unresolved: { from: string; import: GraphImport }[]
}

const NO_PACKAGE = '(no package)'

/** The first `depth` folders of a file's folder; files above that depth stay in their own folder */
export const folderAt = (file: string, depth: number): string => file.split('/').slice(0, -1).slice(0, depth).join('/') || '.'

const RANK: Record<ImportKind, number> = { type: 0, dynamic: 1, require: 2, static: 2 }

/** Files joined into packages or folders (`depth` deep); imports inside one node drop out, externals show at the packages level only */
export function levelGraph(graph: ModuleGraph, level: Level, depth = 2): LevelGraph {
  const packageOf = new Map(graph.files.map((file) => [file.path, file.package ?? NO_PACKAGE]))
  const nodeOf = (path: string): string => (level === 'files' ? path : level === 'folders' ? folderAt(path, depth) : (packageOf.get(path) ?? NO_PACKAGE))
  const nodes = new Map<string, Node>()
  for (const file of graph.files) {
    const id = nodeOf(file.path)
    const node = nodes.get(id) ?? { id, label: id, external: false, files: 0 }
    nodes.set(id, { ...node, files: node.files + 1 })
  }
  const edges = new Map<string, Edge>()
  const unresolved: LevelGraph['unresolved'] = []
  for (const item of graph.imports) {
    const from = nodeOf(item.from)
    if (item.unresolved) {
      unresolved.push({ from, import: item })
      continue
    }
    let to: string
    if (item.to) to = nodeOf(item.to)
    else if (item.external && level === 'packages') {
      to = `ext:${item.external}`
      if (!nodes.has(to)) nodes.set(to, { id: to, label: item.external, external: true, files: 0 })
    } else continue
    if (to === from) continue
    const key = `${from}>${to}`
    const edge = edges.get(key)
    if (!edge) edges.set(key, { from, to, kind: item.kind, imports: [item] })
    else {
      edge.imports.push(item)
      if (RANK[item.kind] > RANK[edge.kind]) edge.kind = item.kind
    }
  }
  const byName = (a: Node, b: Node) => Number(a.external) - Number(b.external) || a.label.localeCompare(b.label)
  return { nodes: [...nodes.values()].sort(byName), edges: [...edges.values()], unresolved }
}

/** Keeps nodes whose label holds `query`, with the edges and unresolved imports between them */
export function filterGraph(graph: LevelGraph, query: string): LevelGraph {
  const needle = query.trim().toLowerCase()
  if (!needle) return graph
  const nodes = graph.nodes.filter((node) => node.label.toLowerCase().includes(needle))
  const ids = new Set(nodes.map((node) => node.id))
  return {
    nodes,
    edges: graph.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)),
    unresolved: graph.unresolved.filter((item) => ids.has(item.from)),
  }
}

/** Groups of nodes that import each other, type-only imports aside: every edge inside one is part of a cycle */
export function cycleGroups(nodes: string[], edges: Pick<Edge, 'from' | 'to' | 'kind'>[]): string[][] {
  const next = new Map<string, string[]>()
  for (const edge of edges) if (edge.kind !== 'type') next.set(edge.from, [...(next.get(edge.from) ?? []), edge.to])
  // Tarjan; recursion is as deep as the longest import chain, a few hundred at most
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const groups: string[][] = []
  const visit = (node: string) => {
    index.set(node, index.size)
    low.set(node, index.get(node) ?? 0)
    stack.push(node)
    onStack.add(node)
    for (const to of next.get(node) ?? []) {
      if (!index.has(to)) {
        visit(to)
        low.set(node, Math.min(low.get(node) ?? 0, low.get(to) ?? 0))
      } else if (onStack.has(to)) low.set(node, Math.min(low.get(node) ?? 0, index.get(to) ?? 0))
    }
    if (low.get(node) !== index.get(node)) return
    const group: string[] = []
    let member: string | undefined
    do {
      member = stack.pop()
      if (member === undefined) break
      onStack.delete(member)
      group.push(member)
    } while (member !== node)
    if (group.length > 1) groups.push(group.sort())
  }
  for (const node of nodes) if (!index.has(node)) visit(node)
  return groups.sort((a, b) => a[0].localeCompare(b[0]))
}

export interface Box {
  x: number
  y: number
  w: number
}

export const ROW = 58
const nodeWidth = (label: string) => label.length * 7 + 40

/** Layered columns left to right: each node one column right of what imports it, back edges of cycles ignored; unresolved imports sit right of their importer */
export function layout(graph: LevelGraph): { pos: Map<string, Box>; width: number; height: number } {
  const next = new Map<string, string[]>()
  for (const edge of graph.edges) if (edge.kind !== 'type') next.set(edge.from, [...(next.get(edge.from) ?? []), edge.to])
  const back = new Set<string>()
  const state = new Map<string, 1 | 2>()
  const dfs = (node: string) => {
    state.set(node, 1)
    for (const to of next.get(node) ?? []) {
      if (state.get(to) === 1) back.add(`${node}>${to}`)
      else if (!state.has(to)) dfs(to)
    }
    state.set(node, 2)
  }
  for (const node of graph.nodes) if (!state.has(node.id)) dfs(node.id)

  const layer = new Map(graph.nodes.map((node) => [node.id, 0]))
  const forward = graph.edges.filter((edge) => edge.kind !== 'type' && !back.has(`${edge.from}>${edge.to}`))
  for (let changed = true, round = 0; changed && round < graph.nodes.length; round++) {
    changed = false
    for (const edge of forward) {
      const deeper = (layer.get(edge.from) ?? 0) + 1
      if (deeper > (layer.get(edge.to) ?? 0)) {
        layer.set(edge.to, deeper)
        changed = true
      }
    }
  }
  const labels = new Map(graph.nodes.map((node) => [node.id, node.label]))
  graph.unresolved.forEach((item, i) => {
    labels.set(unresolvedId(i), `${item.import.specifier} unresolved`)
    layer.set(unresolvedId(i), (layer.get(item.from) ?? 0) + 1)
  })
  const columns: string[][] = []
  for (const id of labels.keys()) (columns[layer.get(id) ?? 0] ??= []).push(id)
  const tall = Math.max(1, ...columns.map((column) => column?.length ?? 0))
  const pos = new Map<string, Box>()
  let x = 30
  for (const column of columns) {
    if (!column) continue
    column.forEach((id, j) => pos.set(id, { x, y: 30 + ((tall - column.length) * ROW) / 2 + j * ROW, w: nodeWidth(labels.get(id) ?? id) }))
    x += Math.max(...column.map((id) => nodeWidth(labels.get(id) ?? id))) + 56
  }
  return { pos, width: x, height: 60 + tall * ROW }
}

export const unresolvedId = (index: number): string => `unresolved:${index}`

/** The shortest import chain from `from` to `to`, both included; empty when `to` is out of reach */
export function findPath(edges: Pick<Edge, 'from' | 'to'>[], from: string, to: string): string[] {
  if (from === to) return []
  const prev = new Map<string, string | null>([[from, null]])
  const queue = [from]
  while (queue.length) {
    const node = queue.shift()
    if (node === undefined || node === to) break
    for (const edge of edges)
      if (edge.from === node && !prev.has(edge.to)) {
        prev.set(edge.to, node)
        queue.push(edge.to)
      }
  }
  if (!prev.has(to)) return []
  const path: string[] = []
  for (let node: string | null | undefined = to; node; node = prev.get(node)) path.unshift(node)
  return path
}
