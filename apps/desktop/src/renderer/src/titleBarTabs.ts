import { isString, list, object } from '../../shared/json'

/** The title bar row, Safari style: page tab ids, the search field and two flexible spaces, in order */
export type BarLayout = string[]

/** The one page tab the app brings itself; plugins bring the rest */
export const WORKTREES_TAB = { id: 'worktrees', label: 'Worktrees', icon: 'branch', order: 30 } as const

/** Items every title bar has; plugin tab ids never contain a colon, so these can't clash with one */
export const SEARCH_ITEM = 'bar:search'
export const SPACE_ITEMS = ['bar:space-left', 'bar:space-right'] as const
const FIXED_ITEMS: string[] = [SPACE_ITEMS[0], SEARCH_ITEM, SPACE_ITEMS[1]]

export const isSpace = (id: string): boolean => (SPACE_ITEMS as readonly string[]).includes(id)

/** The row in order: tabs and fixed items the layout names, then any fixed item it lacks; tabs it doesn't name yet go before the first space */
export function arrangeBar(tabIds: string[], layout: BarLayout): string[] {
  const known = new Set([...tabIds, ...FIXED_ITEMS])
  const placed = layout.filter((id, index) => known.has(id) && layout.indexOf(id) === index)
  const order = [...placed, ...FIXED_ITEMS.filter((id) => !placed.includes(id))]
  order.splice(order.indexOf(SPACE_ITEMS[0]), 0, ...tabIds.filter((id) => !placed.includes(id)))
  return order
}

/** Moves an item before another one, or to the end when `beforeId` is null */
export function moveItem(order: string[], id: string, beforeId: string | null): string[] {
  const next = order.filter((other) => other !== id)
  const index = beforeId === null ? -1 : next.indexOf(beforeId)
  next.splice(index === -1 ? next.length : index, 0, id)
  return next
}

/** A stored row; the older left and right sides read as the left tabs, the search between spaces, then the right tabs */
export const parseBarLayout = (value: unknown): BarLayout => {
  if (Array.isArray(value)) return list(value, isString)
  const sides = object(value)
  const left = list(sides.left, isString)
  const right = list(sides.right, isString)
  return left.length || right.length ? [...left, ...FIXED_ITEMS, ...right] : []
}
