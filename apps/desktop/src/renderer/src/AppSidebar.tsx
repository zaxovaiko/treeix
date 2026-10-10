import { useState, useSyncExternalStore } from 'react'
import { ISLAND, type SessionSummary, type SidebarSection, useHost } from '@treeix/sdk'
import type { Repo } from '../../shared/types'
import { ActivityMark, NEWS } from './activity'
import { openMenu } from './contextMenu'
import { ErrorBoundary } from './ErrorBoundary'
import { Icon } from './Icon'
import { usePlugins, useSessions } from './plugins'
import { activityOf, KindBadge, StatusDot } from './sessionUi'
import { digitLabel } from './settings'
import { IconButton, ResizeHandle } from './ui'
import { Badge } from './WorkspaceSwitcher'
import { ALL_PROJECTS, commonFolder, deleteWorkspace, HOME, inWorkspace, moveWorkspace, useWorkspaces, type Workspace } from './workspaces'
import { actionKeys } from '../../shared/keymap'

const TERMINAL_TAB = 'terminal'
const noSubscription = (): (() => void) => () => undefined
const HEADING = 'text-[11px] font-semibold text-foreground'
const ROW = 'group relative flex w-full min-w-0 items-center gap-2 rounded-md pr-1 text-left text-xs hover:text-foreground'
const WORKSPACE_MIME = 'application/x-treeix-workspace'

/** The scope with no workspace picked: every project, and every session but Home's. Only listed while it is the one on screen */
const ALL: Workspace = { id: ALL_PROJECTS, name: 'All projects', color: '#64748b', icon: 'folder', repoPaths: [] }

/** Where a quick shell starts for a workspace: the folder holding its projects, else home */
const workspaceFolder = (workspace: Workspace): string => (workspace.id === HOME.id ? window.api.home : commonFolder(workspace.repoPaths) || window.api.home)

function SectionHeader({ label, open, onToggle, children }: { label: string; open?: boolean; onToggle?: () => void; children?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex h-7 shrink-0 items-center gap-1 pr-0.5 pl-2">
      {onToggle ? (
        <button onClick={onToggle} className={`${HEADING} flex flex-1 items-center gap-1 hover:text-foreground`}>
          <Icon name="chevron" className={`size-3 ${open ? 'rotate-90' : ''}`} />
          {label}
        </button>
      ) : (
        <span className={`${HEADING} flex-1`}>{label}</span>
      )}
      {children}
    </div>
  )
}

/** The sessions of the workspace on screen, under its row */
function Sessions({ sessions }: { sessions: SessionSummary[] }): React.JSX.Element {
  const host = useHost()
  const open = (id: string): void => {
    host.setActiveTab(TERMINAL_TAB)
    host.service('sessions')?.reveal(id)
  }
  const service = host.service('sessions')
  // Read on every terminal change, as moving between split panes changes no session
  const active = useSyncExternalStore(service?.subscribe ?? noSubscription, () => service?.active() ?? null)
  // Highlighted only while the terminal shows it, so one row in the sidebar marks what is on screen
  const onScreen = host.activeTab === TERMINAL_TAB
  return (
    <>
      {sessions.map((session) => (
        // The close button sits beside the row, not in it, so its click does not also open the session
        <div key={session.id} className="group relative">
          <button
            onClick={() => open(session.id)}
            className={`${ROW} h-7 pl-7 hover:bg-accent ${session.id === active ? `font-medium text-foreground ${onScreen ? 'bg-accent' : ''}` : 'text-muted-foreground'}`}
          >
            {session.view === 'chat' ? <Icon name="comment" className="size-3.5 shrink-0 text-muted-foreground" /> : <KindBadge kind={session.kind} />}
            <span className="min-w-0 flex-1 truncate">{session.title}</span>
            <span className="flex group-hover:invisible">
              <StatusDot session={session} />
            </span>
          </button>
          <span className="absolute top-0 right-0 hidden group-hover:flex">
            <IconButton label="Close session" onClick={() => service?.close(session.id)}>
              <Icon name="close" className="size-3" />
            </IconButton>
          </span>
        </div>
      ))}
    </>
  )
}

function Workspaces({
  repos,
  onSwitch,
  onEdit,
  onHide
}: {
  repos: Repo[] | null
  onSwitch: (id: string) => void
  onEdit: (workspace: Workspace | null) => void
  onHide: () => void
}): React.JSX.Element {
  const host = useHost()
  const { workspaces, currentId } = useWorkspaces()
  const sessions = useSessions()
  const [drop, setDrop] = useState<{ id: string; edge: 'top' | 'bottom' } | null>(null)
  const [collapsed, setCollapsed] = useState(false)

  const newShell = (workspace: Workspace): void => {
    const service = host.service('sessions')
    if (!service) return host.flash('Sessions need the Terminal plugin')
    if (workspace.id !== currentId) onSwitch(workspace.id)
    host.setActiveTab(TERMINAL_TAB)
    void service.start(workspaceFolder(workspace), 'shell').then((id) => service.reveal(id))
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

  /** One workspace: its row, and the sessions it holds while it is the one on screen */
  const row = (workspace: Workspace, keys: string, extra?: Partial<React.ComponentProps<'button'>>): React.JSX.Element => {
    const current = workspace.id === currentId
    const open = current && !collapsed
    const own = sessions.filter((session) => inWorkspace(session, workspace.id === ALL_PROJECTS ? undefined : workspace, repos, workspaces))
    const activity = activityOf(own)
    const dropEdge = drop?.id === workspace.id ? drop.edge : null
    return (
      <div key={workspace.id}>
        <button
          data-workspace={workspace.id}
          title={`${workspace.id === HOME.id ? 'Shells in your home folder, outside every workspace' : workspace.id === ALL_PROJECTS ? 'Every project, across workspaces' : `${workspace.name}\n${workspace.repoPaths.map((path) => path.split('/').pop()).join(', ') || 'No projects yet'}`}${keys ? ` (${keys})` : ''}`}
          data-tip-side="right"
          aria-current={current || undefined}
          onClick={() => (current ? setCollapsed(!collapsed) : onSwitch(workspace.id))}
          {...extra}
          className={`${ROW} h-8 pl-0.5 ${current ? 'font-medium text-foreground' : ''}`}
        >
          {dropEdge && <span className={`pointer-events-none absolute inset-x-1 h-0.5 rounded-full bg-foreground/60 ${dropEdge === 'top' ? '-top-px' : '-bottom-px'}`} />}
          <Icon name="chevron" className={`size-3 shrink-0 text-muted-foreground ${open ? 'rotate-90' : ''}`} />
          <Badge workspace={workspace} className="size-5 rounded-md text-[9px]" />
          <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
          {/* The sessions show their own marks while the group is open; the plus takes this spot on hover */}
          <span className="flex shrink-0 items-center gap-1.5 pr-1 group-hover:invisible">
            {!open && NEWS.includes(activity) && <ActivityMark activity={activity} className="size-2" />}
            {!current && own.length > 0 && <span className="text-[11px] text-muted-foreground tabular-nums">{own.length}</span>}
          </span>
          <span className="absolute right-0.5 hidden group-hover:flex">
            <IconButton label={`New shell in ${workspace.name} (${actionKeys('terminal.newTab')})`} onClick={() => newShell(workspace)}>
              <Icon name="plus" className="size-3.5" />
            </IconButton>
          </span>
        </button>
        {open && <Sessions sessions={own} />}
      </div>
    )
  }

  return (
    <>
      <SectionHeader label="Workspaces">
        <IconButton label="New workspace" onClick={() => onEdit(null)}>
          <Icon name="plus" className="size-3.5" />
        </IconButton>
        <IconButton label={`Sidebar (${actionKeys('app.sidebar')})`} onClick={onHide}>
          <Icon name="panel" className="size-3.5" />
        </IconButton>
      </SectionHeader>
      {currentId === ALL_PROJECTS && row(ALL, '')}
      {workspaces.map((workspace, index) =>
        row(workspace, [`G ${index + 1}`, digitLabel('workspaces', index + 1)].filter(Boolean)[0] ?? '', {
          ...dragProps(workspace, index),
          onContextMenu: (event) =>
            openMenu(event, [
              { label: 'New shell here', run: () => newShell(workspace) },
              { label: 'Edit workspace…', run: () => onEdit(workspace) },
              null,
              {
                label: 'Delete workspace…',
                run: () => window.confirm(`Delete workspace ${workspace.name}? Projects and sessions are not affected.`) && deleteWorkspace(workspace.id)
              }
            ])
        })
      )}
      {row(HOME, actionKeys('workspace.home'))}
    </>
  )
}

/**
 * The app's left sidebar: the workspaces with the sessions of the one on screen, then the sections
 * plugins contribute (the hub's agents, workflows and history). With Island UI it floats over the page.
 */
export function AppSidebar({
  repos,
  island,
  width,
  onResize,
  onSwitch,
  onEdit,
  onHide
}: {
  repos: Repo[] | null
  island: boolean
  width: number
  onResize: (width: number) => void
  onSwitch: (id: string) => void
  onEdit: (workspace: Workspace | null) => void
  onHide: () => void
}): React.JSX.Element {
  const { loaded } = usePlugins()
  const [folded, setFolded] = useState<string[]>([])
  const sections: SidebarSection[] = loaded.flatMap(({ plugin }) => plugin.sidebar ?? []).sort((a, b) => a.order - b.order)
  return (
    <div
      data-app-sidebar
      style={{ width, minWidth: 180 }}
      className={island ? `absolute top-2 bottom-2 left-2 z-20 flex flex-col overflow-hidden ${ISLAND}` : 'relative flex shrink-0 flex-col border-r border-border bg-sidebar'}
    >
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-1.5">
        <Workspaces repos={repos} onSwitch={onSwitch} onEdit={onEdit} onHide={onHide} />
        {sections.map((section) => (
          <div key={section.id} data-sidebar-section={section.id}>
            <SectionHeader
              label={section.label}
              open={!folded.includes(section.id)}
              onToggle={() => setFolded(folded.includes(section.id) ? folded.filter((id) => id !== section.id) : [...folded, section.id])}
            >
              {section.Actions && <section.Actions />}
            </SectionHeader>
            {!folded.includes(section.id) && (
              <ErrorBoundary label={section.label} resetKey={section.id}>
                <section.render />
              </ErrorBoundary>
            )}
          </div>
        ))}
      </div>
      <ResizeHandle onResize={onResize} />
    </div>
  )
}
