import { expect, test } from 'bun:test'

globalThis.localStorage ??= { getItem: () => null, setItem: () => undefined } as unknown as Storage

test('workspace helpers', async () => {
  const { initials, inWorkspace, parseWorkspaces, reposOf, suggestWorkspaceName } = await import('./workspaces')
  expect(suggestWorkspaceName([])).toBe('')
  expect(suggestWorkspaceName(['/p/openora', '/p/betfeel'])).toBe('Openora + Betfeel')
  expect(suggestWorkspaceName(['/p/a', '/p/b', '/p/c', '/p/d'])).toBe('A + B + 2 more')
  expect(initials('Openora + Betfeel')).toBe('OB')
  expect(initials('ariex')).toBe('AR')
  expect(initials('  ')).toBe('?')

  const workspace = { id: 'w1', name: 'Client', color: '#fff', repoPaths: ['/r/openora'] }
  expect(parseWorkspaces(JSON.stringify([workspace, { id: 1 }]))).toEqual([workspace])
  expect(parseWorkspaces('broken')).toEqual([])

  const repos = [
    { path: '/r/openora', worktrees: [{ path: '/r/openora/.claude/worktrees/a', head: '1', branch: 'a', changedFiles: 0 }] },
    { path: '/r/ariex', worktrees: [{ path: '/r/ariex', head: '2', branch: 'main', changedFiles: 0 }] }
  ]
  expect(reposOf(workspace, repos).map((repo) => repo.path)).toEqual(['/r/openora'])
  expect(reposOf(undefined, repos)).toHaveLength(2)
  const other = { id: 'w2', name: 'Other', color: '#000', repoPaths: ['/r/openora', '/r/ariex'] }
  const all = [workspace, other]
  // Started in a workspace: only there, even when another one holds the same worktree
  expect(inWorkspace({ worktreePath: '/r/openora', workspaceId: 'w2' }, workspace, repos, all)).toBe(false)
  expect(inWorkspace({ worktreePath: '/Users/me', workspaceId: 'w1' }, workspace, repos, all)).toBe(true)
  // Orphans go to the narrowest workspace holding the worktree, else the first workspace
  expect(inWorkspace({ worktreePath: '/r/openora/.claude/worktrees/a', workspaceId: 'all' }, workspace, repos, [other, workspace])).toBe(true)
  expect(inWorkspace({ worktreePath: '/r/openora/.claude/worktrees/a', workspaceId: 'all' }, other, repos, [other, workspace])).toBe(false)
  expect(inWorkspace({ worktreePath: '/r/ariex', workspaceId: 'all' }, other, repos, all)).toBe(true)
  expect(inWorkspace({ worktreePath: '/r/ariex', workspaceId: 'all' }, workspace, repos, all)).toBe(false)
  expect(inWorkspace({ worktreePath: '/Users/me', workspaceId: 'gone' }, workspace, repos, all)).toBe(true)
  expect(inWorkspace({ worktreePath: '/r/ariex', workspaceId: 'all' }, undefined, repos, [])).toBe(true)
})

test('reorderWorkspaces moves before a target or to the end', async () => {
  const { reorderWorkspaces } = await import('./workspaces')
  const list = ['a', 'b', 'c'].map((id) => ({ id, name: id, color: '#000', repoPaths: [] }))
  const ids = (workspaces: { id: string }[]) => workspaces.map((workspace) => workspace.id).join('')
  expect(ids(reorderWorkspaces(list, 'c', 'a'))).toBe('cab')
  expect(ids(reorderWorkspaces(list, 'a', null))).toBe('bca')
  expect(ids(reorderWorkspaces(list, 'b', 'b'))).toBe('abc')
  expect(ids(reorderWorkspaces(list, 'x', 'a'))).toBe('abc')
})

test('commonFolder finds the folder holding all projects', async () => {
  const { commonFolder } = await import('./workspaces')
  expect(commonFolder(['/u/oss/betfeel', '/u/oss/openora', '/u/oss/infra'])).toBe('/u/oss')
  expect(commonFolder(['/u/oss/betfeel'])).toBe('/u/oss/betfeel')
  expect(commonFolder(['/u/oss-a/x', '/u/oss-b/y'])).toBe('/u')
  expect(commonFolder(['/a', '/b'])).toBe('')
  expect(commonFolder([])).toBe('')
})
