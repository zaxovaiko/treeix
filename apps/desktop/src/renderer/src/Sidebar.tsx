import { useEffect, useRef, useState } from 'react'
import { focusZone, isPageKey, useListNav, useZone, type ZoneId } from '@treeix/sdk'
import type { Branch, Repo, Worktree } from '../../shared/types'
import { copyText } from './contextMenu'
import { Icon } from './Icon'
import { groupOpen, toggleIn, useSettings } from './settings'
import { EmptyState, FoldAllButton, IconButton, readStored, usePersisted } from './ui'
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

/** A zone's title row; the label brightens while the zone has focus */
export function ZoneHeader({ zone, title, children }: { zone: ZoneId; title: string; children?: React.ReactNode }): React.JSX.Element {
  const focused = useZone().zone === zone
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border pr-1 pl-3">
      <span className={`min-w-0 truncate text-[11px] font-semibold tracking-wide uppercase ${focused ? 'text-foreground' : 'text-muted-foreground'}`}>{title}</span>
      <span className="flex-1" />
      {children}
    </div>
  )
}

// ponytail: refetched when a group opens or a rescan ends; a file watcher on .git/refs would keep it live
const branchCache = new Map<string, Branch[]>()
/** Newest first, so the recent ones are what shows before expanding */
const BRANCH_PREVIEW = 12
const branchGroupKey = (repoPath: string): string => `sidebar.branches.${repoPath}`

type Row =
  | { key: string; kind: 'repo'; repo: Repo }
  | { key: string; kind: 'worktree'; repo: Repo; worktree: Worktree }
  | { key: string; kind: 'branches'; repo: Repo; local: number; remote: number }
  | { key: string; kind: 'branch'; repo: Repo; branch: Branch }
  | { key: string; kind: 'older'; repo: Repo; count: number }

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
  onTerminal,
  onFlash,
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
  /** A terminal in this folder: its session if there is one, else a new shell */
  onTerminal: (path: string) => void
  onFlash: (message: string) => void
  /** Workspaces already pick their projects, so the folder filter only shows for All projects */
  folderFilter?: boolean
}): React.JSX.Element {
  const [query, setQuery] = usePersisted<string>(workspaceKey('sidebar.query'), '')
  const { sidebarBranches, sections } = useSettings()
  const [changesOnly, setChangesOnly] = usePersisted<boolean>(workspaceKey('sidebar.changesOnly'), false)
  const [toggled, setToggled] = useState<Set<string>>(new Set())
  const [branches, setBranches] = useState<Record<string, Branch[]>>(() => Object.fromEntries(branchCache))
  const [branchToggles, setBranchToggles] = useState<Record<string, boolean>>({})
  const [showRemote, setShowRemote] = usePersisted<boolean>('sidebar.remoteBranches', false)
  const [showAll, setShowAll] = useState<Set<string>>(new Set())
  const [cursorKey, setCursorKey] = useState<string | null>(selected && `wt:${selected}`)
  const { zone } = useZone()
  useEffect(() => void (selected && setCursorKey(`wt:${selected}`)), [selected])

  const folders = [...new Set((repos ?? []).map((repo) => parentDir(repo.path)))].sort()
  const needle = query.trim().toLowerCase()
  const visibleRepos = reposInScope(repos ?? [], { folder, focus })
    .map((repo) => {
      const repoMatches = baseName(repo.path).toLowerCase().includes(needle)
      const worktrees = repo.worktrees.filter((worktree) => (!changesOnly || worktree.changedFiles > 0) && (repoMatches || branchLabel(worktree).toLowerCase().includes(needle)))
      return { ...repo, worktrees }
    })
    .filter((repo) => repo.worktrees.length > 0)
  const repoOpen = (repo: Repo): boolean => Boolean(focus) || Boolean(needle) || groupOpen(toggled, repo.path)
  const openRepoPaths = sidebarBranches ? visibleRepos.filter(repoOpen).map((repo) => repo.path) : []

  useEffect(() => {
    if (scanning) return
    for (const path of openRepoPaths) {
      window.api.listBranches(path).then((next) => {
        branchCache.set(path, next)
        setBranches((current) => ({ ...current, [path]: next }))
      }, () => undefined)
    }
  }, [openRepoPaths.join('\n'), scanning])

  const branchGroupOpen = (repoPath: string): boolean => (branchToggles[repoPath] ?? readStored(branchGroupKey(repoPath)) === true) !== (sections === 'expanded') || Boolean(needle)
  const toggleBranchGroup = (repoPath: string): void => {
    const next = !(branchToggles[repoPath] ?? readStored(branchGroupKey(repoPath)) === true)
    localStorage.setItem(branchGroupKey(repoPath), JSON.stringify(next))
    setBranchToggles({ ...branchToggles, [repoPath]: next })
  }

  const branchRows = (repo: Repo): Row[] => {
    const all = branches[repo.path]
    if (!all) return []
    const checkedOut = new Set(repo.worktrees.map((worktree) => worktree.branch))
    const local = all.filter((branch) => !branch.remote && !checkedOut.has(branch.name))
    const remote = all.filter((branch) => branch.remote)
    const shown = [...local, ...(showRemote ? remote : [])].filter((branch) => !needle || branch.name.toLowerCase().includes(needle))
    if (local.length + remote.length === 0 || (needle && shown.length === 0)) return []
    const header: Row = { key: `branches:${repo.path}`, kind: 'branches', repo, local: local.length, remote: remote.length }
    if (!branchGroupOpen(repo.path)) return [header]
    const everything = showAll.has(repo.path) || Boolean(needle)
    const listed = everything ? shown : shown.slice(0, BRANCH_PREVIEW)
    return [
      header,
      ...listed.map((branch): Row => ({ key: `branch:${repo.path}:${branch.name}`, kind: 'branch', repo, branch })),
      ...(!everything && shown.length > BRANCH_PREVIEW ? [{ key: `older:${repo.path}`, kind: 'older', repo, count: shown.length - BRANCH_PREVIEW } satisfies Row] : [])
    ]
  }

  const rows: Row[] = visibleRepos.flatMap((repo) => [
    { key: `repo:${repo.path}`, kind: 'repo', repo } satisfies Row,
    ...(repoOpen(repo)
      ? [...repo.worktrees.map((worktree): Row => ({ key: `wt:${worktree.path}`, kind: 'worktree', repo, worktree })), ...(sidebarBranches ? branchRows(repo) : [])]
      : [])
  ])
  const cursorIndex = rows.findIndex((row) => row.key === cursorKey)
  const index = cursorIndex >= 0 ? cursorIndex : rows.findIndex((row) => row.key === `wt:${selected}`)
  const cursorRow: Row | undefined = rows[index]

  const toggleRepo = (repo: Repo): void => setToggled(toggleIn(toggled, repo.path))
  // Projects and their Branches groups fold together; a filter or focus holds them open
  const foldableRepos = focus || needle ? [] : visibleRepos
  const branchHeaders = needle ? [] : rows.filter((row) => row.kind === 'branches')
  const canFoldAll = foldableRepos.length + branchHeaders.length > 1
  const anyOpen = foldableRepos.some(repoOpen) || branchHeaders.some((row) => branchGroupOpen(row.repo.path))
  const foldAll = (): void => {
    const flipped = !anyOpen !== (sections === 'expanded')
    const paths = visibleRepos.map((repo) => repo.path)
    setToggled(new Set([...[...toggled].filter((path) => !paths.includes(path)), ...(flipped ? foldableRepos.map((repo) => repo.path) : [])]))
    for (const path of paths) localStorage.setItem(branchGroupKey(path), JSON.stringify(flipped))
    setBranchToggles({ ...branchToggles, ...Object.fromEntries(paths.map((path) => [path, flipped])) })
  }
  const activate = (row: Row): void => {
    setCursorKey(row.key)
    if (row.kind === 'repo') toggleRepo(row.repo)
    else if (row.kind === 'branches') toggleBranchGroup(row.repo.path)
    else if (row.kind === 'older') setShowAll(new Set([...showAll, row.repo.path]))
    else if (row.kind === 'branch') onOpenBranch(row.branch, row.repo)
  }
  const nav = useListNav({
    count: rows.length,
    index,
    onSelect: (next) => {
      const row = rows[next]
      setCursorKey(row.key)
      if (row.kind === 'worktree') onSelect(row.worktree.path)
    },
    // Enter on a worktree goes to its changes; on anything else it does what a click does
    onOpen: (next) => (rows[next].kind === 'worktree' ? focusZone('main') : activate(rows[next]))
  })

  // Keys beyond moving: n new worktree, t terminal, f focus, y copy, h and l fold, z fold all; bound once, reading this render's state
  const onKey = useRef<(event: KeyboardEvent) => void>(() => undefined)
  onKey.current = (event) => {
    const repo = cursorRow?.repo ?? visibleRepos[0]
    if (zone !== 'list' || !isPageKey(event) || !repo) return
    const path = cursorRow?.kind === 'worktree' ? cursorRow.worktree.path : repo.path
    const open = repoOpen(repo)
    const action =
      event.key === 'n' ? () => onNewWorktree(repo)
      : event.key === 't' ? () => onTerminal(path)
      : event.key === 'f' ? () => setFocus(focus ? '' : repo.path)
      : event.key === 'z' && canFoldAll ? foldAll
      : event.key === 'y' ? () => {
          const text = cursorRow?.kind === 'branch' ? cursorRow.branch.name : path
          copyText(text)
          onFlash(`Copied ${text}`)
        }
      : (event.key === 'h' || event.key === 'ArrowLeft') && open && !focus && !needle ? () => {
          setCursorKey(`repo:${repo.path}`)
          if (cursorRow?.kind === 'repo') toggleRepo(repo)
        }
      : (event.key === 'l' || event.key === 'ArrowRight') && cursorRow?.kind === 'repo' && !open ? () => toggleRepo(repo)
      : null
    if (!action) return
    event.preventDefault()
    action()
  }
  useEffect(() => {
    const listener = (event: KeyboardEvent): void => onKey.current(event)
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [])

  const renderRow = (row: Row, rowIndex: number): React.JSX.Element => {
    const cursor = nav.rowProps(rowIndex)
    const isCursor = rowIndex === index
    if (row.kind === 'repo') {
      const open = repoOpen(row.repo)
      return (
        <div key={row.key} {...cursor} onContextMenu={(event) => onRepoMenu(event, row.repo)} className="group/row mx-1.5 mt-1 flex h-7 items-center rounded-md hover:bg-accent">
          <button onClick={() => activate(row)} title={tildify(row.repo.path)} className="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-1.5 text-left">
            <Icon name="chevron" className={`size-3 shrink-0 text-muted-foreground/65 ${open ? 'rotate-90' : ''}`} />
            <span className="shrink-0 text-[10.5px] font-medium tracking-wide text-muted-foreground uppercase">{baseName(row.repo.path)}</span>
            <span className="min-w-0 truncate text-[10.5px] text-muted-foreground/60">{tildify(parentDir(row.repo.path))}</span>
          </button>
          <button
            title="New worktree or branch (n)"
            onClick={() => onNewWorktree(row.repo)}
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 group-hover/row:opacity-100 hover:text-foreground focus-visible:opacity-100"
          >
            <Icon name="plus" className="size-3.5" />
          </button>
          <button
            title={focus ? 'Exit focus (f)' : 'Focus on this project (f)'}
            onClick={() => setFocus(focus ? '' : row.repo.path)}
            className={`inline-flex size-6 shrink-0 items-center justify-center rounded-md hover:text-foreground focus-visible:opacity-100 ${focus ? 'text-foreground' : 'text-muted-foreground opacity-0 group-hover/row:opacity-100'}`}
          >
            <Icon name="focus" className="size-3.5" />
          </button>
          <span className="w-6 shrink-0 pr-2 text-right text-[11px] text-muted-foreground/55 tabular-nums">{row.repo.worktrees.length}</span>
        </div>
      )
    }
    if (row.kind === 'worktree') {
      const { worktree } = row
      const active = worktree.path === selected
      const state = activity[worktree.path]
      return (
        <button
          key={row.key}
          {...cursor}
          title={tildify(worktree.path)}
          onClick={() => (setCursorKey(row.key), onSelect(worktree.path))}
          onContextMenu={(event) => onWorktreeMenu(event, worktree, row.repo)}
          className={`mx-1.5 flex w-[calc(100%-12px)] flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-accent ${active ? 'bg-accent' : ''}`}
        >
          <span className="flex w-full min-w-0 items-center gap-2">
            <Icon name={worktree.path === row.repo.path ? 'folder' : 'branch'} className="size-3.5 text-muted-foreground" />
            <span className={`min-w-0 flex-1 truncate font-mono text-[11.5px] ${active ? 'text-foreground' : 'text-foreground/85'}`}>{branchLabel(worktree)}</span>
            {worktree.changedFiles > 0 && <span className="shrink-0 rounded bg-amber-400/12 px-1 font-mono text-[10.5px] text-amber-400 tabular-nums">{worktree.changedFiles}</span>}
            {state && (
              <span title={state === 'input' ? 'An agent needs input' : 'An agent is running'} className={`size-1.5 shrink-0 rounded-full ${state === 'input' ? 'bg-amber-400' : 'bg-emerald-400'}`} />
            )}
          </span>
          <span className="w-full truncate pl-5 text-[10.5px] text-muted-foreground">{worktree.path === row.repo.path ? 'main worktree' : baseName(worktree.path)}</span>
        </button>
      )
    }
    if (row.kind === 'branches') {
      return (
        <div key={row.key} {...cursor} className="mx-1.5 flex h-6 items-center gap-1 rounded-md pr-1 pl-5 text-[10.5px] text-muted-foreground">
          <button onClick={() => activate(row)} className="flex min-w-0 flex-1 items-center gap-1 text-left tracking-wide uppercase hover:text-foreground">
            <Icon name="chevron" className={`size-3 ${branchGroupOpen(row.repo.path) ? 'rotate-90' : ''}`} />
            Branches
            <span className="tabular-nums normal-case">{showRemote ? row.local + row.remote : row.local}</span>
          </button>
          {row.remote > 0 && (
            <button
              title={showRemote ? 'Hide remote-only branches' : `Show ${row.remote} remote-only branches`}
              onClick={() => setShowRemote(!showRemote)}
              className={`rounded px-1 tabular-nums hover:text-foreground ${showRemote ? 'bg-foreground/[.08] text-foreground' : ''}`}
            >
              origin {row.remote}
            </button>
          )}
        </div>
      )
    }
    if (row.kind === 'older') {
      return (
        <button key={row.key} {...cursor} onClick={() => activate(row)} className="mx-1.5 flex h-6 w-[calc(100%-12px)] items-center rounded-md pl-10 text-left text-[11px] text-muted-foreground hover:text-foreground">
          Show {row.count} older branches
        </button>
      )
    }
    const { branch } = row
    return (
      <div
        key={row.key}
        {...cursor}
        title={`${branch.name}. Enter or double-click creates a worktree`}
        onClick={() => setCursorKey(row.key)}
        onDoubleClick={() => onOpenBranch(branch, row.repo)}
        onContextMenu={(event) => onBranchMenu(event, branch, row.repo)}
        className={`mx-1.5 flex h-7 items-center gap-2 rounded-md pr-1 pl-5 text-muted-foreground hover:bg-accent ${branch.merged || branch.gone ? 'opacity-60' : ''}`}
      >
        <Icon name={branch.remote ? 'external' : 'branch'} className="size-3.5 opacity-50" />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{branch.name}</span>
        {isCursor ? (
          <button onClick={() => onOpenBranch(branch, row.repo)} className="flex h-5 shrink-0 items-center gap-1 rounded px-1.5 text-[10.5px] text-foreground ring-1 ring-input hover:bg-background">
            ⏎ create worktree
          </button>
        ) : (
          <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10.5px] tabular-nums">
            {branch.merged ? <span className="font-sans text-violet-300">merged</span> : branch.gone ? <span className="font-sans">gone</span> : null}
            {branch.ahead > 0 && <span>↑{branch.ahead}</span>}
            {branch.behind > 0 && <span>↓{branch.behind}</span>}
            <span className="w-6 text-right font-sans">{branchAge(branch)}</span>
          </span>
        )}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ZoneHeader zone="list" title="Worktrees">
        {canFoldAll && <FoldAllButton anyOpen={anyOpen} onClick={foldAll} />}
        <IconButton label="New worktree (n)" onClick={() => {
            const repo = cursorRow?.repo ?? visibleRepos[0]
            if (repo) onNewWorktree(repo)
          }}>
          <Icon name="plus" className="size-3.5" />
        </IconButton>
        <IconButton label="Rescan (r)" onClick={onRescan}>
          <Icon name="refresh" className={`size-3.5 ${scanning ? 'text-foreground' : ''}`} />
        </IconButton>
      </ZoneHeader>
      <div className="flex shrink-0 flex-col gap-1.5 border-b border-border p-2">
        <label className="flex h-7 min-w-0 items-center gap-2 rounded-md bg-muted px-2 text-muted-foreground ring-1 ring-border">
          <Icon name="search" className="size-3.5" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter worktrees and branches"
            className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/60"
          />
          {query && (
            <button title="Clear filter" onClick={() => setQuery('')} className="inline-flex size-5 items-center justify-center rounded hover:text-foreground">
              <Icon name="close" className="size-3" />
            </button>
          )}
          <button
            role="switch"
            aria-checked={changesOnly}
            title={changesOnly ? 'Showing worktrees with uncommitted changes, click to show all' : 'Only show worktrees with uncommitted changes'}
            onClick={() => setChangesOnly(!changesOnly)}
            className={`-mr-1 h-5 shrink-0 rounded px-1.5 text-[11px] ${changesOnly ? 'bg-foreground/[.08] text-foreground' : 'hover:bg-accent hover:text-foreground'}`}
          >
            Changed
          </button>
        </label>
        {folderFilter && (
          <label
            title={focus ? 'Exit focus to filter by folder' : folder ? tildify(folder) : 'Filter by folder'}
            className={`relative flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-xs ${focus ? 'opacity-40' : 'hover:bg-accent'} ${folder ? 'text-foreground' : 'text-muted-foreground'}`}
          >
            <Icon name="folder" className="size-3.5 text-muted-foreground" />
            <span className="truncate">{folder ? baseName(folder) : 'All folders'}</span>
            <Icon name="chevron" className="ml-auto size-3 rotate-90 text-muted-foreground/65" />
            <select value={folder} disabled={Boolean(focus)} onChange={(event) => setFolder(event.target.value)} className="absolute inset-0 cursor-pointer opacity-0 disabled:cursor-default">
              <option value="">All folders</option>
              {folders.map((path) => (
                <option key={path} value={path}>
                  {tildify(path)}
                </option>
              ))}
            </select>
          </label>
        )}
        {focus && (
          <div className="flex h-7 items-center gap-2 rounded-md bg-foreground/[.08] pr-1 pl-2 text-xs text-foreground">
            <Icon name="focus" className="size-3.5" />
            <span className="truncate font-medium" title={focus}>
              {baseName(focus)}
            </span>
            <span className="flex-1" />
            <button title="Exit focus (f)" onClick={() => setFocus('')} className="inline-flex size-5 items-center justify-center rounded hover:bg-accent">
              <Icon name="close" className="size-3" />
            </button>
          </div>
        )}
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto pb-2">
        {!repos && <EmptyState title="Scanning home folder..." />}
        {repos && visibleRepos.length === 0 && <EmptyState title="No matching worktrees" />}
        {rows.map(renderRow)}
      </nav>
    </div>
  )
}
