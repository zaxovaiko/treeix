/**
 * The plugin pages that stay mounted: the ones visited in this workspace, in tab order, with the active page always
 * among them. A page of a plugin switched off in the meantime is dropped, since there is nothing left to render.
 */
export function keptPages<T extends { id: string }>(tabs: T[], visited: string[], activeTab: string): T[] {
  const keep = new Set([...visited, activeTab])
  return tabs.filter((tab) => keep.has(tab.id))
}
