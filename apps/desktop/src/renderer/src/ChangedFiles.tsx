import { useEffect, useState } from 'react'
import type { FilePatch } from '../../shared/types'
import { FileIcon, Icon } from './Icon'
import { getSettings, groupOpen, toggleIn, useSettings } from './settings'
import { ancestorFolders, buildFolderTree, type FolderNode } from './fileTree'
import { baseName } from './Sidebar'

export const dirName = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')

/** Folders flipped from the default open state, see groupOpen; lifted when a header controls expanding */
export type FolderToggles = [Set<string>, React.Dispatch<React.SetStateAction<Set<string>>>]

/** Every folder row the grouped list shows for these patches */
export function folderPaths(patches: FilePatch[]): string[] {
  const collect = (folder: FolderNode<FilePatch>): string[] => [folder.path, ...folder.folders.flatMap(collect)]
  return buildFolderTree(patches, (patch) => patch.path).folders.flatMap(collect)
}

/** Toggles that leave every folder open, or every folder closed except the ones in `keepOpen` */
export function allFolders(paths: string[], open: boolean, keepOpen: string[] = []): Set<string> {
  const expandedByDefault = getSettings().sections === 'expanded'
  const wantOpen = (path: string): boolean => open || keepOpen.includes(path)
  return new Set(paths.filter((path) => wantOpen(path) !== expandedByDefault))
}

export function ChangedFileList({
  patches,
  activePath,
  grouped = true,
  badge,
  onOpen,
  onFileMenu,
  toggles
}: {
  patches: FilePatch[]
  activePath: string | null
  grouped?: boolean
  badge?: (path: string) => React.ReactNode
  onOpen: (path: string) => void
  onFileMenu?: (event: React.MouseEvent, path: string) => void
  toggles?: FolderToggles
}): React.JSX.Element {
  const ownToggles = useState<Set<string>>(new Set())
  const [toggled, setToggled] = toggles ?? ownToggles
  useSettings()

  // Reveal the folder of the file being shown, e.g. the first one opened automatically
  useEffect(() => {
    if (!grouped || activePath === null) return
    setToggled((current) => ancestorFolders(activePath).reduce((next, folder) => (groupOpen(next, folder) ? next : toggleIn(next, folder)), current))
  }, [activePath, grouped])
  const row = (patch: FilePatch, depth = 0): React.JSX.Element => (
    <button
      style={grouped ? { paddingLeft: 16 + depth * 12 } : undefined}
      key={patch.path}
      title={patch.path}
      onClick={() => onOpen(patch.path)}
      onContextMenu={onFileMenu && ((event) => onFileMenu(event, patch.path))}
      className={`flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-left transition-colors ${grouped ? 'pl-4' : 'pl-2'} ${
        patch.path === activePath ? 'bg-accent text-foreground' : 'text-foreground/75 hover:bg-accent'
      }`}
    >
      <FileIcon path={patch.path} />
      <span className="truncate text-[13px]">{baseName(patch.path)}</span>
      <span className="flex-1" />
      {badge?.(patch.path)}
      <span className="font-mono text-[10.5px] text-emerald-400 tabular-nums">+{patch.additions}</span>
      <span className="font-mono text-[10.5px] text-red-400 tabular-nums">−{patch.deletions}</span>
    </button>
  )

  if (!grouped) return <>{patches.map((patch) => row(patch))}</>

  const count = (folder: FolderNode<FilePatch>): number => folder.files.length + folder.folders.reduce((sum, child) => sum + count(child), 0)
  const folderRows = (folder: FolderNode<FilePatch>, depth: number): React.JSX.Element => {
    const open = groupOpen(toggled, folder.path)
    return (
      <div key={folder.path}>
        <button
          title={folder.path}
          onClick={() => setToggled(toggleIn(toggled, folder.path))}
          style={{ paddingLeft: 6 + depth * 12 }}
          className="flex h-6 w-full items-center gap-1.5 rounded-md pr-1.5 text-left text-[11.5px] text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Icon name="chevron" className={`size-3 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
          <Icon name="folder" className="size-3 shrink-0" />
          <span className="truncate">{folder.name}</span>
          <span className="ml-auto pl-1 tabular-nums">{count(folder)}</span>
        </button>
        {open && (
          <>
            {folder.folders.map((child) => folderRows(child, depth + 1))}
            {folder.files.map((patch) => row(patch, depth))}
          </>
        )}
      </div>
    )
  }

  // Nested like the file tree, with single-child folder chains merged so long paths don't truncate to the same prefix
  const tree = buildFolderTree(patches, (patch) => patch.path)
  return (
    <>
      {tree.folders.map((folder) => folderRows(folder, 0))}
      {tree.files.map((patch) => row(patch, -1))}
    </>
  )
}
