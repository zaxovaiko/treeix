import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ISLAND, type SessionSummary, type SidebarSection, useHost } from '@treeix/sdk'
import type { Repo } from '../../shared/types'
import { ActivityMark, NEWS } from './activity'
import { chatAgent, getAgents, isChatOnly } from './agents'
import { type MenuAction, openMenu } from './contextMenu'
import { ErrorBoundary } from './ErrorBoundary'
import { Icon } from './Icon'
import { usePlugins, useSessions } from './plugins'
import { activityOf, KindBadge, SESSION_MIME, StatusDot } from './sessionUi'
import { digitLabel, toggleIn } from './settings'
import { IconButton, NameInput, Popup, ResizeHandle } from './ui'
import { Badge } from './WorkspaceSwitcher'
import { ALL_PROJECTS, commonFolder, deleteWorkspace, HOME, inWorkspace, moveWorkspace, useWorkspaces, type Workspace } from './workspaces'
import { actionKeys } from '../../shared/keymap'

const TERMINAL_TAB = 'terminal'
const noSubscription = (): (() => void) => () => undefined
const HEADING = 'text-[11px] font-semibold text-foreground'
const ROW = 'group relative flex w-full min-w-0 items-center gap-2 rounded-md pr-1 text-left text-xs hover:text-foreground'
const WORKSPACE_MIME = 'application/x-treeix-workspace'
const MENU_CLOSE_MS = 150

/** The scope with no workspace picked: every project, and every session but Home's. Only listed while it is the one on screen */
const ALL: Workspace = { id: ALL_PROJECTS, name: 'All projects', color: '#64748b', icon: 'folder', repoPaths: [] }

/** Where a quick shell starts for a workspace: the folder holding its projects, else home */
const workspaceFolder = (workspace: Workspace): string => {
  if (workspace.id === HOME.id) return window.api.home
  if (workspace.terminalPath && workspace.repoPaths.includes(workspace.terminalPath)) return workspace.terminalPath
  return commonFolder(workspace.repoPaths) || window.api.home
}

/** `children` show while the header is hovered or holds the focus; `pinned` always */
function SectionHeader({
  label,
  open,
  onToggle,
  children,
  pinned
}: {
  label: string
  open?: boolean
  onToggle?: () => void
  children?: React.ReactNode
  pinned?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="group/header flex h-7 shrink-0 items-center gap-1 pr-0.5 pl-2">
      {onToggle ? (
        <button onClick={onToggle} aria-expanded={open} className={`${HEADING} flex flex-1 items-center gap-1 hover:text-foreground`}>
          <Icon name="chevron" className={`size-3 ${open ? 'rotate-90' : ''}`} />
          {label}
        </button>
      ) : (
        <span className={`${HEADING} flex-1`}>{label}</span>
      )}
      <span className="flex opacity-0 group-hover/header:opacity-100 focus-within:opacity-100">{children}</span>
      {pinned}
    </div>
  )
}

/** The sessions of the workspace on screen, under its row */
function Sessions({ sessions, onOpen, indent = 'pl-7' }: { sessions: SessionSummary[]; onOpen: () => void; indent?: string }): React.JSX.Element {
  const host = useHost()
  const open = (id: string): void => {
    onOpen()
    host.setActiveTab(TERMINAL_TAB)
    host.service('sessions')?.reveal(id)
  }
  const service = host.service('sessions')
  // Read on every terminal change, as moving between split panes changes no session
  const active = useSyncExternalStore(service?.subscribe ?? noSubscription, () => service?.active() ?? null)
  // Highlighted only while the terminal shows it, so one row in the sidebar marks what is on screen
  const onScreen = host.activeTab === TERMINAL_TAB
  const [editing, setEditing] = useState<string | null>(null)
  return (
    <>
      {sessions.map((session) => {
        const icon = session.view === 'chat' ? <Icon name="comment" className="size-3.5 shrink-0 text-muted-foreground" /> : <KindBadge kind={session.kind} />
        if (session.id === editing)
          return (
            <div key={session.id} className={`${ROW} h-7 ${indent} bg-accent`}>
              {icon}
              <NameInput value={session.title} label="Session name" onSave={(name) => service?.rename(session.id, name)} onClose={() => setEditing(null)} />
            </div>
          )
        return (
          // The close button sits beside the row, not in it, so its click does not also open the session
          <div key={session.id} className="group relative">
            <button
              // A double click renames; opening again would focus the terminal and end the rename
              onClick={(event) => event.detail < 2 && open(session.id)}
              onDoubleClick={() => setEditing(session.id)}
              onContextMenu={(event) =>
                service &&
                openMenu(
                  event,
                  service.menu(session.id, host.flash, () => setEditing(session.id))
                )
              }
              // Dropped on a terminal pane, it opens beside it
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData(SESSION_MIME, session.id)
                event.dataTransfer.effectAllowed = 'move'
              }}
              className={`${ROW} h-7 ${indent} hover:bg-accent ${session.id === active ? `font-medium text-foreground ${onScreen ? 'bg-accent' : ''}` : 'text-muted-foreground'}`}
            >
              {icon}
              <span className="min-w-0 flex-1 truncate">{session.title}</span>
              {session.split && <Icon name="splitRight" className="size-3 shrink-0 text-muted-foreground" />}
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
        )
      })}
    </>
  )
}

// One plus menu at a time: the next row's opens before this one's grace runs out
let shownMenu: { close: () => void } | null = null

/** A workspace row's plus: a click starts the first entry, hovering lists them all */
function NewSessionMenu({ label, entries }: { label: string; entries: MenuAction[] }): React.JSX.Element {
  const anchor = useRef<HTMLSpanElement>(null)
  const [open, setOpen] = useState(false)
  const closing = useRef<ReturnType<typeof setTimeout>>(undefined)
  const self = useRef({ close: () => setOpen(false) })
  useEffect(() => () => clearTimeout(closing.current), [])
  const show = (): void => {
    if (shownMenu !== self.current) shownMenu?.close()
    shownMenu = self.current
    clearTimeout(closing.current)
    setOpen(true)
  }
  // A moment's grace, so the pointer can cross the gap to the menu
  const hide = (): void => {
    clearTimeout(closing.current)
    closing.current = setTimeout(() => setOpen(false), MENU_CLOSE_MS)
  }
  const run = (entry: MenuAction | undefined): void => {
    setOpen(false)
    entry?.run()
  }
  return (
    // Clicks stay out of the row, the portaled menu's too; React counts the menu as inside for hovering
    <span
      ref={anchor}
      onClick={(event) => event.stopPropagation()}
      onMouseEnter={show}
      onMouseLeave={hide}
      // The menu says what the plus does, so its tip stays away
      data-tip-off={open || undefined}
      className={`absolute right-0.5 ${open ? 'flex' : 'hidden group-hover:flex'}`}
    >
      <IconButton label={label} onClick={() => run(entries[0])}>
        <Icon name="plus" className="size-3.5" />
      </IconButton>
      {open && (
        <Popup anchor={anchor} align="beside" role="menu" className="w-44 rounded-lg border border-input bg-popover p-1">
          {entries.map((entry) => (
            <button key={entry.label} role="menuitem" onClick={() => run(entry)} className="flex h-7 w-full items-center rounded-md px-2 text-left text-xs hover:bg-accent">
              {entry.label}
            </button>
          ))}
        </Popup>
      )}
    </span>
  )
}

function Workspaces({ repos, onSwitch, onEdit }: { repos: Repo[] | null; onSwitch: (id: string) => void; onEdit: (workspace: Workspace | null) => void }): React.JSX.Element {
  const host = useHost()
  const { workspaces, currentId } = useWorkspaces()
  const sessions = useSessions()
  const [drop, setDrop] = useState<{ id: string; edge: 'top' | 'bottom' } | null>(null)
  // Several workspaces can be open at once; switching to one opens it
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([currentId]))
  useEffect(() => setExpanded((previous) => (previous.has(currentId) ? previous : new Set([...previous, currentId]))), [currentId])
  const toggle = (id: string): void => setExpanded((previous) => toggleIn(previous, id))

  const newSession = (workspace: Workspace, kind: string, view: 'terminal' | 'chat' = 'terminal'): void => {
    const service = host.service('sessions')
    if (!service) return host.flash('Sessions need the Terminal plugin')
    if (workspace.id !== currentId) {
      onSwitch(workspace.id)
      // Entering an empty Home starts its first shell already
      if (workspace.id === HOME.id && !sessions.some((session) => session.workspaceId === HOME.id)) return
    }
    host.setActiveTab(TERMINAL_TAB)
    void service.start(workspaceFolder(workspace), kind, undefined, view).then((id) => service.reveal(id))
  }

  const chat = host.service('chat') ? chatAgent() : null
  const newSessionEntries = (workspace: Workspace): MenuAction[] => [
    ...(chat ? [{ label: 'New chat here', run: () => newSession(workspace, chat.id, 'chat') }] : []),
    { label: 'New shell here', run: () => newSession(workspace, 'shell') },
    ...getAgents()
      .filter((agent) => agent.agent && !isChatOnly(agent))
      .map((agent) => ({ label: `New ${agent.label} here`, run: () => newSession(workspace, agent.id) }))
  ]

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
    const open = expanded.has(workspace.id)
    const own = sessions.filter((session) => inWorkspace(session, workspace.id === ALL_PROJECTS ? undefined : workspace, repos, workspaces))
    const activity = activityOf(own)
    const dropEdge = drop?.id === workspace.id ? drop.edge : null
    return (
      <div key={workspace.id}>
        <button
          data-workspace={workspace.id}
          title={`${workspace.id === ALL_PROJECTS ? 'Every project, across workspaces' : `${workspace.name}\n${workspace.repoPaths.map((path) => path.split('/').pop()).join(', ') || 'No projects yet'}`}${keys ? ` (${keys})` : ''}`}
          data-tip-side="right"
          aria-current={current || undefined}
          onClick={() => (current ? toggle(workspace.id) : onSwitch(workspace.id))}
          {...extra}
          className={`${ROW} h-8 pl-0.5 ${current ? 'font-medium text-foreground' : ''}`}
        >
          {dropEdge && <span className={`pointer-events-none absolute inset-x-1 h-0.5 rounded-full bg-foreground/60 ${dropEdge === 'top' ? '-top-px' : '-bottom-px'}`} />}
          {/* The chevron folds without switching, so other workspaces' sessions can stay in view */}
          <span
            onClick={(event) => {
              event.stopPropagation()
              toggle(workspace.id)
            }}
            className="-m-1 flex shrink-0 p-1"
          >
            <Icon name="chevron" className={`size-3 text-muted-foreground ${open ? 'rotate-90' : ''}`} />
          </span>
          <Badge workspace={workspace} className="size-5 rounded-md text-[9px]" />
          <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
          {/* The sessions show their own marks while the group is open; the plus takes this spot on hover */}
          <span className="flex shrink-0 items-center gap-1.5 pr-1 group-hover:invisible">
            {!open && NEWS.includes(activity) && <ActivityMark activity={activity} className="size-2" />}
            {!open && own.length > 0 && <span className="text-[11px] text-muted-foreground tabular-nums">{own.length}</span>}
          </span>
          <NewSessionMenu label={`New shell in ${workspace.name} (${actionKeys('terminal.newTab')})`} entries={newSessionEntries(workspace)} />
        </button>
        {open && <Sessions sessions={own} onOpen={() => current || onSwitch(workspace.id)} />}
      </div>
    )
  }

  return (
    <>
      {/* Shells outside every workspace, in the home folder, listed on their own rather than as a workspace */}
      <div>
        <SectionHeader label="Tabs">
          <IconButton label="New shell in your home folder" onClick={() => newSession(HOME, 'shell')}>
            <Icon name="plus" className="size-3.5" />
          </IconButton>
        </SectionHeader>
        <Sessions sessions={sessions.filter((session) => inWorkspace(session, HOME, repos, workspaces))} onOpen={() => currentId === HOME.id || onSwitch(HOME.id)} indent="pl-2" />
      </div>
      <SectionHeader label="Workspaces">
        <IconButton label="New workspace" onClick={() => onEdit(null)}>
          <Icon name="plus" className="size-3.5" />
        </IconButton>
      </SectionHeader>
      {currentId === ALL_PROJECTS && row(ALL, '')}
      {workspaces.map((workspace, index) =>
        row(workspace, [`G ${index + 1}`, digitLabel('workspaces', index + 1)].filter(Boolean)[0] ?? '', {
          ...dragProps(workspace, index),
          onContextMenu: (event) =>
            openMenu(event, [
              ...newSessionEntries(workspace),
              { label: 'Edit workspace…', run: () => onEdit(workspace) },
              null,
              {
                label: 'Delete workspace…',
                run: () => window.confirm(`Delete workspace ${workspace.name}? Projects and sessions are not affected.`) && deleteWorkspace(workspace.id)
              }
            ])
        })
      )}
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
  onEdit
}: {
  repos: Repo[] | null
  island: boolean
  width: number
  onResize: (width: number) => void
  onSwitch: (id: string) => void
  onEdit: (workspace: Workspace | null) => void
}): React.JSX.Element {
  const { loaded } = usePlugins()
  const [folded, setFolded] = useState<string[]>(['hub.history'])
  const sections: SidebarSection[] = loaded.flatMap(({ plugin }) => plugin.sidebar ?? []).sort((a, b) => a.order - b.order)
  return (
    <div
      data-app-sidebar
      style={{ width, minWidth: 180 }}
      className={island ? `absolute top-2 bottom-2 left-2 z-20 flex flex-col overflow-hidden ${ISLAND}` : 'relative flex shrink-0 flex-col border-r border-border bg-sidebar'}
    >
      <div className="flex min-h-0 flex-1 flex-col space-y-2 overflow-y-auto p-1.5">
        <Workspaces repos={repos} onSwitch={onSwitch} onEdit={onEdit} />
        {/* The last section, the hub's history, keeps to the bottom */}
        {sections.map((section, index) => (
          <div key={section.id} data-sidebar-section={section.id} className={index === sections.length - 1 ? 'mt-auto' : undefined}>
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
