import { useEffect, useMemo, useState } from 'react'
import type { WorktreeFiles } from '../../shared/types'
import { FileIcon, Icon } from './Icon'
import { EmptyState, usePersisted } from './ui'
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
  onExpand
}: {
  files: WorktreeFiles | null
  changed: Set<string>
  activePath: string | null
  onOpen: (path: string) => void
  onFileMenu?: (event: React.MouseEvent, path: string) => void
  /** Folder rows and the empty area below the tree (path '') */
  onFolderMenu?: (event: React.MouseEvent, path: string) => void
  onCreate?: (kind: 'file' | 'folder', folder: string) => void
  /** For trees loaded a folder at a time: called when a folder opens */
  onExpand?: (path: string) => void
}): React.JSX.Element {
  const [filter, setFilter] = usePersisted<string>(workspaceKey('explorer.filter'), '')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const allPaths = useMemo(() => [...(files?.files ?? []), ...(files?.ignored ?? [])].sort(), [files])
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

  const toggle = (path: string): void => {
    const next = new Set(expanded)
    if (next.has(path)) next.delete(path)
    else {
      next.add(path)
      onExpand?.(path)
    }
    setExpanded(next)
  }

  const fileRow = (path: string, depth: number, label: string): React.JSX.Element => (
    <button
      key={path}
      title={path}
      onClick={() => onOpen(path)}
      onContextMenu={onFileMenu && ((event) => onFileMenu(event, path))}
      style={{ paddingLeft: 8 + depth * 12 + 10 }}
      className={`flex h-6 w-full items-center gap-1.5 rounded-md pr-2 text-left text-[12.5px] ${
        path === activePath ? 'bg-accent text-foreground' : 'text-foreground/75 hover:bg-accent'
      } ${isIgnored(path) ? 'opacity-45' : ''}`}
    >
      <FileIcon path={path} />
      <span className="truncate">{label}</span>
      {changed.has(path) && <span className="ml-auto size-1.5 shrink-0 rounded-full bg-amber-400" />}
    </button>
  )

  const dirRows = (node: TreeNode, depth: number): React.JSX.Element[] =>
    node.dirs.flatMap((dir) => {
      const open = expanded.has(dir.path)
      const ignored = isIgnored(dir.path)
      const collapsedIgnored = ignored && dir.dirs.length === 0 && dir.files.length === 0
      return [
        <button
          key={dir.path}
          onClick={() => toggle(dir.path)}
          onContextMenu={onFolderMenu && ((event) => onFolderMenu(event, dir.path))}
          disabled={collapsedIgnored}
          title={collapsedIgnored ? `${dir.path} is gitignored` : dir.path}
          style={{ paddingLeft: 8 + depth * 12 }}
          className={`flex h-6 w-full items-center gap-1 rounded-md pr-2 text-left text-[12.5px] text-foreground/85 enabled:hover:bg-accent ${
            ignored ? 'opacity-45' : ''
          }`}
        >
          <Icon
            name="chevron"
            className={`size-3 text-muted-foreground/65 transition-transform ${open ? 'rotate-90' : ''} ${
              collapsedIgnored ? 'invisible' : ''
            }`}
          />
          <Icon name="folder" className="size-3.5 text-muted-foreground" />
          <span className="truncate">{dir.name}</span>
        </button>,
        ...(open ? [...dirRows(dir, depth + 1), ...dir.files.map((path) => fileRow(path, depth + 1, path.split('/').pop() ?? path))] : [])
      ]
    })

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 p-2">
        <label className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md border border-input bg-muted px-2 text-muted-foreground focus-within:border-primary/60">
          <Icon name="search" className="size-3" />
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter files"
            className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/70"
          />
        </label>
        {onCreate && (
          <>
            <button title="New file" onClick={() => onCreate('file', '')} className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
              <Icon name="filePlus" className="size-3.5" />
            </button>
            <button title="New folder" onClick={() => onCreate('folder', '')} className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
              <Icon name="folderPlus" className="size-3.5" />
            </button>
          </>
        )}
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto px-2 pb-3"
        onContextMenu={(event) => {
          if (onFolderMenu && event.target === event.currentTarget) onFolderMenu(event, '')
        }}
      >
        {!files && <EmptyState title="Loading files..." />}
        {needle
          ? matches.slice(0, MAX_FILTER_RESULTS).map((path) => fileRow(path, 0, path))
          : [...dirRows(tree, 0), ...tree.files.map((path) => fileRow(path, 0, path))]}
        {needle && matches.length === 0 && (
          <EmptyState title="No matching files" />
        )}
      </div>
    </div>
  )
}

/** A folder outside the selected worktree, e.g. home or where a terminal is; folders load when opened, since listing everything at once is too slow */
export function FolderExplorer({ root, activePath, onOpen }: { root: string; activePath: string | null; onOpen: (path: string) => void }): React.JSX.Element {
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
  return <Explorer files={tree} changed={NOTHING_CHANGED} activePath={activePath} onOpen={onOpen} onExpand={repoFiles ? undefined : load} />
}

const NOTHING_CHANGED = new Set<string>()
