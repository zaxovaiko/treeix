import { useEffect, useState } from 'react'
import type { Repo } from '../../shared/types'
import { Icon } from './Icon'
import { baseName } from './Sidebar'
import { Dialog } from './ui'
import {
  deleteWorkspace,
  HOME,
  initials,
  parseHex,
  saveWorkspace,
  suggestWorkspaceName,
  useWorkspaces,
  type Workspace,
  shades,
  WORKSPACE_COLORS,
  WORKSPACE_ICONS
} from './workspaces'

/** A workspace's square: its picture or initials on its colour, `~` for Home */
export function Badge({ workspace, className }: { workspace: Workspace; className: string }): React.JSX.Element {
  const home = workspace.id === HOME.id
  return (
    <span
      style={home ? undefined : badgeStyle(workspace)}
      className={`grid shrink-0 place-items-center overflow-hidden font-bold ${home ? 'bg-foreground/8 font-mono text-muted-foreground' : workspace.icon ? '' : 'text-white'} ${className}`}
    >
      {home ? '~' : <Avatar workspace={workspace} />}
    </span>
  )
}

/** An icon sits in its colour on a tint of it; initials stay white on the full colour */
const badgeStyle = ({ color, icon }: Pick<Workspace, 'color' | 'icon'>): React.CSSProperties => (icon ? { background: `${color}2e`, color } : { background: color })

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
  const [icon, setIcon] = useState(workspace?.icon)
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
      ...(icon ? { icon } : {}),
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
        <div className="flex items-start gap-3">
          <span
            style={badgeStyle({ color, icon })}
            className={`grid size-11 shrink-0 place-items-center overflow-hidden rounded-xl text-base font-bold ${icon ? '' : 'text-white'}`}
          >
            <Avatar workspace={{ name: finalName || '?', icon }} />
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
            <div className="flex h-6 items-center gap-1.5">
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
                className="ml-auto grid size-5 cursor-pointer place-items-center rounded-md text-muted-foreground ring-1 ring-border hover:text-foreground"
              >
                <Icon name="plus" className="size-3" />
                <input type="color" aria-label="Custom colour" value={color} onChange={(event) => pickColor(event.target.value)} className="sr-only" />
              </label>
            </div>
            <div className="flex h-6 items-center gap-1.5">
              {shades(shadeBase).map((shade) => (
                <button
                  key={shade}
                  aria-label={`Shade ${shade}`}
                  onClick={() => setColor(shade)}
                  style={{ background: shade }}
                  className={`size-4 rounded ${color === shade ? 'ring-2 ring-foreground/60' : ''}`}
                />
              ))}
              <input
                aria-label="Colour hex"
                defaultValue={color}
                key={color}
                onBlur={(event) => {
                  const typed = parseHex(event.target.value)
                  event.target.value = typed ?? color
                  if (typed) pickColor(typed)
                }}
                onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
                className="ml-auto h-6 w-20 rounded-md border border-input bg-muted px-1.5 font-mono text-[11px] text-foreground outline-none"
              />
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-1.5 text-xs text-muted-foreground">
          Icon
          {/* A fixed grid that scrolls, so adding icons never pushes the projects out of the dialog */}
          <div className="grid max-h-[136px] grid-cols-[repeat(auto-fill,minmax(36px,1fr))] gap-1 overflow-y-auto rounded-lg border border-border p-1.5">
            <button
              aria-label="Initials"
              aria-pressed={!icon}
              title="The workspace initials"
              onClick={() => setIcon(undefined)}
              style={icon ? undefined : { background: `${color}2e`, color }}
              className={`grid aspect-square place-items-center rounded-lg text-[11px] font-bold hover:bg-accent ${icon ? '' : 'ring-1 ring-current'}`}
            >
              {initials(finalName || '?')}
            </button>
            {WORKSPACE_ICONS.map((name) => (
              <button
                key={name}
                aria-label={`Icon ${name}`}
                aria-pressed={icon === name}
                onClick={() => setIcon(name)}
                style={icon === name ? { background: `${color}2e`, color } : undefined}
                className={`grid aspect-square place-items-center rounded-lg hover:bg-accent hover:text-foreground ${icon === name ? 'ring-1 ring-current' : ''}`}
              >
                <Icon name={name} className="size-4" />
              </button>
            ))}
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
        <button onClick={save} disabled={!canSave} className="h-7 rounded-md bg-primary px-3 text-xs font-medium text-white disabled:bg-muted disabled:text-muted-foreground">
          {workspace ? 'Save' : 'Create workspace'}
        </button>
      </div>
    </Dialog>
  )
}

function Avatar({ workspace }: { workspace: Pick<Workspace, 'name' | 'icon'> }): React.JSX.Element {
  if (workspace.icon) return <Icon name={workspace.icon} className="size-[62%]" />
  return <>{initials(workspace.name)}</>
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
