import { useEffect, useMemo, useRef, useState } from 'react'
import { getShell, isPageKey, useListNav, type ZoneId } from '@treeix/sdk'
import type { WorktreeFiles } from '../../shared/types'
import { FileIcon, Icon } from './Icon'
import { EmptyState, FoldAllButton, usePersisted } from './ui'
import { workspaceKey } from './workspaces'

type TreeNode = { name: string; path: string; dirs: TreeNode[]; files: string[] }

const MAX_FILTER_RESULTS = 300

function buildTree(paths: string[]): TreeNode {
  const root: TreeNode = { name: '', path: '', dirs: [], files: [] }
  for (const path of paths) {
    const isDir = path.endsWith('/')
    const parts = (isDir ? path.slice(0, -1) : path).split('/')
    let node = root
    ;(isDir ? parts : parts.slice(0, -1)).forEach((part, index) => {
      let child = node.dirs.find((dir) => dir.name === part)
      if (!child) {
        child = { name: part, path: parts.slice(0, index + 1).join('/'), dirs: [], files: [] }
        node.dirs.push(child)
      }
      node = child
    })
    if (!isDir) node.files.push(path)
  }
  const sort = (node: TreeNode): void => {
    node.dirs.sort((a, b) => a.name.localeCompare(b.name))
    node.dirs.forEach(sort)
  }
  sort(root)
  return root
}

const ancestors = (path: string): string[] =>
  path
    .split('/')
    .slice(0, -1)
    .map((_, index, parts) => parts.slice(0, index + 1).join('/'))

export function Explorer({
  files,
  changed,
  activePath,
  onOpen,
  onFileMenu,
  onFolderMenu,
  onCreate,
  onExpand,
  onParent,
  rootPath,
  zone = 'inspector'
}: {
  files: WorktreeFiles | null
  /** Folder the paths are relative to; gitignored folders, which git lists without their contents, are read from it when opened */
  rootPath?: string
  changed: Set<string>
  activePath: string | null
  onOpen: (path: string) => void
  onFileMenu?: (event: React.MouseEvent, path: string) => void
  /** Folder rows and the empty area below the tree (path '') */
  onFolderMenu?: (event: React.MouseEvent, path: string) => void
  onCreate?: (kind: 'file' | 'folder', folder: string) => void
  /** For trees loaded a folder at a time: called when a folder opens */
  onExpand?: (path: string) => void
  /** Browses the folder above the root; shows a `..` row first, also ⌫ */
  onParent?: () => void
  /** Zone whose keys move the cursor: j k, Enter, h l */
  zone?: ZoneId
}): React.JSX.Element {
  const [filter, setFilter] = usePersisted<string>(workspaceKey('explorer.filter'), '')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  /** Contents of gitignored folders opened so far, by folder; read from disk a level at a time since node_modules can be huge */
  const [ignoredContents, setIgnoredContents] = useState<Record<string, string[]>>({})
  const readIgnored = (folder: string): void => {
    if (rootPath) void window.api.listDirectory(rootPath, folder).then((entries) => setIgnoredContents((current) => ({ ...current, [folder]: entries })))
  }
  const openedIgnored = useRef<string[]>([])
  openedIgnored.current = Object.keys(ignoredContents)
  useEffect(() => setIgnoredContents({}), [rootPath])
  // The file list refreshes as files change; the folders already open are read again with it
  useEffect(() => openedIgnored.current.forEach(readIgnored), [files])
  const allPaths = useMemo(() => [...(files?.files ?? []), ...(files?.ignored ?? []), ...Object.values(ignoredContents).flat()].sort(), [files, ignoredContents])
  const tree = useMemo(() => buildTree(allPaths), [allPaths])
  const ignoredDirs = useMemo(() => (files?.ignored ?? []).filter((path) => path.endsWith('/')), [files])
  const ignoredFiles = useMemo(() => new Set(files?.ignored ?? []), [files])
  const isIgnored = (path: string): boolean =>
    ignoredFiles.has(path) || ignoredFiles.has(`${path}/`) || ignoredDirs.some((dir) => path.startsWith(dir))
  const needle = filter.trim().toLowerCase()
  const matches = needle
    ? allPaths.filter((path) => !path.endsWith('/') && path.toLowerCase().includes(needle))
    : []

  useEffect(() => {
    if (activePath) setExpanded((current) => new Set([...current, ...ancestors(activePath)]))
  }, [activePath])

  const allDirs = useMemo(() => {
    const collect = (node: TreeNode): string[] => node.dirs.flatMap((dir) => [dir.path, ...collect(dir)])
    return collect(tree)
  }, [tree])
  // Filter results are a flat list with no folders
  const canFoldAll = !needle && allDirs.length > 1
  const anyOpen = allDirs.some((path) => expanded.has(path))
  const foldAll = (): void => {
    if (anyOpen) return setExpanded(new Set())
    allDirs.forEach((path) => onExpand?.(path))
    setExpanded(new Set(allDirs))
  }

  const toggle = (path: string): void => {
    const next = new Set(expanded)
    if (next.has(path)) next.delete(path)
    else {
      next.add(path)
      onExpand?.(path)
      if (isIgnored(path) && !(path in ignoredContents)) readIgnored(path)
    }
    setExpanded(next)
  }

  type Row = { path: string; label: string; depth: number; dir: TreeNode | null }
  const dirRows = (node: TreeNode, depth: number): Row[] =>
    node.dirs.flatMap((dir) => [
      { path: dir.path, label: dir.name, depth, dir },
      ...(expanded.has(dir.path) ? [...dirRows(dir, depth + 1), ...dir.files.map((path) => ({ path, label: path.split('/').pop() ?? path, depth: depth + 1, dir: null }))] : [])
    ])
  const rows: Row[] = needle
    ? matches.slice(0, MAX_FILTER_RESULTS).map((path) => ({ path, label: path, depth: 0, dir: null }))
    : [...dirRows(tree, 0), ...tree.files.map((path) => ({ path, label: path, depth: 0, dir: null }))]
  // Without a root there is nothing to read; with one, a folder counts as empty only once it was read
  const emptyIgnored = (row: Row): boolean =>
    row.dir !== null && isIgnored(row.path) && row.dir.dirs.length === 0 && row.dir.files.length === 0 && (!rootPath || row.path in ignoredContents)

  const [cursorPath, setCursorPath] = useState<string | null>(activePath)
  useEffect(() => setCursorPath(activePath), [activePath])
  const index = rows.findIndex((row) => row.path === cursorPath)
  const activate = (row: Row): void => {
    setCursorPath(row.path)
    if (!row.dir) onOpen(row.path)
    else if (!emptyIgnored(row)) toggle(row.path)
  }
  const nav = useListNav({ zone, count: rows.length, index, onSelect: (next) => setCursorPath(rows[next].path), onOpen: (next) => activate(rows[next]) })
  // h folds the folder, or steps up to the parent; l unfolds; z folds or unfolds all. Filter results are a flat list with no folders
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // Pages stay mounted behind other tabs, each with its own explorer
      if (needle || !isPageKey(event) || getShell().zone !== zone || !root.current?.checkVisibility()) return
      if (event.key === 'Backspace' && onParent) {
        event.preventDefault()
        return onParent()
      }
      const row = rows[index]
      const open = row !== undefined && row.dir !== null && expanded.has(row.path)
      const parent = row?.path.split('/').slice(0, -1).join('/')
      const action =
        event.key === 'z' && canFoldAll ? foldAll
        : !row ? null
        : event.key === 'h' || event.key === 'ArrowLeft' ? () => (open ? toggle(row.path) : parent && setCursorPath(parent))
        : (event.key === 'l' || event.key === 'ArrowRight') && row.dir && !open && !emptyIgnored(row) ? () => toggle(row.path)
        : null
      if (!action) return
      event.preventDefault()
      action()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const renderRow = (row: Row, rowIndex: number): React.JSX.Element => {
    const ignored = isIgnored(row.path)
    if (!row.dir) {
      return (
        <button
          key={row.path}
          {...nav.rowProps(rowIndex)}
          title={row.path}
          onClick={() => activate(row)}
          onContextMenu={onFileMenu && ((event) => onFileMenu(event, row.path))}
          style={{ paddingLeft: 8 + row.depth * 12 + 16 }}
          className={`flex h-6 w-full items-center gap-1.5 rounded-md pr-2 text-left text-xs ${row.path === activePath ? 'bg-accent text-foreground' : 'text-foreground/75 hover:bg-accent'} ${ignored ? 'opacity-45' : ''}`}
        >
          <FileIcon path={row.path} />
          <span className="min-w-0 truncate">{row.label}</span>
          {changed.has(row.path) && <span className="ml-auto shrink-0 pl-1 font-mono text-[10px] text-amber-400">M</span>}
        </button>
      )
    }
    const collapsedIgnored = emptyIgnored(row)
    return (
      <button
        key={row.path}
        {...nav.rowProps(rowIndex)}
        onClick={() => activate(row)}
        onContextMenu={onFolderMenu && ((event) => onFolderMenu(event, row.path))}
        disabled={collapsedIgnored}
        title={collapsedIgnored ? `${row.path} is gitignored` : row.path}
        style={{ paddingLeft: 8 + row.depth * 12 }}
        className={`flex h-6 w-full items-center gap-1 rounded-md pr-2 text-left text-xs text-foreground/85 enabled:hover:bg-accent ${ignored ? 'opacity-45' : ''}`}
      >
        <Icon name="chevron" className={`size-3 text-muted-foreground/65 ${expanded.has(row.path) ? 'rotate-90' : ''} ${collapsedIgnored ? 'invisible' : ''}`} />
        <Icon name="folder" className="size-3.5 text-muted-foreground" />
        <span className="min-w-0 truncate">{row.label}</span>
      </button>
    )
  }

  return (
    <div ref={root} className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 p-2">
        <label className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md bg-muted px-2 text-muted-foreground ring-1 ring-border">
          <Icon name="search" className="size-3" />
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && matches[0] && onOpen(matches[0])}
            placeholder="Filter files"
            className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/60"
          />
        </label>
        {canFoldAll && <FoldAllButton anyOpen={anyOpen} groups="folders" onClick={foldAll} />}
        {onCreate && (
          <>
            <button title="New file" onClick={() => onCreate('file', '')} className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
              <Icon name="filePlus" className="size-3.5" />
            </button>
            <button title="New folder" onClick={() => onCreate('folder', '')} className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
              <Icon name="folderPlus" className="size-3.5" />
            </button>
          </>
        )}
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3"
        onContextMenu={(event) => {
          if (onFolderMenu && event.target === event.currentTarget) onFolderMenu(event, '')
        }}
      >
        {onParent && !needle && (
          <button
            title="Parent folder (⌫)"
            onClick={onParent}
            tabIndex={-1}
            style={{ paddingLeft: 8 }}
            className="flex h-6 w-full items-center gap-1 rounded-md pr-2 text-left text-xs text-foreground/85 hover:bg-accent"
          >
            <Icon name="chevron" className="invisible size-3" />
            <Icon name="folder" className="size-3.5 text-muted-foreground" />
            <span>..</span>
          </button>
        )}
        {!files && <EmptyState title="Loading files..." />}
        {rows.map(renderRow)}
        {needle && matches.length === 0 && <EmptyState title="No matching files" />}
      </div>
    </div>
  )
}

/** A folder outside the selected worktree, e.g. home or where a terminal is; folders load when opened, since listing everything at once is too slow */
export function FolderExplorer({ root, activePath, onOpen, onParent }: { root: string; activePath: string | null; onOpen: (path: string) => void; onParent?: () => void }): React.JSX.Element {
  const [files, setFiles] = useState<string[] | null>(null)
  const load = (folder: string): void => {
    window.api.listDirectory(root, folder).then((entries) =>
      setFiles((current) => [...new Set([...(current ?? []).filter((path) => !folder || !path.startsWith(`${folder}/`)), ...entries])])
    )
  }
  // A repository lists everything at once through git, so the filter finds files in folders not opened yet
  const [repoFiles, setRepoFiles] = useState<WorktreeFiles | null>(null)
  useEffect(() => {
    setFiles(null)
    setRepoFiles(null)
    window.api.listFiles(root).then(setRepoFiles, () => load(''))
  }, [root])
  const tree = useMemo(() => repoFiles ?? (files ? { files, ignored: [] } : null), [repoFiles, files])
  return <Explorer files={tree} rootPath={repoFiles ? root : undefined} changed={NOTHING_CHANGED} activePath={activePath} onOpen={onOpen} onExpand={repoFiles ? undefined : load} onParent={onParent} />
}

const NOTHING_CHANGED = new Set<string>()
