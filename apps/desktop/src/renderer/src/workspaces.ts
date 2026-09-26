import { useSyncExternalStore } from 'react'
import type { Repo } from '../../shared/types'

export type Workspace = {
  id: string
  name: string
  color: string
  /** Replaces the initials on the avatar */
  avatarText?: string
  /** A small data URL drawn instead of the colour and text */
  avatarImage?: string
  repoPaths: string[]
  /** Project new terminals open in; unset means the folder holding all the workspace's projects */
  terminalPath?: string
}

/** Only used before any workspace exists, when every project shows */
export const ALL_PROJECTS = 'all'
export const WORKSPACE_COLORS = ['#4f5ff0', '#e0703d', '#10a37f', '#d946ef', '#eab308', '#64748b']

const KEY = 'workspaces'
const CURRENT_KEY = 'workspaces.current'
const RECENT_KEY = 'workspaces.recent'

type State = { workspaces: Workspace[]; currentId: string; recentIds: string[] }

const isWorkspace = (value: unknown): value is Workspace => {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    ['id', 'name', 'color'].every((key) => typeof candidate[key] === 'string') &&
    Array.isArray(candidate.repoPaths) &&
    candidate.repoPaths.every((path) => typeof path === 'string') &&
    ['terminalPath', 'avatarText', 'avatarImage'].every((key) => candidate[key] === undefined || typeof candidate[key] === 'string')
  )
}

export function parseWorkspaces(raw: string | null): Workspace[] {
  try {
    const stored: unknown = JSON.parse(raw ?? '[]')
    return Array.isArray(stored) ? stored.filter(isWorkspace) : []
  } catch {
    return []
  }
}

function parseRecentIds(raw: string | null): string[] {
  try {
    const stored: unknown = JSON.parse(raw ?? '[]')
    return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

function load(): State {
  // Absent in bun tests that import this module before stubbing storage
  if (typeof localStorage === 'undefined') return { workspaces: [], currentId: ALL_PROJECTS, recentIds: [] }
  const workspaces = parseWorkspaces(localStorage.getItem(KEY))
  const currentId = localStorage.getItem(CURRENT_KEY)
  return {
    workspaces,
    currentId: workspaces.some((workspace) => workspace.id === currentId) ? (currentId ?? ALL_PROJECTS) : (workspaces[0]?.id ?? ALL_PROJECTS),
    recentIds: parseRecentIds(localStorage.getItem(RECENT_KEY))
  }
}

let state = load()
const listeners = new Set<() => void>()

function commit(next: State): void {
  state = next
  localStorage.setItem(KEY, JSON.stringify(next.workspaces))
  localStorage.setItem(CURRENT_KEY, next.currentId)
  localStorage.setItem(RECENT_KEY, JSON.stringify(next.recentIds))
  listeners.forEach((listener) => listener())
}

export const getCurrentWorkspaceId = (): string => state.currentId

/** A storage key for UI state that each workspace keeps separately, like filters and the open tab */
export const workspaceKey = (key: string, workspaceId = state.currentId): string => `${key}@${workspaceId}`

export const useWorkspaces = (): State =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => state
  )

export const setCurrentWorkspace = (id: string): void => commit({ ...state, currentId: id, recentIds: [id, ...state.recentIds.filter((candidate) => candidate !== id)] })

/** Workspaces other than `currentId`, most recently switched to first; ones never visited keep rail order at the end */
export function recentWorkspaces({ workspaces, currentId, recentIds }: State): Workspace[] {
  const others = workspaces.filter((workspace) => workspace.id !== currentId)
  return [...others].sort((a, b) => {
    const [indexA, indexB] = [recentIds.indexOf(a.id), recentIds.indexOf(b.id)]
    if (indexA === -1 && indexB === -1) return 0
    if (indexA === -1) return 1
    if (indexB === -1) return -1
    return indexA - indexB
  })
}

export function saveWorkspace(workspace: Workspace): void {
  const exists = state.workspaces.some((candidate) => candidate.id === workspace.id)
  commit({
    ...state,
    // The first workspace replaces the implicit everything view
    currentId: state.workspaces.length === 0 ? workspace.id : state.currentId,
    workspaces: exists
      ? state.workspaces.map((candidate) => (candidate.id === workspace.id ? workspace : candidate))
      : [...state.workspaces, workspace]
  })
}

/** Moves a workspace so it sits before `beforeId`, or last when that is null; order also sets the ⌥⌘1-9 shortcuts */
export const reorderWorkspaces = (workspaces: Workspace[], id: string, beforeId: string | null): Workspace[] => {
  const moved = workspaces.find((workspace) => workspace.id === id)
  if (!moved || id === beforeId) return workspaces
  const rest = workspaces.filter((workspace) => workspace.id !== id)
  const index = beforeId === null ? rest.length : rest.findIndex((workspace) => workspace.id === beforeId)
  return index === -1 ? workspaces : [...rest.slice(0, index), moved, ...rest.slice(index)]
}

export const moveWorkspace = (id: string, beforeId: string | null): void =>
  commit({ ...state, workspaces: reorderWorkspaces(state.workspaces, id, beforeId) })

export function deleteWorkspace(id: string): void {
  const workspaces = state.workspaces.filter((workspace) => workspace.id !== id)
  commit({ ...state, workspaces, currentId: state.currentId === id ? (workspaces[0]?.id ?? ALL_PROJECTS) : state.currentId, recentIds: state.recentIds.filter((candidate) => candidate !== id) })
}

export function addRepoToWorkspace(id: string, repoPath: string): void {
  const workspace = state.workspaces.find((candidate) => candidate.id === id)
  if (workspace && !workspace.repoPaths.includes(repoPath)) saveWorkspace({ ...workspace, repoPaths: [...workspace.repoPaths, repoPath] })
}

const SUGGESTED_NAMES = 3

/** ["/p/openora", "/p/betfeel"] becomes "Openora + Betfeel"; longer lists end with "+ N more" */
export function suggestWorkspaceName(repoPaths: string[]): string {
  const names = repoPaths.map((path) => {
    const name = path.split('/').pop() ?? path
    return name.charAt(0).toUpperCase() + name.slice(1)
  })
  if (names.length <= SUGGESTED_NAMES) return names.join(' + ')
  return `${names.slice(0, SUGGESTED_NAMES - 1).join(' + ')} + ${names.length - SUGGESTED_NAMES + 1} more`
}

/** "Openora + Betfeel" becomes OB, "ariex" becomes AR */
export function initials(name: string): string {
  const words = name.match(/[\p{L}\p{N}]+/gu) ?? []
  const letters = words.length > 1 ? words.slice(0, 2).map((word) => word[0]) : [...(words[0] ?? '?').slice(0, 2)]
  return letters.join('').toUpperCase()
}

const SHADE_STEPS = [-0.5, -0.25, 0, 0.25, 0.5]

/** `#rrggbb` mixed towards black (negative steps) and white (positive), darkest first, the colour itself in the middle */
export function shades(hex: string): string[] {
  const channels = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16))
  return SHADE_STEPS.map((step) => {
    const mixed = channels.map((channel) => Math.round(step < 0 ? channel * (1 + step) : channel + (255 - channel) * step))
    return `#${mixed.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
  })
}

/** Repos of a workspace, or every repo for All projects */
export const reposOf = (workspace: Workspace | undefined, repos: Repo[]): Repo[] =>
  workspace ? repos.filter((repo) => workspace.repoPaths.includes(repo.path)) : repos

const containsWorktree = (workspace: Workspace, repos: Repo[] | null, worktreePath: string): boolean =>
  reposOf(workspace, repos ?? []).some((repo) => repo.worktrees.some((worktree) => worktree.path === worktreePath))

/**
 * Each session belongs to exactly one workspace: the one it was started in. Sessions whose workspace
 * is gone (or that predate workspaces) move to the first workspace holding their worktree, else the first one.
 */
export function inWorkspace(
  session: { worktreePath: string; workspaceId: string },
  workspace: Workspace | undefined,
  repos: Repo[] | null,
  workspaces: Workspace[]
): boolean {
  if (!workspace) return true
  if (workspaces.some((candidate) => candidate.id === session.workspaceId)) return session.workspaceId === workspace.id
  // With no record of where it started, it belongs to the narrowest workspace holding the checkout, e.g. "Betfeel" over "Betfeel + Openora"
  const owner = workspaces.filter((candidate) => containsWorktree(candidate, repos, session.worktreePath)).sort((a, b) => a.repoPaths.length - b.repoPaths.length)[0] ?? workspaces[0]
  return owner?.id === workspace.id
}

/** Deepest folder containing every path; a single path is its own root */
export function commonFolder(paths: string[]): string {
  if (paths.length === 0) return ''
  if (paths.length === 1) return paths[0]
  const [first, ...rest] = paths.map((path) => path.split('/'))
  let depth = 0
  while (depth < first.length && rest.every((parts) => parts[depth] === first[depth])) depth++
  return first.slice(0, depth).join('/')
}
