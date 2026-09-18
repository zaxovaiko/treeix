import { useEffect, useState } from 'react'
import type { Branch, Repo, Worktree } from '../../shared/types'
import { Icon } from './Icon'
import { groupOpen, toggleIn, useSettings } from './settings'
import { EmptyState, IconButton, usePersisted } from './ui'
import { workspaceKey } from './workspaces'

export const baseName = (path: string): string => path.split('/').pop() ?? path
export const branchLabel = (worktree: Worktree): string => worktree.branch ?? `detached ${worktree.head}`
const parentDir = (path: string): string => path.slice(0, path.lastIndexOf('/'))

/** Folder or single-project filter, shared by the sidebar and the pull request list */
export type RepoScope = {
  folder: string
  focus: string
  setFolder: (folder: string) => void
  setFocus: (focus: string) => void
}

export const reposInScope = (repos: Repo[], { folder, focus }: Pick<RepoScope, 'folder' | 'focus'>): Repo[] =>
  repos.filter((repo) => (focus ? repo.path === focus : !folder || parentDir(repo.path) === folder))
export const branchAge = (branch: Branch): string => {
  const seconds = Math.max(0, Date.now() / 1000 - branch.committedAt)
  const units: [number, string][] = [[31_536_000, 'y'], [2_592_000, 'mo'], [604_800, 'w'], [86_400, 'd'], [3600, 'h'], [60, 'm']]
  const [size, unit] = units.find(([unitSeconds]) => seconds >= unitSeconds) ?? [1, 's']
  return `${Math.floor(seconds / size)}${unit}`
}

// ponytail: refetched when a group opens or a rescan ends; a file watcher on .git/refs would keep it live
const branchCache = new Map<string, Branch[]>()
/** Newest first, so the recent ones are what shows before expanding */
const BRANCH_PREVIEW = 12

/** Branches without a worktree, collapsed under each project; remote-only ones behind a toggle */
function BranchGroup({
  repo,
  needle,
  scanning,
  onOpen,
  onMenu
}: {
  repo: Repo
  needle: string
  scanning: boolean
  onOpen: (branch: Branch) => void
  onMenu: (event: React.MouseEvent, branch: Branch) => void
}): React.JSX.Element | null {
  const [branches, setBranches] = useState<Branch[] | null>(branchCache.get(repo.path) ?? null)
  const [toggled, setToggled] = usePersisted<boolean>(`sidebar.branches.${repo.path}`, false)
  const [showRemote, setShowRemote] = usePersisted<boolean>('sidebar.remoteBranches', false)
  const [showAll, setShowAll] = useState(false)
  const open = toggled !== (useSettings().sections === 'expanded') || Boolean(needle)

  useEffect(() => {
    if (scanning) return
    window.api.listBranches(repo.path).then((next) => {
      branchCache.set(repo.path, next)
      setBranches(next)
    }, () => undefined)
  }, [repo.path, scanning, repo.worktrees.length])

  const checkedOut = new Set(repo.worktrees.map((worktree) => worktree.branch))
  const local = (branches ?? []).filter((branch) => !branch.remote && !checkedOut.has(branch.name))
  const remote = (branches ?? []).filter((branch) => branch.remote)
  const shown = [...local, ...(showRemote ? remote : [])].filter((branch) => !needle || branch.name.toLowerCase().includes(needle))
  if (!branches || local.length + remote.length === 0 || (needle && shown.length === 0)) return null

  return (
    <div>
      <div className="group/branches flex h-6 items-center gap-1 pr-2 pl-7 text-[11px] text-muted-foreground">
        <button onClick={() => setToggled(!toggled)} className="flex min-w-0 flex-1 items-center gap-1 text-left tracking-wide uppercase hover:text-foreground">
          <Icon name="chevron" className={`size-3 transition-transform ${open ? 'rotate-90' : ''}`} />
          Branches
          <span className="tabular-nums normal-case">{showRemote ? local.length + remote.length : local.length}</span>
        </button>
        {remote.length > 0 && (
          <button
            title={showRemote ? 'Hide remote-only branches' : `Show ${remote.length} remote-only branches`}
            onClick={() => setShowRemote(!showRemote)}
            className={`rounded px-1 tabular-nums hover:text-foreground ${showRemote ? 'text-primary' : ''}`}
          >
            origin {remote.length}
          </button>
        )}
      </div>
      {open &&
        (showAll || needle ? shown : shown.slice(0, BRANCH_PREVIEW)).map((branch) => (
          <div
            key={branch.name}
            title={`${branch.name} · double-click to open as a worktree`}
            onDoubleClick={() => onOpen(branch)}
            onContextMenu={(event) => onMenu(event, branch)}
            className={`group/branch flex h-7 w-full items-center gap-2 rounded-md pr-1 pl-7 text-left text-foreground/55 hover:bg-accent hover:text-foreground ${
              branch.merged || branch.gone ? 'opacity-50' : ''
            }`}
          >
            <Icon name={branch.remote ? 'external' : 'branch'} className="size-3 shrink-0 opacity-70" />
            <span className="min-w-0 flex-1 truncate text-[13px]">{branch.name}</span>
            <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10.5px] tabular-nums group-hover/branch:hidden">
              {branch.merged ? <span className="font-sans text-violet-300">merged</span> : branch.gone ? <span className="font-sans">gone</span> : null}
              {branch.ahead > 0 && <span>↑{branch.ahead}</span>}
              {branch.behind > 0 && <span>↓{branch.behind}</span>}
              <span className="w-6 text-right font-sans">{branchAge(branch)}</span>
            </span>
            <button
              onClick={() => onOpen(branch)}
              className="hidden h-5 shrink-0 items-center gap-1 rounded px-1.5 text-[11px] ring-1 ring-input group-hover/branch:flex hover:bg-background"
            >
              <Icon name="plus" className="size-3" />
              Worktree
            </button>
          </div>
        ))}
      {open && !showAll && !needle && shown.length > BRANCH_PREVIEW && (
        <button onClick={() => setShowAll(true)} className="flex h-6 w-full items-center pl-12 text-left text-[11.5px] text-muted-foreground hover:text-foreground">
          Show {shown.length - BRANCH_PREVIEW} older branches
        </button>
      )}
    </div>
  )
}

const tildify = (path: string): string => (path.startsWith(window.api.home) ? `~${path.slice(window.api.home.length)}` : path)

export function Sidebar({
  repos,
  scanning,
  selected,
  activity,
  scope: { folder, focus, setFolder, setFocus },
  onSelect,
  onRescan,
  onRepoMenu,
  onWorktreeMenu,
  onBranchMenu,
  onOpenBranch,
  onNewWorktree,
  title = 'Projects',
  folderFilter = true
}: {
  scope: RepoScope
  repos: Repo[] | null
  scanning: boolean
  selected: string | null
  /** Agent session state per worktree path, shown as a dot */
  activity: Record<string, 'input' | 'running'>
  onSelect: (worktreePath: string) => void
  onRescan: () => void
  onRepoMenu: (event: React.MouseEvent, repo: Repo) => void
  onWorktreeMenu: (event: React.MouseEvent, worktree: Worktree, repo: Repo) => void
  onBranchMenu: (event: React.MouseEvent, branch: Branch, repo: Repo) => void
  /** Checks the branch out as a worktree */
  onOpenBranch: (branch: Branch, repo: Repo) => void
  onNewWorktree: (repo: Repo) => void
  /** Heading above the project list, e.g. the workspace name */
  title?: string
  /** Workspaces already pick their projects, so the folder filter only shows for All projects */
  folderFilter?: boolean
}): React.JSX.Element {
  const [query, setQuery] = usePersisted<string>(workspaceKey('sidebar.query'), '')
  const { sidebarBranches } = useSettings()
  const [changesOnly, setChangesOnly] = usePersisted<boolean>(workspaceKey('sidebar.changesOnly'), false)
  const [toggled, setToggled] = useState<Set<string>>(new Set())
  useSettings()

  const folders = [...new Set((repos ?? []).map((repo) => parentDir(repo.path)))].sort()
  const needle = query.trim().toLowerCase()
  const visibleRepos = reposInScope(repos ?? [], { folder, focus })
    .map((repo) => {
      const repoMatches = baseName(repo.path).toLowerCase().includes(needle)
      const worktrees = repo.worktrees.filter(
        (worktree) =>
          (!changesOnly || worktree.changedFiles > 0) &&
          (repoMatches || branchLabel(worktree).toLowerCase().includes(needle))
      )
      return { ...repo, worktrees }
    })
    .filter((repo) => repo.worktrees.length > 0)

  const toggleCollapsed = (repoPath: string): void => setToggled(toggleIn(toggled, repoPath))

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-col gap-1 px-2 pt-2 pb-2">
        <div className="flex items-center gap-1">
        <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg bg-muted px-2.5 text-muted-foreground ring-1 ring-border transition-shadow focus-within:ring-primary/60">
          <Icon name="search" className="size-3.5" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground/70"
          />
          {query && (
            <button
              title="Clear search"
              onClick={() => setQuery('')}
              className="inline-flex size-5 items-center justify-center rounded hover:text-foreground"
            >
              <Icon name="close" className="size-3" />
            </button>
          )}
          <button
            role="switch"
            aria-checked={changesOnly}
            title={changesOnly ? 'Showing worktrees with uncommitted changes · click to show all' : 'Only show worktrees with uncommitted changes'}
            onClick={() => setChangesOnly(!changesOnly)}
            className={`-mr-1 h-5 shrink-0 rounded px-1.5 text-[11px] transition-colors ${
              changesOnly ? 'bg-primary/20 text-primary ring-1 ring-primary/50' : 'hover:bg-accent hover:text-foreground'
            }`}
          >
            Changed
          </button>
        </label>
        <IconButton label="Rescan (r)" onClick={onRescan}>
          <Icon name="refresh" className={`size-3.5 ${scanning ? 'animate-spin' : ''}`} />
        </IconButton>
        </div>

        {folderFilter && (
        <div className="flex items-center gap-1.5">
          {folderFilter ? (
          <label
            title={focus ? 'Exit focus to filter by folder' : folder ? tildify(folder) : 'Filter by folder'}
            className={`relative flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-xs transition-colors ${
              focus ? 'opacity-40' : 'hover:bg-accent'
            } ${folder ? 'text-foreground' : 'text-muted-foreground'}`}
          >
            <Icon name="folder" className="size-3.5 text-muted-foreground" />
            <span className="truncate">{folder ? baseName(folder) : 'All folders'}</span>
            <Icon name="chevron" className="ml-auto size-3 rotate-90 text-muted-foreground/65" />
            <select
              value={folder}
              disabled={Boolean(focus)}
              onChange={(event) => setFolder(event.target.value)}
              className="absolute inset-0 cursor-pointer opacity-0 disabled:cursor-default"
            >
              <option value="">All folders</option>
              {folders.map((path) => (
                <option key={path} value={path}>
                  {tildify(path)}
                </option>
              ))}
            </select>
          </label>
          ) : null}
        </div>
        )}

        {focus && (
          <div className="flex h-7 items-center gap-2 rounded-md bg-primary/10 pr-1 pl-2 text-xs text-primary ring-1 ring-primary/30">
            <Icon name="focus" className="size-3.5" />
            <span className="truncate font-medium" title={focus}>
              {baseName(focus)}
            </span>
            <span className="flex-1" />
            <button
              title="Exit focus"
              onClick={() => setFocus('')}
              className="inline-flex size-5 items-center justify-center rounded hover:bg-primary/15"
            >
              <Icon name="close" className="size-3" />
            </button>
          </div>
        )}
      </div>

      <div className="mx-2 flex items-center justify-between border-t border-border px-2 pt-3 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        <span className="truncate">{title}</span>
        <span className="tabular-nums">{visibleRepos.length}</span>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {!repos && <EmptyState title="Scanning home folder..." />}
        {repos && visibleRepos.length === 0 && (
          <EmptyState title="No matching worktrees" />
        )}
        {visibleRepos.map((repo) => {
          const open = Boolean(focus) || Boolean(needle) || groupOpen(toggled, repo.path)
          return (
            <div key={repo.path} className="mb-0.5">
              <div className="group/row flex h-8 items-center rounded-md hover:bg-accent" onContextMenu={(event) => onRepoMenu(event, repo)}>
                <button
                  onClick={() => toggleCollapsed(repo.path)}
                  title={tildify(repo.path)}
                  className="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-1.5 text-left"
                >
                  <Icon
                    name="chevron"
                    className={`size-3 text-muted-foreground/65 transition-transform ${open ? 'rotate-90' : ''}`}
                  />
                  <Icon name="folder" className="size-3.5 text-muted-foreground" />
                  <span className="truncate text-[13px] text-foreground/90">{baseName(repo.path)}</span>
                </button>
                <button
                  title="New worktree or branch"
                  onClick={() => onNewWorktree(repo)}
                  className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground opacity-0 group-hover/row:opacity-100 hover:text-foreground"
                >
                  <Icon name="plus" className="size-3.5" />
                </button>
                <button
                  title={focus ? 'Exit focus' : 'Focus on this project'}
                  onClick={() => setFocus(focus ? '' : repo.path)}
                  className={`inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground ${
                    focus ? 'text-primary' : 'opacity-0 group-hover/row:opacity-100'
                  }`}
                >
                  <Icon name="focus" className="size-3.5" />
                </button>
                <span className="w-7 pr-2 text-right text-xs text-muted-foreground/55 tabular-nums">
                  {repo.worktrees.length}
                </span>
              </div>
              {open &&
                repo.worktrees.map((worktree) => {
                  const active = worktree.path === selected
                  return (
                    <button
                      key={worktree.path}
                      title={tildify(worktree.path)}
                      onClick={() => onSelect(worktree.path)}
                      onContextMenu={(event) => onWorktreeMenu(event, worktree, repo)}
                      className={`flex h-7 w-full items-center gap-2 rounded-md pr-2 pl-7 text-left transition-colors ${
                        active ? 'bg-accent text-foreground' : 'text-foreground/75 hover:bg-accent'
                      }`}
                    >
                      <Icon name="branch" className="size-3 text-muted-foreground" />
                      <span className="truncate text-[13px]">{branchLabel(worktree)}</span>
                      <span className="flex-1" />
                      {activity[worktree.path] && (
                        <span
                          title={activity[worktree.path] === 'input' ? 'An agent needs input' : 'An agent is running'}
                          className={`size-1.5 shrink-0 rounded-full ${
                            activity[worktree.path] === 'input' ? 'animate-pulse bg-amber-400' : 'bg-emerald-400'
                          }`}
                        />
                      )}
                      {worktree.changedFiles > 0 && (
                        <span className="text-[11px] text-amber-400 tabular-nums">{worktree.changedFiles}</span>
                      )}
                    </button>
                  )
                })}
              {open && sidebarBranches && (
                <BranchGroup
                  repo={repo}
                  needle={needle}
                  scanning={scanning}
                  onOpen={(branch) => onOpenBranch(branch, repo)}
                  onMenu={(event, branch) => onBranchMenu(event, branch, repo)}
                />
              )}
            </div>
          )
        })}
      </nav>
    </div>
  )
}
