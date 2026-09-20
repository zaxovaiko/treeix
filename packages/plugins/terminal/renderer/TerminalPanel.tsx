import { Fragment, useEffect, useRef, useState } from 'react'
import type { Repo } from '@treeix/shared/types'
import { useService } from '@treeix/app/plugins'
import { actionKeys } from '@treeix/shared/keymap'
import { Icon } from '@treeix/app/Icon'
import { copyText, type MenuEntry, openMenu } from '@treeix/app/contextMenu'
import { KindBadge, StatusDot, worktreeLabel } from '@treeix/app/sessionUi'
import { agentOr, getAgents, useAgents } from '@treeix/app/agents'
import { useSettings } from '@treeix/app/settings'
import { timeAgo } from '@treeix/app/time'
import { ListToggle, usePanels } from '@treeix/sdk'
import { type DropEdge, edgeAt } from './paneLayout'
import { activeTabOf, aggregateStatus, type Task, type TerminalTab, tabPanes } from './tasks'
import { StatusMark } from './taskUi'
import {
  attachSession,
  clearTerminal,
  closeTab,
  type ClosedSession,
  createSession,
  fitSession,
  focusSession,
  focusShown,
  forgetClosedSession,
  killSession,
  pasteClipboard,
  placePane,
  restoreClosedSession,
  selectAllTerminal,
  setActiveTab,
  setTabFocus,
  splitPane,
  terminalSelection,
  type Session,
  type SessionKind,
  useTerminals
} from './terminals'

const SESSION_MIME = 'application/x-treeix-session'

/** Dragged panes or tabs carry their session ids, space separated */
const draggingSession = (event: React.DragEvent): boolean => event.dataTransfer.types.includes(SESSION_MIME)
const draggedSessions = (event: React.DragEvent): string[] => event.dataTransfer.getData(SESSION_MIME).split(' ').filter(Boolean)

/** Starts a session as a new tab of the task and focuses it */
export const openTab = (cwd: string, kind: SessionKind, taskId?: string): void => void createSession(cwd, kind, undefined, taskId).then((id) => setTimeout(() => focusSession(id)))

const restore = (entry: ClosedSession): void => void restoreClosedSession(entry).then((id) => setTimeout(() => focusSession(id)))

/** Closed sessions, newest first; a row starts the session again as a new tab, resuming an agent conversation */
export function ClosedSessions({ entries, repos }: { entries: ClosedSession[]; repos: Repo[] | null }): React.JSX.Element {
  if (entries.length === 0) return <p className="px-3 py-1 text-xs text-muted-foreground">Closed sessions land here</p>
  return (
    <div className="flex flex-col gap-0.5">
      {entries.map((entry) => (
        <div key={entry.id} className="group/closed flex h-7 min-w-0 items-center gap-1 rounded-md hover:bg-accent">
          <button
            title={`${entry.kind === 'shell' ? 'Reopen' : 'Resume'} in ${entry.worktreePath}`}
            onClick={() => restore(entry)}
            className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-left text-xs text-foreground/80 hover:text-foreground"
          >
            <KindBadge kind={entry.kind} />
            <span className="min-w-0 truncate">{entry.title}</span>
            <span className="min-w-0 truncate text-[10.5px] text-muted-foreground">{worktreeLabel(repos, entry.worktreePath)}</span>
            <span className="flex-1" />
            <span className="shrink-0 text-[10.5px] text-muted-foreground">{timeAgo(new Date(entry.endedAt).toISOString())}</span>
          </button>
          <button
            title="Remove from history"
            aria-label="Remove from history"
            onClick={() => forgetClosedSession(entry.id)}
            className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground opacity-0 group-hover/closed:opacity-100 hover:text-red-400 focus-visible:opacity-100"
          >
            <Icon name="trash" className="size-3" />
          </button>
        </div>
      ))}
    </div>
  )
}

/** Actions of a session, in its pane header, tab and terminal menus */
const sessionEntries = (session: Session, task: Task | null): MenuEntry[] => [
  { label: `New ${agentOr(session.kind).label} tab here`, run: () => openTab(session.worktreePath, session.kind, task?.id) },
  null,
  { label: 'Copy working directory', run: () => copyText(session.worktreePath) },
  { label: 'Reveal in Finder', run: () => window.api.revealInFinder(session.worktreePath) },
  null,
  { label: 'Close session', accelerator: 'CmdOrCtrl+W', run: () => killSession(session.id) }
]

const MIN_PANE_PX = 80

/** Drags the border between two neighbouring panes, trading flex weight between just those two */
function SplitDivider({
  axis,
  before,
  after,
  weights,
  onResize
}: {
  axis: 'x' | 'y'
  before: string
  after: string
  weights: Record<string, number>
  onResize: (weights: Record<string, number>) => void
}): React.JSX.Element {
  const startDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    const handle = event.currentTarget
    const previous = handle.parentElement?.previousElementSibling
    const next = handle.parentElement?.nextElementSibling
    if (!previous || !next) return
    const size = (element: Element): number => element.getBoundingClientRect()[axis === 'x' ? 'width' : 'height']
    const pair = size(previous) + size(next)
    const pairWeight = (weights[before] ?? 1) + (weights[after] ?? 1)
    const startBefore = size(previous)
    const start = axis === 'x' ? event.clientX : event.clientY
    handle.setPointerCapture(event.pointerId)
    handle.onpointermove = (move) => {
      const beforePx = Math.min(pair - MIN_PANE_PX, Math.max(MIN_PANE_PX, startBefore + (axis === 'x' ? move.clientX : move.clientY) - start))
      onResize({ ...weights, [before]: (beforePx / pair) * pairWeight, [after]: ((pair - beforePx) / pair) * pairWeight })
    }
    handle.onpointerup = () => {
      handle.onpointermove = null
    }
  }
  return (
    <div className={`relative shrink-0 bg-border ${axis === 'x' ? 'w-px' : 'h-px'}`}>
      <div
        onPointerDown={startDrag}
        onDoubleClick={() => onResize({ ...weights, [before]: 1, [after]: 1 })}
        title="Drag to resize, double-click to even out"
        className={`absolute z-10 hover:bg-foreground/30 active:bg-foreground/40 ${axis === 'x' ? 'inset-y-0 -left-[2px] w-[5px] cursor-col-resize' : 'inset-x-0 -top-[2px] h-[5px] cursor-row-resize'}`}
      />
    </div>
  )
}

function TerminalPane({
  session,
  task,
  number,
  active,
  framed,
  repos,
  horizontal
}: {
  session: Session
  task: Task | null
  /** Position for ⌥ digits */
  number: number
  /** Last focused pane of the tab */
  active: boolean
  /** More than one pane shows, so the active one gets a frame */
  framed: boolean
  repos: Repo[] | null
  horizontal: boolean
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const [dropEdge, setDropEdge] = useState<DropEdge | null>(null)
  const edgeOf = (event: React.DragEvent): DropEdge => {
    const rect = event.currentTarget.getBoundingClientRect()
    return edgeAt(event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height, horizontal)
  }
  // The plans plugin, when enabled, links Claude sessions to the plan they wrote
  const plans = useService('plans')

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    attachSession(session.id, host)
    const observer = new ResizeObserver(() => fitSession(session.id))
    observer.observe(host)
    return () => observer.disconnect()
  }, [session.id])

  return (
    <div
      data-session-id={session.id}
      // The shell focuses the zone's active pane through this; the terminal inside takes the keys
      data-zone-focus={active ? '' : undefined}
      tabIndex={-1}
      onFocus={(event) => {
        if (event.target === event.currentTarget) focusSession(session.id)
        else setTabFocus(session.id)
      }}
      onMouseDown={() => focusSession(session.id)}
      onDragOver={(event) => {
        if (!draggingSession(event)) return
        event.preventDefault()
        setDropEdge(edgeOf(event))
      }}
      onDragLeave={() => setDropEdge(null)}
      onDrop={(event) => {
        if (!draggingSession(event)) return
        event.preventDefault()
        setDropEdge(null)
        placePane(draggedSessions(event), session.id, edgeOf(event))
      }}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background"
    >
      {dropEdge && (
        // Shades the half the dropped terminal will take
        <span
          className={`pointer-events-none absolute z-20 bg-foreground/15 ${
            { left: 'inset-y-0 left-0 w-1/2', right: 'inset-y-0 right-0 w-1/2', top: 'inset-x-0 top-0 h-1/2', bottom: 'inset-x-0 bottom-0 h-1/2' }[dropEdge]
          }`}
        />
      )}
      {/* A lone pane goes without: its tab carries the title, close, menu and dragging */}
      {framed && (
        <div
          draggable
          onDragStart={(event) => event.dataTransfer.setData(SESSION_MIME, session.id)}
          onContextMenu={(event) => openMenu(event, sessionEntries(session, task))}
          className={`flex h-7 shrink-0 cursor-grab items-center gap-2 border-b border-border bg-card px-2 active:cursor-grabbing ${active ? 'text-foreground' : 'text-foreground/60'}`}
        >
          <Icon name="grip" className="-mx-1 size-3 shrink-0 text-muted-foreground/50" />
          <KindBadge kind={session.kind} />
          <span className={`min-w-0 truncate text-xs ${active ? 'font-medium' : ''}`}>{session.title}</span>
          {task?.worktreePath !== session.worktreePath && <span className="min-w-0 truncate text-[11px] text-muted-foreground">{worktreeLabel(repos, session.worktreePath)}</span>}
          <span className="flex-1" />
          {plans && (session.kind === 'claude' || session.planName) && <plans.PlanButton startedAt={session.startedAt} name={session.planName} />}
          {number <= 9 && (
            <span data-key-hint="" title={`Focus with ⌥${number}`} className={`shrink-0 rounded px-1 text-[10.5px] leading-4 tabular-nums ${active ? 'bg-foreground/10 text-foreground' : 'text-muted-foreground/60'}`}>
              ⌥{number}
            </span>
          )}
          <StatusDot session={session} />
          <button
            title="Close to History (⌘W)"
            aria-label="Close session"
            onClick={() => killSession(session.id)}
            className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Icon name="close" className="size-3" />
          </button>
        </div>
      )}
      <div
        ref={hostRef}
        // The active pane shows by the others dimming, no frame
        className={`min-h-0 flex-1 ${active || !framed ? '' : 'opacity-75'}`}
        onContextMenu={(event) =>
          openMenu(event, [
            { label: 'Copy', enabled: terminalSelection(session.id) !== '', accelerator: 'CmdOrCtrl+C', run: () => copyText(terminalSelection(session.id)) },
            { label: 'Paste', accelerator: 'CmdOrCtrl+V', run: () => void pasteClipboard(session.id) },
            { label: 'Select all', run: () => selectAllTerminal(session.id) },
            null,
            { label: 'Clear scrollback', run: () => clearTerminal(session.id) },
            null,
            ...sessionEntries(session, task)
          ])
        }
      />
    </div>
  )
}

const stripButton = 'grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground'

function TabButton({ task, tab, index, count, sessions }: { task: Task; tab: TerminalTab; index: number; count: number; sessions: Session[] }): React.JSX.Element | null {
  const panes = tabPanes(tab)
  const shown = sessions.find((session) => session.id === tab.focus) ?? sessions.find((session) => session.id === panes[0])
  if (!shown) return null
  const [dropping, setDropping] = useState(false)
  const active = tab.id === activeTabOf(task)?.id
  const status = aggregateStatus(sessions.filter((session) => panes.includes(session.id)).map((session) => session.status))
  // ⌘9 is the last tab, like browsers
  const digit = index === count - 1 && index >= 8 ? 9 : index < 8 ? index + 1 : null
  return (
    <div
      draggable
      onDragStart={(event) => event.dataTransfer.setData(SESSION_MIME, panes.join(' '))}
      onContextMenu={(event) => openMenu(event, sessionEntries(shown, task))}
      onDragOver={(event) => {
        if (!draggingSession(event)) return
        event.preventDefault()
        setDropping(true)
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(event) => {
        if (!draggingSession(event)) return
        event.preventDefault()
        setDropping(false)
        // A pane or tab dropped on a tab joins it as a split
        const moved = draggedSessions(event).filter((id) => !panes.includes(id))
        if (moved.length === 0) return
        placePane(moved, tab.focus, 'right')
        setActiveTab(task.id, tab.id)
        focusShown()
      }}
      className={`group/tab flex h-6 max-w-56 min-w-0 shrink-0 items-center rounded-md text-xs ${active || dropping ? 'bg-foreground/10 text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'}`}
    >
      <button
        title={`${shown.title}${digit ? ` (⌘${digit} in a terminal)` : ''}`}
        onClick={() => {
          setActiveTab(task.id, tab.id)
          focusShown()
        }}
        className="flex h-6 min-w-0 items-center gap-1.5 rounded-md pr-1 pl-2"
      >
        <KindBadge kind={shown.kind} />
        <span className="min-w-0 truncate">{shown.title}</span>
        {panes.length > 1 && (
          <span title={`${panes.length} panes`} className="flex shrink-0 items-center gap-0.5 text-[10.5px] text-muted-foreground tabular-nums">
            <Icon name="splitRight" className="size-3" />
            {panes.length}
          </span>
        )}
        {status !== 'idle' && <StatusMark status={status} />}
        {digit && <span data-key-hint="" className="shrink-0 text-[10.5px] text-muted-foreground/60">⌘{digit}</span>}
      </button>
      <button
        title="Close tab; its sessions go to History"
        aria-label="Close tab"
        onClick={() => closeTab(task.id, tab.id)}
        className={`mr-1 grid size-4 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground ${active ? '' : 'opacity-0 group-hover/tab:opacity-100 focus-visible:opacity-100'}`}
      >
        <Icon name="close" className="size-3" />
      </button>
    </div>
  )
}

/** Tabs of the task with new tab and split buttons; on the Terminal page also the list and inspector toggles. `sessions` are the task's */
function TabStrip({ task, label, cwd, sessions, page, onHide }: { task: Task | null; label: string; cwd: string; sessions: Session[]; page: boolean; onHide?: () => void }): React.JSX.Element {
  const panels = usePanels()
  const newTab = (kind: SessionKind): void => openTab(task?.worktreePath ?? cwd, kind, task?.id)
  const plans = useService('plans')
  const activeTab = task ? activeTabOf(task) : undefined
  // A lone pane has no header, so its plan shows here
  const lone = activeTab && tabPanes(activeTab).length === 1 ? sessions.find((session) => session.id === tabPanes(activeTab)[0]) : undefined
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-card px-1.5">
      {page && (
        <div className="flex min-w-0 shrink-0 items-center gap-1 pr-1">
          <ListToggle />
          {!panels.list && (
            // Just a label for the group on screen; the list toggle beside it is the one control
            <span className="flex h-6 max-w-48 min-w-0 cursor-default items-center gap-1.5 px-1 text-xs text-muted-foreground">
              <Icon name="folder" className="size-3 shrink-0" />
              <span className="truncate">{label}</span>
            </span>
          )}
          <span className="ml-1 h-4 w-px shrink-0 bg-border" />
        </div>
      )}
      <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
        {task?.tabs.map((tab, index) => <TabButton key={tab.id} task={task} tab={tab} index={index} count={task.tabs.length} sessions={sessions} />)}
      </div>
      <button
        title="New tab: Shell (⌘T) or an agent"
        aria-label="New tab"
        onClick={(event) => openMenu(event, getAgents().map((agent) => ({ label: agent.label, accelerator: agent.id === 'shell' ? 'CmdOrCtrl+T' : undefined, run: () => newTab(agent.id) })))}
        className={stripButton}
      >
        <Icon name="plus" className="size-3.5" />
      </button>
      <span className="min-w-2 flex-1" />
      {plans && lone && (lone.kind === 'claude' || lone.planName) && <plans.PlanButton startedAt={lone.startedAt} name={lone.planName} />}
      <button title="Split right (⌘D)" aria-label="Split right" onClick={() => void splitPane('right', cwd)} className={stripButton}>
        <Icon name="splitRight" className="size-3.5" />
      </button>
      <button title="Split down (⌘⇧D)" aria-label="Split down" onClick={() => void splitPane('bottom', cwd)} className={stripButton}>
        <Icon name="splitDown" className="size-3.5" />
      </button>
      {page && (
        <button title={`${panels.inspector ? 'Hide' : 'Show'} inspector (⌘⌥B)`} aria-label="Toggle inspector" onClick={() => panels.toggle('inspector')} className={`${stripButton} ${panels.inspector ? 'text-foreground' : ''}`}>
          <Icon name="panel" className="size-3.5 -scale-x-100" />
        </button>
      )}
      {onHide && (
        <button title={`Hide the terminal panel${actionKeys('panel.terminal') ? ` (${actionKeys('panel.terminal')})` : ''}`} aria-label="Hide terminal panel" onClick={onHide} className={stripButton}>
          <Icon name="close" className="size-3.5" />
        </button>
      )}
    </div>
  )
}

/** A task with no terminals: start one, or bring back a closed one */
function EmptyTask({ task, label, cwd, history, repos }: { task: Task | null; label: string; cwd: string; history: ClosedSession[]; repos: Repo[] | null }): React.JSX.Element {
  const agents = useAgents()
  return (
    <div data-terminal-empty className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-y-auto bg-background p-4 text-center">
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-foreground/5 text-muted-foreground">
        <Icon name="terminal" className="size-5" />
      </span>
      <p className="max-w-full truncate text-[13px] text-muted-foreground">
        No terminals in <span className="text-foreground">{label}</span>
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        {agents.map(({ id: kind, label: kindLabel }, index) => (
          <button
            key={kind}
            data-zone-focus={index === 0 ? '' : undefined}
            onClick={() => openTab(task?.worktreePath ?? cwd, kind, task?.id)}
            className="flex h-8 items-center gap-2 rounded-md bg-foreground/5 px-3 text-xs text-foreground hover:bg-accent"
          >
            <KindBadge kind={kind} />
            {kindLabel}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground">
        <kbd className="kbd">⌘T</kbd> new shell tab
      </p>
      {history.length > 0 && (
        <div className="w-full max-w-md text-left">
          <p className="px-1.5 pb-1 text-[10.5px] font-medium tracking-wide text-muted-foreground uppercase">Recently closed</p>
          <ClosedSessions entries={history.slice(0, 8)} repos={repos} />
        </div>
      )}
    </div>
  )
}

/** The shown tab of a task, its panes split in columns; docked at the side the panes stack */
export function TaskTerminals({
  task,
  label,
  cwd,
  history,
  repos,
  orientation,
  page,
  onHide
}: {
  task: Task | null
  /** The task's name for headers */
  label: string
  /** Where terminals start when there is no task yet */
  cwd: string
  /** Closed sessions of the task */
  history: ClosedSession[]
  repos: Repo[] | null
  orientation: 'horizontal' | 'vertical'
  /** On the Terminal page rather than docked */
  page: boolean
  /** Closes the panel, when docked */
  onHide?: () => void
}): React.JSX.Element {
  const { sessions: allSessions, zoomed } = useTerminals()
  const [weights, setWeights] = useState<Record<string, number>>({})
  useSettings()
  const tab = task ? activeTabOf(task) : undefined
  const panes = tab ? tabPanes(tab) : []
  const sessions = allSessions.filter((session) => task?.tabs.some((candidate) => tabPanes(candidate).includes(session.id)))
  const sessionById = (id: string): Session | undefined => sessions.find((session) => session.id === id)
  const layout = zoomed && panes.includes(zoomed) ? [[zoomed]] : (tab?.layout ?? [])
  const shownColumns = layout.map((column) => column.map(sessionById).filter((session) => session !== undefined)).filter((column) => column.length > 0)
  const horizontal = orientation === 'horizontal'
  // Docked at the side there is no room for columns, so panes stack
  const columns = horizontal ? shownColumns : [shownColumns.flat()].filter((column) => column.length > 0)
  const framed = columns.flat().length > 1
  let number = 0

  return (
    <div data-terminal-panes className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <TabStrip task={task} label={label} cwd={cwd} sessions={sessions} page={page} onHide={onHide} />
      {columns.length === 0 ? (
        <EmptyTask task={task} label={label} cwd={cwd} history={history} repos={repos} />
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1">
          {columns.map((column, columnIndex) => (
            <Fragment key={column[0].id}>
              {columnIndex > 0 && <SplitDivider axis="x" before={columns[columnIndex - 1][0].id} after={column[0].id} weights={weights} onResize={setWeights} />}
              <div style={{ flexGrow: weights[column[0].id] ?? 1 }} className="flex min-h-0 min-w-0 basis-0 flex-col">
                {column.map((session, rowIndex) => (
                  <Fragment key={session.id}>
                    {rowIndex > 0 && <SplitDivider axis="y" before={`row:${column[rowIndex - 1].id}`} after={`row:${session.id}`} weights={weights} onResize={setWeights} />}
                    <div style={{ flexGrow: weights[`row:${session.id}`] ?? 1 }} className="flex min-h-0 min-w-0 basis-0">
                      <TerminalPane session={session} task={task} number={++number} active={session.id === tab?.focus} framed={framed} repos={repos} horizontal={horizontal} />
                    </div>
                  </Fragment>
                ))}
              </div>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  )
}
