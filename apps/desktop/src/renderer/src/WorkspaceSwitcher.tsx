import { useEffect, useRef, useState } from 'react'
import type { Repo } from '../../shared/types'
import { openMenu } from './contextMenu'
import { Icon } from './Icon'
import { digitLabel } from './settings'
import { baseName } from './Sidebar'
import { Kbd, type SessionSummary } from '@treeix/sdk'
import { type Activity, ActivityMark, NEWS } from './activity'
import { activityOf } from './sessionUi'
import { useSessions } from './plugins'
import { Dialog, Popup } from './ui'
import { actionKeys } from '../../shared/keymap'
import {
  deleteWorkspace,
  HOME,
  initials,
  inWorkspace,
  moveWorkspace,
  saveWorkspace,
  suggestWorkspaceName,
  useWorkspaces,
  type Workspace,
  workspaceOf,
  shades,
  WORKSPACE_COLORS
} from './workspaces'

const workspaceActivity = (sessions: SessionSummary[], workspace: Workspace, repos: Repo[] | null, workspaces: Workspace[]): Activity =>
  activityOf(sessions.filter((session) => inWorkspace(session, workspace, repos, workspaces)))

const WORKSPACE_MIME = 'application/x-treeix-workspace'

function Badge({ workspace, className }: { workspace: Workspace; className: string }): React.JSX.Element {
  const home = workspace.id === HOME.id
  return (
    <span
      style={home ? undefined : { background: workspace.color }}
      className={`grid shrink-0 place-items-center overflow-hidden font-bold ${home ? 'bg-foreground/8 font-mono text-muted-foreground' : 'text-white'} ${className}`}
    >
      {home ? '~' : <Avatar workspace={workspace} />}
    </span>
  )
}

/** The title bar's workspace chip: the current workspace, a menu of all of them, and a mark when an agent elsewhere is busy or waiting */
export function WorkspaceSwitcher({
  repos,
  onSwitch,
  onEdit,
  onReturn
}: {
  repos: Repo[] | null
  onSwitch: (id: string) => void
  /** Opens the editor; null creates a new workspace */
  onEdit: (workspace: Workspace | null) => void
  /** Set while the AI Hub fills the window: a click goes back to the workspace instead of opening the menu */
  onReturn?: () => void
}): React.JSX.Element {
  const { workspaces, currentId } = useWorkspaces()
  const sessions = useSessions()
  const [open, setOpen] = useState(false)
  const [drop, setDrop] = useState<{ id: string; edge: 'top' | 'bottom' } | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  const current = workspaceOf(workspaces, currentId)
  const elsewhere = current ? activityOf(sessions.filter((session) => !inWorkspace(session, current, repos, workspaces))) : 'none'
  const close = (): void => setOpen(false)
  const pick = (id: string): void => {
    close()
    if (id !== currentId) onSwitch(id)
  }

  const dragProps = (workspace: Workspace, index: number): React.HTMLAttributes<HTMLButtonElement> & { draggable: true } => ({
    draggable: true,
    // No state updates in dragstart: React re-rendering there makes Chromium cancel the drag
    onDragStart: (event) => {
      event.dataTransfer.setData(WORKSPACE_MIME, workspace.id)
      event.dataTransfer.effectAllowed = 'move'
    },
    onDragOver: (event) => {
      if (!event.dataTransfer.types.includes(WORKSPACE_MIME)) return
      event.preventDefault()
      const box = event.currentTarget.getBoundingClientRect()
      const edge = event.clientY < box.top + box.height / 2 ? 'top' : 'bottom'
      if (drop?.id !== workspace.id || drop.edge !== edge) setDrop({ id: workspace.id, edge })
    },
    onDragLeave: () => setDrop(null),
    onDragEnd: () => setDrop(null),
    onDrop: (event) => {
      const id = event.dataTransfer.getData(WORKSPACE_MIME)
      if (!id) return
      event.preventDefault()
      setDrop(null)
      const beforeId = drop?.edge === 'bottom' ? (workspaces[index + 1]?.id ?? null) : workspace.id
      moveWorkspace(id, beforeId === id ? (workspaces[index + 2]?.id ?? null) : beforeId)
    }
  })

  const row = (workspace: Workspace, title: string, keys: string, extra?: Partial<React.ComponentProps<'button'>>): React.JSX.Element => {
    const activity = workspaceActivity(sessions, workspace, repos, workspaces)
    const dropEdge = drop?.id === workspace.id ? drop.edge : null
    return (
      <button
        key={workspace.id}
        data-workspace={workspace.id}
        title={title}
        aria-current={workspace.id === currentId || undefined}
        onClick={() => pick(workspace.id)}
        {...extra}
        className={`relative flex h-8 w-full shrink-0 items-center gap-2 rounded-md px-1.5 text-left hover:bg-accent ${workspace.id === currentId ? 'bg-accent' : ''}`}
      >
        {dropEdge && <span className={`pointer-events-none absolute inset-x-1 h-0.5 rounded-full bg-foreground/60 ${dropEdge === 'top' ? '-top-px' : '-bottom-px'}`} />}
        <Badge workspace={workspace} className="size-5 rounded-md text-[9px]" />
        <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
        {NEWS.includes(activity) && <ActivityMark activity={activity} />}
        {keys && <Kbd hint>{keys}</Kbd>}
      </button>
    )
  }

  return (
    <>
      <button
        ref={button}
        data-workspace-switcher
        title={onReturn ? 'Back to the workspace' : `Workspaces${current ? ` · ${current.name}` : ''}`}
        aria-expanded={open}
        onClick={() => (onReturn ? onReturn() : setOpen(!open))}
        className={`relative flex h-6 max-w-48 min-w-0 shrink-0 items-center gap-1.5 rounded-md pr-1.5 pl-1 text-xs hover:bg-accent ${
          onReturn ? 'text-muted-foreground hover:text-foreground' : `text-foreground ring-1 ring-border ring-inset ${open ? 'bg-accent' : 'bg-background'}`
        }`}
      >
        {current ? <Badge workspace={current} className="size-[18px] rounded-[5px] text-[8px]" /> : <Icon name="folder" className="size-3.5 text-muted-foreground" />}
        <span className="truncate">{current?.name ?? 'All projects'}</span>
        <Icon name="chevron" className="size-3 shrink-0 rotate-90 text-muted-foreground" />
        {NEWS.includes(elsewhere) && (
          <span className="absolute -top-1 -right-1 grid size-3.5 place-items-center rounded-full bg-card">
            <ActivityMark activity={elsewhere} className="size-2" />
          </span>
        )}
      </button>
      {open && (
        <Popup
          anchor={button}
          onDismiss={close}
          // Esc closes the menu, and only it: the shell must not also move focus to another zone
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            event.stopPropagation()
            close()
          }}
          className="flex max-h-[70vh] w-64 flex-col overflow-y-auto rounded-lg border border-input bg-popover p-1 text-xs"
        >
          {workspaces.map((workspace, index) => {
            const keys = index < 9 ? [`G ${index + 1}`, digitLabel('workspaces', index + 1)].filter(Boolean) : []
            return row(workspace, `${workspace.repoPaths.map(baseName).join(', ') || 'no projects'}${keys.length ? ` (${keys.join(', ')})` : ''}`, keys[0] ?? '', {
              ...dragProps(workspace, index),
              onContextMenu: (event) =>
                openMenu(event, [
                  { label: 'Open', run: () => pick(workspace.id) },
                  { label: 'Edit workspace…', run: () => (close(), onEdit(workspace)) },
                  null,
                  {
                    label: 'Delete workspace…',
                    run: () => window.confirm(`Delete workspace ${workspace.name}? Projects and sessions are not affected.`) && deleteWorkspace(workspace.id)
                  }
                ])
            })
          })}
          {workspaces.length > 0 && <hr className="my-1 border-border" />}
          {row(HOME, `Home: terminals in ~, outside every workspace (${actionKeys('workspace.home')})`, actionKeys('workspace.home'))}
          <button
            onClick={() => (close(), onEdit(null))}
            className="flex h-8 w-full shrink-0 items-center gap-2 rounded-md px-1.5 text-left text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <span className="grid size-5 place-items-center">
              <Icon name="plus" className="size-3.5" />
            </span>
            New workspace
          </button>
        </Popup>
      )}
    </>
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
  // Shades stay those of the colour picked, not of the shade clicked last
  const [shadeBase, setShadeBase] = useState(color)
  const pickColor = (next: string): void => {
    setColor(next)
    setShadeBase(next)
  }
  const [avatarText, setAvatarText] = useState(workspace?.avatarText ?? '')
  const [avatarImage, setAvatarImage] = useState(workspace?.avatarImage ?? '')
  const [imageError, setImageError] = useState('')
  const pickImage = (file: File | undefined): void => {
    if (!file) return
    shrinkImage(file).then(
      (image) => (setAvatarImage(image), setImageError('')),
      () => setImageError(`${file.name} isn't an image`)
    )
  }
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
      ...(avatarText.trim() ? { avatarText: avatarText.trim() } : {}),
      ...(avatarImage ? { avatarImage } : {}),
      repoPaths: selected,
      ...(terminalPath && selected.includes(terminalPath) ? { terminalPath } : {})
    }
    saveWorkspace(next)
    onSaved(next)
  }

  return (
    <Dialog onClose={onClose} offset="pt-[10vh]" className="flex max-h-[80vh] w-[600px] max-w-[92vw] flex-col">
      <div className="flex h-12 shrink-0 items-center border-b border-border pr-2 pl-4">
        <span className="text-sm font-medium">{workspace ? 'Edit workspace' : 'New workspace'}</span>
        <button onClick={onClose} aria-label="Close" className="ml-auto grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent">
          <Icon name="close" className="size-3.5" />
        </button>
      </div>

      <div className="flex min-h-0 flex-col gap-5 overflow-y-auto p-4">
        <div className="flex items-end gap-3">
          <div className="flex shrink-0 flex-col items-center gap-1.5">
            <label
              title="Upload an image"
              style={{ background: color }}
              className="grid size-11 cursor-pointer place-items-center overflow-hidden rounded-xl text-base font-bold text-white"
            >
              <Avatar workspace={{ name: finalName || '?', avatarText: avatarText.trim(), avatarImage }} />
              <input type="file" accept="image/*" aria-label="Avatar image" className="hidden" onChange={(event) => pickImage(event.target.files?.[0])} />
            </label>
            <input
              value={avatarText}
              onChange={(event) => setAvatarText(event.target.value.slice(0, 4))}
              aria-label="Avatar text"
              placeholder={initials(finalName || '?')}
              className="h-6 w-11 rounded-md border border-input bg-muted text-center text-[11px] text-foreground outline-none placeholder:text-muted-foreground/60"
            />
            {avatarImage && (
              <button onClick={() => setAvatarImage('')} className="text-[11px] text-muted-foreground hover:text-foreground">
                Remove
              </button>
            )}
          </div>
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
              {[...WORKSPACE_COLORS, ...(WORKSPACE_COLORS.includes(shadeBase) ? [] : [shadeBase])].map((swatch) => (
                <button
                  key={swatch}
                  aria-label={`Colour ${swatch}`}
                  onClick={() => pickColor(swatch)}
                  style={{ background: swatch }}
                  className="grid size-5 place-items-center rounded-md text-white"
                >
                  {color === swatch && <Icon name="check" className="size-3" />}
                </button>
              ))}
              <label
                title="Any colour or shade"
                className="grid size-5 cursor-pointer place-items-center rounded-md text-muted-foreground ring-1 ring-border hover:text-foreground"
              >
                <Icon name="plus" className="size-3" />
                <input type="color" aria-label="Custom colour" value={color} onChange={(event) => pickColor(event.target.value)} className="sr-only" />
              </label>
            </div>
            <div className="flex items-center gap-1.5">
              {shades(shadeBase).map((shade) => (
                <button
                  key={shade}
                  aria-label={`Shade ${shade}`}
                  onClick={() => setColor(shade)}
                  style={{ background: shade }}
                  className={`size-4 rounded ${color === shade ? 'ring-2 ring-foreground/60' : ''}`}
                />
              ))}
            </div>
            <input
              aria-label="Colour hex"
              defaultValue={color}
              key={color}
              onBlur={(event) => /^#[0-9a-f]{6}$/i.test(event.target.value.trim()) && pickColor(event.target.value.trim().toLowerCase())}
              onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
              className="h-6 w-20 rounded-md border border-input bg-muted px-1.5 font-mono text-[11px] text-foreground outline-none"
            />
            {imageError && <span className="text-[11px] text-destructive">{imageError}</span>}
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
                      <button onClick={() => toggleFolder(folder)} className="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-1.5 text-left text-xs text-muted-foreground">
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
    </Dialog>
  )
}

function Avatar({ workspace }: { workspace: Pick<Workspace, 'name' | 'avatarText' | 'avatarImage'> }): React.JSX.Element {
  if (workspace.avatarImage) return <img src={workspace.avatarImage} alt="" className="size-full rounded-[inherit] object-cover" />
  const text = workspace.avatarText || initials(workspace.name)
  // Four letters fit the same square a size down
  return text.length > 3 ? <span className="text-[0.8em] tracking-tight">{text}</span> : <>{text}</>
}

const AVATAR_PIXELS = 96

/** Cropped square and scaled down, so a photo doesn't fill localStorage */
export async function shrinkImage(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file)
  const side = Math.min(bitmap.width, bitmap.height)
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = AVATAR_PIXELS
  canvas.getContext('2d')?.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, AVATAR_PIXELS, AVATAR_PIXELS)
  bitmap.close()
  return canvas.toDataURL('image/png')
}
