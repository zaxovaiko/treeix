import { useEffect, useState } from 'react'
import type { Repo } from '../../shared/types'
import { openMenu } from './contextMenu'
import { Icon } from './Icon'
import { digitLabel } from './settings'
import { baseName } from './Sidebar'
import { Kbd, type ListRowProps, type SessionSummary, useListNav, useShell, useZone, Zone } from '@treeix/sdk'
import { isAgent } from './agents'
import { useSessions } from './plugins'
import {
  deleteWorkspace,
  initials,
  inWorkspace,
  moveWorkspace,
  saveWorkspace,
  suggestWorkspaceName,
  useWorkspaces,
  type Workspace,
  WORKSPACE_COLORS
} from './workspaces'

function activityOf(sessions: SessionSummary[], workspace: Workspace, repos: Repo[] | null, workspaces: Workspace[]): 'input' | 'running' | null {
  const mine = sessions.filter((session) => inWorkspace(session, workspace, repos, workspaces))
  if (mine.some((session) => session.status === 'input')) return 'input'
  return mine.some((session) => session.status === 'running' && isAgent(session.kind)) ? 'running' : null
}

function Tile({
  active,
  title,
  activity,
  color,
  onClick,
  onContextMenu,
  drag,
  cursor,
  leaderKey,
  children
}: {
  active: boolean
  title: string
  activity: 'input' | 'running' | null
  color?: string
  onClick: () => void
  onContextMenu?: (event: React.MouseEvent) => void
  drag?: React.HTMLAttributes<HTMLButtonElement> & { draggable: true; dropEdge: 'top' | 'bottom' | null }
  /** Marks the tile under the rail's keyboard cursor */
  cursor?: ListRowProps
  /** Shown while the leader key waits, e.g. 1 for G 1 */
  leaderKey?: string
  children: React.ReactNode
}): React.JSX.Element {
  const { dropEdge, ...dragProps } = drag ?? { dropEdge: null }
  return (
    <button title={title} onClick={onClick} onContextMenu={onContextMenu} {...dragProps} {...cursor} className="group/tile relative grid w-full place-items-center py-1">
      {dropEdge && <span className={`pointer-events-none absolute inset-x-2 h-0.5 rounded-full bg-foreground/60 ${dropEdge === 'top' ? '-top-[3px]' : '-bottom-[3px]'}`} />}
      <span
        style={color ? { background: color } : undefined}
        className={`relative grid size-8 place-items-center rounded-[9px] text-[11px] font-bold ${color ? 'text-white' : 'bg-foreground/8 text-muted-foreground'} ${
          active ? '' : 'opacity-60 group-hover/tile:opacity-100'
        }`}
      >
        {children}
        {activity && (
          <span
            className={`absolute -top-0.5 -right-0.5 size-2 rounded-full ring-2 ring-card ${activity === 'input' ? 'bg-amber-400' : 'bg-emerald-400'}`}
          />
        )}
      </span>
      {leaderKey && (
        <span className="absolute right-0.5 bottom-0">
          <Kbd on>{leaderKey}</Kbd>
        </span>
      )}
    </button>
  )
}

export function WorkspaceRail({
  repos,
  onSwitch,
  onEdit
}: {
  repos: Repo[] | null
  onSwitch: (id: string) => void
  /** Opens the editor; null creates a new workspace */
  onEdit: (workspace: Workspace | null) => void
}): React.JSX.Element {
  const { workspaces, currentId } = useWorkspaces()
  const sessions = useSessions()
  const { leader } = useShell()
  const { zone } = useZone()
  // The rail's cursor moves on its own; Enter switches, so walking past workspaces doesn't load each one
  const [cursor, setCursor] = useState(-1)
  const currentIndex = workspaces.findIndex((workspace) => workspace.id === currentId)
  useEffect(() => setCursor(-1), [currentId])
  const nav = useListNav({ zone: 'rail', count: workspaces.length, index: cursor < 0 ? currentIndex : cursor, onSelect: setCursor, onOpen: (index) => onSwitch(workspaces[index].id) })
  const [drop, setDrop] = useState<{ id: string; edge: 'top' | 'bottom' } | null>(null)
  const WORKSPACE_MIME = 'application/x-treeix-workspace'
  const dragProps = (workspace: Workspace, index: number) => ({
    draggable: true as const,
    dropEdge: drop?.id === workspace.id ? drop.edge : null,
    // No state updates in dragstart: React re-rendering there makes Chromium cancel the drag
    onDragStart: (event: React.DragEvent) => {
      event.dataTransfer.setData(WORKSPACE_MIME, workspace.id)
      event.dataTransfer.effectAllowed = 'move'
    },
    onDragOver: (event: React.DragEvent) => {
      if (!event.dataTransfer.types.includes(WORKSPACE_MIME)) return
      event.preventDefault()
      const box = event.currentTarget.getBoundingClientRect()
      const edge = event.clientY < box.top + box.height / 2 ? 'top' : 'bottom'
      if (drop?.id !== workspace.id || drop.edge !== edge) setDrop({ id: workspace.id, edge })
    },
    onDragLeave: () => setDrop(null),
    onDragEnd: () => setDrop(null),
    onDrop: (event: React.DragEvent) => {
      const id = event.dataTransfer.getData(WORKSPACE_MIME)
      if (!id) return
      event.preventDefault()
      setDrop(null)
      const beforeId = drop?.edge === 'bottom' ? (workspaces[index + 1]?.id ?? null) : workspace.id
      moveWorkspace(id, beforeId === id ? (workspaces[index + 2]?.id ?? null) : beforeId)
    }
  })

  return (
    <Zone id="rail" label="Workspaces" className="w-[52px] shrink-0 items-center gap-1 border-r border-border bg-sidebar py-2">
      {workspaces.map((workspace, index) => (
        <Tile
          key={workspace.id}
          active={currentId === workspace.id}
          title={`${workspace.name} · ${workspace.repoPaths.map(baseName).join(', ') || 'no projects'}${index < 9 ? ` (${[`G ${index + 1}`, digitLabel('workspaces', index + 1)].filter(Boolean).join(', ')})` : ''}`}
          color={workspace.color}
          activity={activityOf(sessions, workspace, repos, workspaces)}
          onClick={() => onSwitch(workspace.id)}
          drag={dragProps(workspace, index)}
          cursor={zone === 'rail' ? nav.rowProps(index) : undefined}
          leaderKey={leader && index < 9 ? String(index + 1) : undefined}
          onContextMenu={(event) =>
            openMenu(event, [
              { label: 'Open', run: () => onSwitch(workspace.id) },
              { label: 'Edit workspace…', run: () => onEdit(workspace) },
              null,
              {
                label: 'Delete workspace…',
                run: () => window.confirm(`Delete workspace ${workspace.name}? Projects and sessions are not affected.`) && deleteWorkspace(workspace.id)
              }
            ])
          }
        >
          {initials(workspace.name)}
        </Tile>
      ))}
      <button
        title="New workspace"
        onClick={() => onEdit(null)}
        className="mt-1 grid size-8 shrink-0 place-items-center rounded-[9px] border border-dashed border-foreground/15 text-muted-foreground hover:border-foreground/30 hover:text-foreground"
      >
        <Icon name="plus" className="size-4" />
      </button>
    </Zone>
  )
}

export function WorkspaceDialog({
  workspace,
  repos,
  onSaved,
  onClose
}: {
  workspace: Workspace | null
  repos: Repo[] | null
  onSaved: (workspace: Workspace) => void
  onClose: () => void
}): React.JSX.Element {
  const { workspaces } = useWorkspaces()
  const [name, setName] = useState(workspace?.name ?? '')
  const [color, setColor] = useState(workspace?.color ?? WORKSPACE_COLORS[workspaces.length % WORKSPACE_COLORS.length])
  const [selected, setSelected] = useState<string[]>(workspace?.repoPaths ?? [])
  const [terminalPath, setTerminalPath] = useState(workspace?.terminalPath ?? '')
  const [filter, setFilter] = useState('')

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', closeOnEscape, true)
    return () => window.removeEventListener('keydown', closeOnEscape, true)
  }, [onClose])

  const needle = filter.trim().toLowerCase()
  const visibleRepos = (repos ?? []).filter((repo) => repo.path.toLowerCase().includes(needle))
  const parentOf = (path: string): string => path.slice(0, path.lastIndexOf('/'))
  const folders = [...new Set(visibleRepos.map((repo) => parentOf(repo.path)))].sort()
  // Folders holding this workspace's projects start open; toggling flips that default
  const [toggledFolders, setToggledFolders] = useState<string[]>([])
  const toggleFolder = (folder: string): void =>
    setToggledFolders(toggledFolders.includes(folder) ? toggledFolders.filter((candidate) => candidate !== folder) : [...toggledFolders, folder])
  const setFolderSelected = (folderRepos: Repo[], checked: boolean): void => {
    const paths = folderRepos.map((repo) => repo.path)
    setSelected(checked ? [...new Set([...selected, ...paths])] : selected.filter((path) => !paths.includes(path)))
  }
  const toggle = (path: string): void => setSelected(selected.includes(path) ? selected.filter((candidate) => candidate !== path) : [...selected, path])
  // Until the user types a name, the selected projects name the workspace
  const suggestion = suggestWorkspaceName(selected)
  const finalName = name.trim() || suggestion
  const canSave = finalName.length > 0

  const save = (): void => {
    if (!canSave) return
    const next = {
      id: workspace?.id ?? crypto.randomUUID(),
      name: finalName,
      color,
      repoPaths: selected,
      ...(terminalPath && selected.includes(terminalPath) ? { terminalPath } : {})
    }
    saveWorkspace(next)
    onSaved(next)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 backdrop-blur-[2px] pt-[10vh]" onClick={onClose}>
      <div onClick={(event) => event.stopPropagation()} className="flex max-h-[80vh] w-[600px] max-w-[92vw] flex-col rounded-xl border border-border bg-popover backdrop-blur-2xl shadow-2xl shadow-black/60">
        <div className="flex h-12 shrink-0 items-center border-b border-border pr-2 pl-4">
          <span className="text-sm font-medium">{workspace ? 'Edit workspace' : 'New workspace'}</span>
          <button onClick={onClose} aria-label="Close" className="ml-auto grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent">
            <Icon name="close" className="size-3.5" />
          </button>
        </div>

        <div className="flex min-h-0 flex-col gap-5 overflow-y-auto p-4">
          <div className="flex items-end gap-3">
            <span style={{ background: color }} className="grid size-11 shrink-0 place-items-center rounded-xl text-base font-bold text-white">
              {initials(finalName || '?')}
            </span>
            <label className="flex min-w-0 flex-1 flex-col gap-1.5 text-xs text-muted-foreground">
              Name
              <input
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => event.key === 'Enter' && save()}
                placeholder={suggestion || 'Select projects or type a name'}
                className="h-8 rounded-md border border-input bg-muted px-2.5 text-[13px] text-foreground outline-none placeholder:text-muted-foreground/60"
              />
            </label>
            <div className="flex flex-col gap-1.5 text-xs text-muted-foreground">
              Colour
              <div className="flex h-8 items-center gap-1.5">
                {WORKSPACE_COLORS.map((swatch) => (
                  <button
                    key={swatch}
                    aria-label={`Colour ${swatch}`}
                    onClick={() => setColor(swatch)}
                    style={{ background: swatch }}
                    className="grid size-5 place-items-center rounded-md text-white"
                  >
                    {color === swatch && <Icon name="check" className="size-3" />}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex min-h-0 flex-col gap-1.5">
            <div className="flex text-xs text-muted-foreground">
              <span className="flex-1">Projects</span>
              <span>{selected.length} selected</span>
            </div>
            <div className="overflow-hidden rounded-lg border border-border">
              <label className="flex h-9 items-center gap-2 border-b border-border px-3 text-muted-foreground">
                <Icon name="search" className="size-3.5" />
                <input
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder="Filter projects"
                  className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground/60"
                />
              </label>
              <div className="max-h-80 overflow-y-auto p-1">
                {folders.map((folder) => {
                  const folderRepos = visibleRepos.filter((repo) => parentOf(repo.path) === folder)
                  const checkedCount = folderRepos.filter((repo) => selected.includes(repo.path)).length
                  const open = needle !== '' || toggledFolders.includes(folder) !== folderRepos.some((repo) => workspace?.repoPaths.includes(repo.path))
                  const allChecked = checkedCount === folderRepos.length
                  return (
                    <div key={folder} className="mb-0.5">
                      <div className="flex h-8 items-center gap-1 rounded-md pr-2 hover:bg-accent">
                        <button
                          onClick={() => toggleFolder(folder)}
                          className="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-1.5 text-left text-xs text-muted-foreground"
                        >
                          <Icon name="chevron" className={`size-3 shrink-0 ${open ? 'rotate-90' : ''}`} />
                          <Icon name="folder" className="size-3.5 shrink-0" />
                          <span className="truncate text-foreground/85">{folder.replace(window.api.home, '~')}</span>
                          {checkedCount > 0 && <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{checkedCount} selected</span>}
                        </button>
                        <span className="text-[11px] text-muted-foreground tabular-nums">{folderRepos.length}</span>
                        <button
                          title={allChecked ? 'Deselect folder' : 'Select all projects in folder'}
                          onClick={() => setFolderSelected(folderRepos, !allChecked)}
                          className={`ml-1.5 grid size-4 shrink-0 place-items-center rounded ${
                            allChecked ? 'bg-primary text-white' : checkedCount > 0 ? 'bg-primary/40 text-white' : 'ring-1 ring-foreground/25'
                          }`}
                        >
                          {allChecked ? <Icon name="check" className="size-3" /> : checkedCount > 0 && <span className="h-0.5 w-2 rounded bg-white" />}
                        </button>
                      </div>
                      {open &&
                        folderRepos.map((repo) => {
                          const checked = selected.includes(repo.path)
                          return (
                            <button
                              key={repo.path}
                              onClick={() => toggle(repo.path)}
                              className="flex h-8 w-full items-center gap-2.5 rounded-md pr-2 pl-7 text-left text-[13px] hover:bg-accent"
                            >
                              <span className="min-w-0 flex-1 truncate">{baseName(repo.path)}</span>
                              <span className="text-[11px] text-muted-foreground tabular-nums">{repo.worktrees.length}</span>
                              <span className={`grid size-4 shrink-0 place-items-center rounded ${checked ? 'bg-primary text-white' : 'ring-1 ring-foreground/25'}`}>
                                {checked && <Icon name="check" className="size-3" />}
                              </span>
                            </button>
                          )
                        })}
                    </div>
                  )
                })}
                {visibleRepos.length === 0 && <p className="px-3 py-6 text-center text-xs text-muted-foreground">No matching projects</p>}
              </div>
            </div>
          </div>

          {selected.length >= 2 && (
            <div className="flex flex-col gap-1.5 text-xs text-muted-foreground">
              New terminals open in
              <div className="flex flex-wrap gap-1">
                {['', ...selected].map((path) => {
                  const chosen = (selected.includes(terminalPath) ? terminalPath : '') === path
                  return (
                    <button
                      key={path || 'common'}
                      aria-pressed={chosen}
                      onClick={() => setTerminalPath(path)}
                      title={path ? path.replace(window.api.home, '~') : 'The folder that holds all selected projects'}
                      className={`h-7 rounded-md px-2.5 text-xs ring-1 ${chosen ? 'bg-accent text-foreground ring-border' : 'text-muted-foreground ring-transparent hover:bg-accent/60 hover:text-foreground'}`}
                    >
                      {path ? baseName(path) : 'Common folder'}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2 border-t border-border px-4 py-3">
          {workspace && (
            <button
              onClick={() => {
                if (!window.confirm(`Delete workspace ${workspace.name}? Projects and sessions are not affected.`)) return
                deleteWorkspace(workspace.id)
                onClose()
              }}
              className="h-7 rounded-md px-2.5 text-xs text-red-400 hover:bg-accent"
            >
              Delete workspace
            </button>
          )}
          <span className="flex-1" />
          <button onClick={onClose} className="h-7 rounded-md px-2.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
            Cancel
          </button>
          <button onClick={save} disabled={!canSave} className="h-7 rounded-md bg-primary px-3 text-xs font-medium text-white disabled:opacity-40">
            {workspace ? 'Save' : 'Create workspace'}
          </button>
        </div>
      </div>
    </div>
  )
}
