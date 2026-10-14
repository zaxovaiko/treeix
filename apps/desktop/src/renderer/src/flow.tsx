/** React Flow pieces several canvases share: the app-themed colors, the layouts and the controls */
import { useState } from 'react'
import { ControlButton, Controls, useReactFlow, useStore } from '@xyflow/react'
import { Icon } from './Icon'
import { Popup } from './ui'

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
type Link = { source: string; target: string }

/**
 * Left to right by depth: a node sits one column after its deepest source, stacked within its column top-to-bottom as it
 * already was. `height` is the room a node takes in its column. A cycle is cut where the walk meets it again
 */
export function layered<N extends Positioned>(nodes: N[], edges: Link[], { column, height }: { column: number; height: (node: N) => number }): N[] {
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

type Point = { x: number; y: number }
const turn = (a: Point, b: Point, c: Point): number => Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x))

/** Links drawn as straight lines between node middles that cross; links sharing a node never count */
export function crossings(edges: Link[], at: (id: string) => Point | undefined): number {
  const lines = edges.flatMap(({ source, target }) => {
    const [from, to] = [at(source), at(target)]
    return from && to && source !== target ? [{ source, target, from, to }] : []
  })
  let count = 0
  // ponytail: every pair, fine for a few hundred links; a sweep line if graphs grow to thousands
  for (let i = 0; i < lines.length; i++)
    for (let j = i + 1; j < lines.length; j++) {
      const [a, b] = [lines[i], lines[j]]
      if (a.source === b.source || a.source === b.target || a.target === b.source || a.target === b.target) continue
      if (turn(a.from, a.to, b.from) * turn(a.from, a.to, b.to) < 0 && turn(b.from, b.to, a.from) * turn(b.from, b.to, a.to) < 0) count++
    }
  return count
}

/**
 * Reorders each column of a `layered` layout so linked nodes sit level with each other: every sweep moves a node to the
 * mean height of its links, alternating left-to-right and back, and the order with the fewest crossings is kept
 */
export function untangle<N extends Positioned>(nodes: N[], edges: Link[], height: (node: N) => number, sweeps = 12): N[] {
  const links = new Map<string, string[]>()
  for (const { source, target } of edges) {
    if (source === target) continue
    links.set(source, [...(links.get(source) ?? []), target])
    links.set(target, [...(links.get(target) ?? []), source])
  }
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const y = new Map(nodes.map((node) => [node.id, node.position.y]))
  const middle = (id: string): Point | undefined => {
    const node = byId.get(id)
    return node && { x: node.position.x, y: (y.get(id) ?? 0) + height(node) / 2 }
  }
  const columns = columnsOf(nodes)
  const center = (node: N): number => {
    const around = (links.get(node.id) ?? []).map((id) => y.get(id) ?? 0)
    return around.length ? around.reduce((sum, value) => sum + value, 0) / around.length : (y.get(node.id) ?? 0)
  }
  let best = new Map(y)
  let fewest = crossings(edges, middle)
  for (let sweep = 0; sweep < sweeps && fewest > 0; sweep++) {
    for (const column of sweep % 2 ? [...columns].reverse() : columns) {
      let top = 0
      for (const [node] of column.map((node) => [node, center(node)] as const).sort((a, b) => a[1] - b[1])) {
        y.set(node.id, top)
        top += height(node)
      }
    }
    const count = crossings(edges, middle)
    if (count < fewest) [best, fewest] = [new Map(y), count]
  }
  return nodes.map((node) => ({ ...node, position: { x: node.position.x, y: best.get(node.id) ?? node.position.y } }))
}

/** Nodes grouped by column, left to right, each top to bottom */
const columnsOf = <N extends Positioned>(nodes: N[]): N[][] => {
  const byX = new Map<number, N[]>()
  for (const node of nodes) byX.set(node.position.x, [...(byX.get(node.position.x) ?? []), node])
  return [...byX].sort(([a], [b]) => a - b).map(([, column]) => column.sort((a, b) => a.position.y - b.position.y))
}

export const LAYOUTS = [
  { id: 'fit', label: 'Fit the screen' },
  { id: 'horizontal', label: 'Left to right' },
  { id: 'vertical', label: 'Top to bottom' },
  { id: 'grid', label: 'Grid' },
  { id: 'circle', label: 'Circle' }
] as const
export type Layout = (typeof LAYOUTS)[number]['id']

/** Tried column heights between the tallest node and the tallest column */
const WRAP_STEPS = 24

type Placement = { placed: Map<string, Point>; width: number; height: number }

/**
 * `layered` and `untangle`, then arranged as `layout` asks: `fit` wraps each column into as many side-by-side columns as
 * fill a canvas `aspect` wide per unit of height at the largest zoom, `vertical` turns the columns into rows, `grid` fills
 * rows in that order with as many per row as fill the canvas best, `circle` rings them in that order, neighbours a column apart
 */
export function prettify<N extends Positioned>(
  nodes: N[],
  edges: Link[],
  { column, height, aspect, layout = 'fit' }: { column: number; height: (node: N) => number; aspect: number; layout?: Layout }
): N[] {
  if (!nodes.length) return nodes
  const untangled = untangle(layered(nodes, edges, { column, height }), edges, height)
  if (layout === 'horizontal') return untangled
  const levels = columnsOf(untangled)
  const zoom = ({ width, height: tall }: Placement): number => Math.min(aspect / width, 1 / tall)
  const biggest = (tries: Placement[]): Placement => tries.reduce((best, next) => (zoom(next) > zoom(best) ? next : best))
  const rows = (lines: N[][]): Placement => {
    const placed = new Map<string, Point>()
    const widest = Math.max(...lines.map((line) => line.length))
    let y = 0
    for (const line of lines) {
      // Centered under the widest row
      line.forEach((node, index) => placed.set(node.id, { x: (index + (widest - line.length) / 2) * column, y }))
      y += Math.max(...line.map(height))
    }
    return { placed, width: widest * column, height: y }
  }
  const wrap = (limit: number): Placement => {
    const placed = new Map<string, Point>()
    let lane = 0
    let tallest = 0
    for (const level of levels) {
      let y = 0
      for (const node of level) {
        if (y > 0 && y + height(node) > limit) [lane, y] = [lane + 1, 0]
        placed.set(node.id, { x: lane * column, y })
        y += height(node)
        tallest = Math.max(tallest, y)
      }
      lane++
    }
    return { placed, width: lane * column, height: tallest }
  }
  const ring = (order: N[]): Placement => {
    // The chord between neighbours clears the widest and tallest node
    const gap = Math.max(column, ...order.map(height))
    const radius = order.length > 1 ? gap / (2 * Math.sin(Math.PI / order.length)) : 0
    const placed = new Map<string, Point>()
    order.forEach((node, index) => {
      const angle = (2 * Math.PI * index) / order.length - Math.PI / 2
      placed.set(node.id, { x: radius * (1 + Math.cos(angle)), y: radius * (1 + Math.sin(angle)) - height(node) / 2 })
    })
    return { placed, width: 2 * radius + column, height: 2 * radius + gap }
  }
  const chosen = (() => {
    if (layout === 'vertical') return rows(levels)
    if (layout === 'circle') return ring(levels.flat())
    if (layout === 'grid') {
      const order = levels.flat()
      return biggest(
        order.map((_, index) => rows(Array.from({ length: Math.ceil(order.length / (index + 1)) }, (_, row) => order.slice(row * (index + 1), (row + 1) * (index + 1)))))
      )
    }
    const tallestLevel = Math.max(...levels.map((level) => level.reduce((sum, node) => sum + height(node), 0)))
    const tallestNode = Math.max(...nodes.map(height))
    return biggest([tallestLevel, ...Array.from({ length: WRAP_STEPS }, (_, step) => tallestNode + ((tallestLevel - tallestNode) * step) / WRAP_STEPS)].map(wrap))
  })()
  return nodes.map((node) => ({ ...node, position: chosen.placed.get(node.id) ?? node.position }))
}

/** React Flow's zoom buttons plus a layout menu, which arranges the graph and zooms to fit it */
export function FlowControls({ onLayout }: { onLayout: (view: { layout: Layout; aspect: number }) => void }): React.JSX.Element {
  const { fitView } = useReactFlow()
  const aspect = useStore((state) => state.width / Math.max(1, state.height))
  // Where the menu opens: the button, measured when clicked
  const [open, setOpen] = useState<DOMRect | null>(null)
  return (
    <Controls showInteractive={false}>
      <ControlButton title="Prettify" aria-label="Prettify" aria-expanded={open !== null} onClick={(event) => setOpen(open ? null : event.currentTarget.getBoundingClientRect())}>
        <Icon name="wand" />
      </ControlButton>
      {open && (
        <Popup anchor={open} align="beside" onDismiss={() => setOpen(null)} className="w-40 rounded-lg border border-input bg-popover p-1 text-xs text-foreground">
          {LAYOUTS.map(({ id, label }) => (
            <button
              key={id}
              className="block w-full rounded-md px-2 py-1 text-left hover:bg-accent"
              onClick={() => {
                setOpen(null)
                onLayout({ layout: id, aspect })
                // Fitted once the new positions have rendered
                requestAnimationFrame(() => void fitView({ duration: 200 }))
              }}
            >
              {label}
            </button>
          ))}
        </Popup>
      )}
    </Controls>
  )
}
