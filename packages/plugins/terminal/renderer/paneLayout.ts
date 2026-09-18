/** Terminal panes as columns of stacked rows */
export type PaneLayout = string[][]
export type DropEdge = 'left' | 'right' | 'top' | 'bottom'

export const MAX_PANES = 6
const MAX_COLUMNS = 3

const without = (layout: PaneLayout, id: string): PaneLayout =>
  layout.map((column) => column.filter((pane) => pane !== id)).filter((column) => column.length > 0)

/** Drops the newest pane that is not `keep` until the layout fits */
function fit(layout: PaneLayout, keep: string): PaneLayout {
  let next = layout
  while (next.flat().length > MAX_PANES) {
    const victim = [...next.flat()].reverse().find((pane) => pane !== keep)
    if (!victim) break
    next = without(next, victim)
  }
  return next
}

/** New panes open as a column, or stack under the shortest column once there are enough columns */
export function addPane(layout: PaneLayout, id: string): PaneLayout {
  if (layout.flat().includes(id)) return layout
  if (layout.length < MAX_COLUMNS) return fit([...layout, [id]], id)
  const shortest = layout.reduce((best, column, index) => (column.length < layout[best].length ? index : best), 0)
  return fit(
    layout.map((column, index) => (index === shortest ? [...column, id] : column)),
    id
  )
}

export const removePane = without

/** Renames panes through `rename`, dropping those it maps to undefined, e.g. sessions that did not come back */
export const remapPanes = (layout: PaneLayout, rename: (id: string) => string | undefined): PaneLayout =>
  layout.map((column) => column.map(rename).filter((id) => id !== undefined)).filter((column) => column.length > 0)

/** Places `id` beside `targetId`: left and right split columns, top and bottom stack within the column */
export function placePane(layout: PaneLayout, id: string, targetId: string, edge: DropEdge): PaneLayout {
  if (id === targetId) return layout
  const rest = without(layout, id)
  const columnIndex = rest.findIndex((column) => column.includes(targetId))
  if (columnIndex === -1) return addPane(rest, id)
  const next = rest.map((column) => [...column])
  if (edge === 'left' || edge === 'right') {
    next.splice(columnIndex + (edge === 'right' ? 1 : 0), 0, [id])
  } else {
    const column = next[columnIndex]
    column.splice(column.indexOf(targetId) + (edge === 'bottom' ? 1 : 0), 0, id)
  }
  return fit(next, id)
}

/** The pane beside `id` in a direction; left and right land on the row at the same height in the next column */
export function neighborPane(layout: PaneLayout, id: string, direction: DropEdge): string | null {
  const columnIndex = layout.findIndex((column) => column.includes(id))
  if (columnIndex === -1) return null
  const rowIndex = layout[columnIndex].indexOf(id)
  if (direction === 'top' || direction === 'bottom') return layout[columnIndex][rowIndex + (direction === 'bottom' ? 1 : -1)] ?? null
  const column = layout[columnIndex + (direction === 'right' ? 1 : -1)]
  if (!column) return null
  const height = (rowIndex + 0.5) / layout[columnIndex].length
  return column[Math.min(column.length - 1, Math.floor(height * column.length))]
}

/** Nearest edge of the hovered pane; single-column layouts only split vertically */
export function edgeAt(x: number, y: number, width: number, height: number, allowColumns: boolean): DropEdge {
  const dx = x / width - 0.5
  const dy = y / height - 0.5
  if (!allowColumns || Math.abs(dy) > Math.abs(dx)) return dy < 0 ? 'top' : 'bottom'
  return dx < 0 ? 'left' : 'right'
}
