/**
 * The plugin pages that stay mounted: the ones visited in this workspace, in tab order, with the active page always
 * among them. A page of a plugin switched off in the meantime is dropped, since there is nothing left to render.
 */
export function keptPages<T extends { id: string }>(tabs: T[], visited: string[], activeTab: string, shownElsewhere: string[] = []): T[] {
  const keep = new Set([...visited, activeTab])
  // Split panes and the overlay render their pages themselves, so keeping a second copy here would give that plugin two live pages
  return tabs.filter((tab) => keep.has(tab.id) && !shownElsewhere.includes(tab.id))
}

/** The pages visited in this workspace; another workspace's list is dropped in the same render, before its pages mount */
export function visitedIn(visited: { workspace: string; tabs: string[] }, workspaceId: string): string[] {
  return visited.workspace === workspaceId ? visited.tabs : []
}
