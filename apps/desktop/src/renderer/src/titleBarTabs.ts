import { isString, list, object } from '../../shared/json'

/** Page tab ids on each side of the title bar, in order */
export type TabLayout = { left: string[]; right: string[] }
export type TabSide = keyof TabLayout

/** Splits tabs, given in their default order, between the sides; tabs the layout doesn't name yet go last on the left */
export function arrangeTabs<T extends { id: string }>(tabs: T[], layout: TabLayout): Record<TabSide, T[]> {
  const pick = (ids: string[]): T[] => ids.flatMap((id) => tabs.filter((tab) => tab.id === id))
  const right = pick(layout.right.filter((id) => !layout.left.includes(id)))
  const placed = new Set([...layout.left, ...layout.right])
  return { left: [...pick(layout.left), ...tabs.filter((tab) => !placed.has(tab.id))], right }
}

/** Moves a tab before another one, or to the end of `side` when `beforeId` is null */
export function moveTab(arranged: TabLayout, id: string, side: TabSide, beforeId: string | null): TabLayout {
  const layout = { left: arranged.left.filter((other) => other !== id), right: arranged.right.filter((other) => other !== id) }
  const index = beforeId === null ? -1 : layout[side].indexOf(beforeId)
  layout[side].splice(index === -1 ? layout[side].length : index, 0, id)
  return layout
}

export const parseTabLayout = (value: unknown): TabLayout => {
  const ids = (key: TabSide): string[] => {
    return list(object(value)[key], isString)
  }
  return { left: ids('left'), right: ids('right') }
}
