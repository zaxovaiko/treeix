/** React Flow pieces several canvases share: the app-themed colors and a left-to-right layout */

// Follows the app theme instead of React Flow's own light colors
export const FLOW_THEME = {
  '--xy-edge-stroke': 'var(--color-muted-foreground)',
  '--xy-edge-stroke-selected': 'var(--color-primary)',
  '--xy-connectionline-stroke': 'var(--color-primary)',
  '--xy-handle-background-color': 'color-mix(in srgb, var(--color-muted-foreground) 45%, transparent)',
  '--xy-handle-border-color': 'var(--color-popover)',
  // React Flow reads this one for every pattern; its `-dots-color` sibling is only a default it ignores once this is set
  '--xy-background-pattern-color': 'color-mix(in srgb, var(--color-foreground) 20%, transparent)',
  '--xy-controls-button-background-color': 'var(--color-popover)',
  '--xy-controls-button-background-color-hover': 'var(--color-accent)',
  '--xy-controls-button-color': 'var(--color-foreground)',
  '--xy-controls-button-border-color': 'var(--color-border)',
  '--xy-attribution-background-color': 'transparent'
} as React.CSSProperties

type Positioned = { id: string; position: { x: number; y: number } }

/**
 * Left to right by depth: a node sits one column after its deepest source, stacked within its column top-to-bottom as it
 * already was. `height` is the room a node takes in its column. A cycle is cut where the walk meets it again
 */
export function layered<N extends Positioned>(nodes: N[], edges: { source: string; target: string }[], { column, height }: { column: number; height: (node: N) => number }): N[] {
  const sources = new Map<string, string[]>()
  for (const edge of edges) if (edge.source !== edge.target) sources.set(edge.target, [...(sources.get(edge.target) ?? []), edge.source])
  const depth = new Map<string, number>()
  const walking = new Set<string>()
  const depthOf = (id: string): number => {
    const known = depth.get(id)
    if (known !== undefined) return known
    if (walking.has(id)) return -1
    walking.add(id)
    const value = Math.max(0, ...(sources.get(id) ?? []).map((source) => depthOf(source) + 1))
    walking.delete(id)
    depth.set(id, value)
    return value
  }
  const taken = new Map<number, number>()
  const placed = new Map<string, { x: number; y: number }>()
  for (const node of [...nodes].sort((a, b) => a.position.y - b.position.y)) {
    const level = depthOf(node.id)
    const y = taken.get(level) ?? 0
    taken.set(level, y + height(node))
    placed.set(node.id, { x: level * column, y })
  }
  return nodes.map((node) => ({ ...node, position: placed.get(node.id) ?? node.position }))
}

/**
 * Reorders each column of a `layered` layout so linked nodes sit level with each other, which uncrosses most links: every
 * sweep moves a node to the mean height of its links, alternating left-to-right and back
 */
export function untangle<N extends Positioned>(nodes: N[], edges: { source: string; target: string }[], height: (node: N) => number, sweeps = 6): N[] {
  const links = new Map<string, string[]>()
  for (const { source, target } of edges) {
    if (source === target) continue
    links.set(source, [...(links.get(source) ?? []), target])
    links.set(target, [...(links.get(target) ?? []), source])
  }
  const y = new Map(nodes.map((node) => [node.id, node.position.y]))
  const byX = new Map<number, N[]>()
  for (const node of nodes) byX.set(node.position.x, [...(byX.get(node.position.x) ?? []), node])
  const columns = [...byX].sort(([a], [b]) => a - b).map(([, column]) => column)
  const center = (node: N): number => {
    const around = (links.get(node.id) ?? []).map((id) => y.get(id) ?? 0)
    return around.length ? around.reduce((sum, value) => sum + value, 0) / around.length : (y.get(node.id) ?? 0)
  }
  for (let sweep = 0; sweep < sweeps; sweep++)
    for (const column of sweep % 2 ? [...columns].reverse() : columns) {
      let top = 0
      for (const [node] of column.map((node) => [node, center(node)] as const).sort((a, b) => a[1] - b[1])) {
        y.set(node.id, top)
        top += height(node)
      }
    }
  return nodes.map((node) => ({ ...node, position: { x: node.position.x, y: y.get(node.id) ?? node.position.y } }))
}
