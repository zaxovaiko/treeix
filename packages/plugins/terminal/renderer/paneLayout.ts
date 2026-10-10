/** Terminal panes as columns of stacked rows */
export type PaneLayout = string[][]
export type SplitEdge = 'right' | 'bottom'

export const removePane = (layout: PaneLayout, id: string): PaneLayout => layout.map((column) => column.filter((pane) => pane !== id)).filter((column) => column.length > 0)

/** Places `id` beside `targetId`: right opens a column after the target's, bottom stacks under it in its column */
export function placePane(layout: PaneLayout, id: string, targetId: string, edge: SplitEdge): PaneLayout {
  if (id === targetId) return layout
  const rest = removePane(layout, id)
  const columnIndex = rest.findIndex((column) => column.includes(targetId))
  if (columnIndex === -1) return [...rest, [id]]
  const next = rest.map((column) => [...column])
  if (edge === 'right') next.splice(columnIndex + 1, 0, [id])
  else next[columnIndex].splice(next[columnIndex].indexOf(targetId) + 1, 0, id)
  return next
}
