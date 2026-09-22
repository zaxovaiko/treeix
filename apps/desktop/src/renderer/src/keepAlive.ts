/**
 * The plugin pages that stay mounted: the ones visited in this workspace, in tab order, with the active page always
 * among them. A page of a plugin switched off in the meantime is dropped, since there is nothing left to render.
 */
export function keptPages<T extends { id: string }>(tabs: T[], visited: string[], activeTab: string, splitTab: string | null = null): T[] {
  const keep = new Set([...visited, activeTab])
  // The split pane renders its page itself, so keeping a second copy here would give that plugin two live pages
  return tabs.filter((tab) => keep.has(tab.id) && tab.id !== splitTab)
}

/** The pages visited in this workspace; another workspace's list is dropped in the same render, before its pages mount */
export function visitedIn(visited: { workspace: string; tabs: string[] }, workspaceId: string): string[] {
  return visited.workspace === workspaceId ? visited.tabs : []
}

/**
 * The page bare keys belong to. Pages kept mounted off screen still have their key listeners on the window, so every
 * page compares this against its own id; with a split open the side holding the keyboard wins.
 */
export function keyboardPage(activeTab: string, splitPage: string | null, splitFocused: boolean): string {
  return splitPage && splitFocused ? splitPage : activeTab
}
