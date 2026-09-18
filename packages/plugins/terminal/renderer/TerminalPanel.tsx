import { Fragment, useEffect, useRef, useState } from 'react'
import type { Repo } from '@treeix/shared/types'
import { useService } from '@treeix/app/plugins'
import { Icon } from '@treeix/app/Icon'
import { copyText, openMenu } from '@treeix/app/contextMenu'
import { type DropEdge, edgeAt } from './paneLayout'
import { KindBadge, StatusDot, worktreeLabel } from '@treeix/app/sessionUi'
import { groupOpen, toggleIn, useSettings } from '@treeix/app/settings'
import { EmptyState, ResizeHandle, usePersisted } from '@treeix/app/ui'
import { baseName } from '@treeix/app/Sidebar'
import { timeAgo } from '@treeix/app/time'
import {
  attachSession,
  clearClosedSessions,
  clearTerminal,
  type ClosedSession,
  createSession,
  fitSession,
  focusSession,
  forgetClosedSession,
  hidePane,
  killSession,
  pasteClipboard,
  setSessionListOpen,
  placePane,
  restoreClosedSession,
  selectAllTerminal,
  terminalSelection,
  SESSION_KINDS,
  type Session,
  type SessionKind,
  showPane,
  useTerminals
} from './terminals'

function NewSessionMenu({ cwd, label }: { cwd: string; label: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <button
        title={`New session in ${cwd === window.api.home ? 'your home folder' : baseName(cwd)}`}
        onClick={() => setOpen(!open)}
        className="flex h-6 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground ring-1 ring-border hover:text-foreground"
      >
        {label}
      </button>
      {open && (
        <div
          onMouseLeave={() => setOpen(false)}
          className={`absolute top-7 right-0 z-40 w-44 rounded-lg border border-input bg-popover p-1`}
        >
          {(Object.keys(SESSION_KINDS) as SessionKind[]).map((kind) => (
            <button
              key={kind}
              onClick={() => {
                setOpen(false)
                createSession(cwd, kind)
              }}
              className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-xs hover:bg-accent"
            >
              <KindBadge kind={kind} />
              {SESSION_KINDS[kind].label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

const SESSION_MIME = 'application/x-treeix-session'

/** Closed sessions of this workspace; restoring starts one again, resuming an agent conversation */
function SessionHistory({ entries, repos }: { entries: ClosedSession[]; repos: Repo[] | null }): React.JSX.Element | null {
  const [open, setOpen] = usePersisted<boolean>('terminal.historyOpen', true)
  if (entries.length === 0) return null
  return (
    <div className="mt-1 border-t border-border pt-1.5">
      <div className="flex h-6 items-center gap-1 px-1.5 text-[11px] text-muted-foreground">
        <button onClick={() => setOpen(!open)} className="flex min-w-0 flex-1 items-center gap-1 text-left hover:text-foreground">
          <Icon name="chevron" className={`size-3 transition-transform ${open ? 'rotate-90' : ''}`} />
          <Icon name="history" className="size-3" />
          History <span className="tabular-nums">{entries.length}</span>
        </button>
        {open && (
          <button onClick={() => clearClosedSessions(entries.map((entry) => entry.id))} className="rounded px-1 hover:bg-accent hover:text-foreground">
            Clear
          </button>
        )}
      </div>
      {open && (
        <div className="mt-0.5 flex flex-col gap-0.5">
          {entries.map((entry) => (
            <div
              key={entry.id}
              role="button"
              tabIndex={0}
              title={`Restore${entry.kind === 'shell' ? '' : ' and resume the conversation'} in ${entry.worktreePath}`}
              onClick={() => void restoreClosedSession(entry).then((id) => setTimeout(() => focusSession(id)))}
              className="group/closed flex h-8 w-full items-center gap-2 rounded-md pr-1 pl-4 text-left text-foreground/60 hover:bg-accent hover:text-foreground"
            >
              <KindBadge kind={entry.kind} />
              <span className="flex min-w-0 flex-1 flex-col leading-tight">
                <span className="truncate text-xs">{entry.title}</span>
                <span className="truncate text-[10px] text-muted-foreground">
                  {worktreeLabel(repos, entry.worktreePath)} · {timeAgo(new Date(entry.endedAt).toISOString())}
                </span>
              </span>
              <Icon name="refresh" className="size-3 shrink-0 opacity-0 group-hover/closed:opacity-100" />
              <button
                title="Remove from history"
                aria-label="Remove from history"
                onClick={(event) => {
                  event.stopPropagation()
                  forgetClosedSession(entry.id)
                }}
                className="grid size-5 shrink-0 place-items-center rounded opacity-0 group-hover/closed:opacity-100 hover:bg-background hover:text-red-400"
              >
                <Icon name="trash" className="size-3" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Actions shared by the session list and pane headers */
function sessionMenu(event: React.MouseEvent, session: Session, shown: boolean): void {
  openMenu(event, [
    shown
      ? { label: 'Hide pane', run: () => hidePane(session.id) }
      : { label: 'Show pane', run: () => showPane(session.id) },
    { label: 'Focus', run: () => (showPane(session.id), setTimeout(() => focusSession(session.id))) },
    null,
    { label: `New ${SESSION_KINDS[session.kind].label} session here`, run: () => void createSession(session.worktreePath, session.kind) },
    null,
    { label: 'Copy working directory', run: () => copyText(session.worktreePath) },
    { label: 'Reveal in Finder', run: () => window.api.revealInFinder(session.worktreePath) },
    null,
    { label: 'Close session', run: () => killSession(session.id) }
  ])
}

const draggingSession = (event: React.DragEvent): boolean => event.dataTransfer.types.includes(SESSION_MIME)

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
        className={`absolute z-10 transition-colors hover:bg-primary/60 active:bg-primary ${
          axis === 'x' ? 'inset-y-0 -left-[2px] w-[5px] cursor-col-resize' : 'inset-x-0 -top-[2px] h-[5px] cursor-row-resize'
        }`}
      />
    </div>
  )
}

function TerminalPane({ session, repos, horizontal }: { session: Session; repos: Repo[] | null; horizontal: boolean }): React.JSX.Element {
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
        placePane(event.dataTransfer.getData(SESSION_MIME), session.id, edgeOf(event))
      }}
      className="group/pane relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background"
    >
      {dropEdge && (
        // Shades the half the dropped terminal will take
        <span
          className={`pointer-events-none absolute z-20 border-2 border-primary/70 bg-primary/15 ${
            { left: 'inset-y-0 left-0 w-1/2', right: 'inset-y-0 right-0 w-1/2', top: 'inset-x-0 top-0 h-1/2', bottom: 'inset-x-0 bottom-0 h-1/2' }[dropEdge]
          }`}
        />
      )}
      <div
        draggable
        onDragStart={(event) => event.dataTransfer.setData(SESSION_MIME, session.id)}
        onContextMenu={(event) => sessionMenu(event, session, true)}
        className="flex h-7 shrink-0 cursor-grab items-center gap-2 border-b border-border bg-card px-2 group-focus-within/pane:text-foreground active:cursor-grabbing"
      >
        <Icon name="grip" className="-mx-1 size-3 text-muted-foreground/50" />
        <KindBadge kind={session.kind} />
        <span className="truncate text-xs">{session.title}</span>
        <span className="truncate text-[11px] text-muted-foreground">{worktreeLabel(repos, session.worktreePath)}</span>
        <span className="flex-1" />
        {plans && (session.kind === 'claude' || session.planName) && <plans.PlanButton startedAt={session.startedAt} name={session.planName} />}
        <StatusDot session={session} />
        <button
          title="Close session (⌘W); restore it from History"
          aria-label="Close session"
          onClick={() => killSession(session.id)}
          className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-red-400"
        >
          <Icon name="close" className="size-3" />
        </button>
      </div>
      <div
        ref={hostRef}
        className="min-h-0 flex-1"
        onContextMenu={(event) =>
          openMenu(event, [
            { label: 'Copy', enabled: terminalSelection(session.id) !== '', accelerator: 'CmdOrCtrl+C', run: () => copyText(terminalSelection(session.id)) },
            { label: 'Paste', accelerator: 'CmdOrCtrl+V', run: () => void pasteClipboard(session.id) },
            { label: 'Select all', run: () => selectAllTerminal(session.id) },
            null,
            { label: 'Clear scrollback', run: () => clearTerminal(session.id) }
          ])
        }
      />
    </div>
  )
}

export function TerminalPanel({
  repos,
  worktreePath,
  orientation,
  includeSession
}: {
  repos: Repo[] | null
  worktreePath: string | null
  orientation: 'horizontal' | 'vertical'
  /** Limits the list and panes, e.g. to the current workspace */
  includeSession?: (session: { worktreePath: string; workspaceId: string }) => boolean
}): React.JSX.Element {
  const { sessions: allSessions, panes, layout: fullLayout, listOpen, zoomed, history: allHistory } = useTerminals()
  const sessions = includeSession ? allSessions.filter(includeSession) : allSessions
  const history = includeSession ? allHistory.filter(includeSession) : allHistory
  // A pane zoomed in another workspace doesn't blank this one
  const layout = zoomed && sessions.some((session) => session.id === zoomed) ? [[zoomed]] : fullLayout
  const waiting = sessions.filter((session) => session.status === 'input').length
  const groups = [...new Set(sessions.map((session) => session.worktreePath))]
  const horizontal = orientation === 'horizontal'
  const sessionById = (id: string): Session | undefined => sessions.find((session) => session.id === id)
  const shownColumns = layout.map((column) => column.map(sessionById).filter((session) => session !== undefined)).filter((column) => column.length > 0)
  // Docked at the side there is no room for columns, so panes stack
  const columns = horizontal ? shownColumns : [shownColumns.flat()].filter((column) => column.length > 0)
  const [listWidth, setListWidth] = usePersisted<number>('terminal.sessionsWidth', 256)
  const [toggledGroups, setToggledGroups] = useState<Set<string>>(new Set())
  const [weights, setWeights] = useState<Record<string, number>>({})
  useSettings()
  // No worktree selected: sessions start in the home folder
  const cwd = worktreePath ?? window.api.home

  const sessionButton = (session: Session): React.JSX.Element => (
    <button
      key={session.id}
      draggable
      title="Click to show, drag onto the terminals to place"
      onDragStart={(event) => event.dataTransfer.setData(SESSION_MIME, session.id)}
      onContextMenu={(event) => sessionMenu(event, session, panes.includes(session.id))}
      onClick={() => {
        showPane(session.id)
        setTimeout(() => focusSession(session.id))
      }}
      className={`flex h-8 w-full items-center gap-2 rounded-md pr-2 pl-4 text-left ${
        panes.includes(session.id) ? 'bg-accent text-foreground' : 'text-foreground/75 hover:bg-accent'
      }`}
    >
      <KindBadge kind={session.kind} />
      <span className="truncate text-xs">{session.title}</span>
      <span className="flex-1" />
      <StatusDot session={session} withLabel={horizontal} />
    </button>
  )

  const toggleGroup = (group: string): void => setToggledGroups(toggleIn(toggledGroups, group))

  const sessionList = (
    <div
      style={horizontal ? { width: listWidth } : undefined}
      className={horizontal ? 'relative flex shrink-0 flex-col border-r border-border' : 'flex max-h-48 shrink-0 flex-col border-b border-border'}
    >
      <div className="flex h-9 shrink-0 items-center gap-2 pr-2 pl-3">
        <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Sessions</span>
        {waiting > 0 && (
          <span className="rounded-full bg-amber-400/15 px-1.5 text-[11px] text-amber-400">{waiting} waiting</span>
        )}
        <span className="flex-1" />
        <NewSessionMenu cwd={cwd} label="+ New" />
        <button
          title="Hide sessions"
          aria-label="Hide sessions"
          onClick={() => setSessionListOpen(false)}
          className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Icon name="panel" className="size-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {groups.map((group) => {
          const open = groupOpen(toggledGroups, group)
          const groupSessions = sessions.filter((session) => session.worktreePath === group)
          return (
            <div key={group} className="mb-2">
              <button
                onClick={() => toggleGroup(group)}
                title={group}
                className="flex h-6 w-full items-center gap-1 rounded-md px-1.5 text-left text-[11px] text-muted-foreground hover:text-foreground"
              >
                <Icon name="chevron" className={`size-3 transition-transform ${open ? 'rotate-90' : ''}`} />
                <span className="truncate">{worktreeLabel(repos, group)}</span>
                <span className="flex-1" />
                {!open && groupSessions.some((session) => session.status === 'input') && (
                  <span className="size-1.5 rounded-full bg-amber-400" />
                )}
                {!open && <span className="tabular-nums">{groupSessions.length}</span>}
              </button>
              {open && <div className="mt-0.5 flex flex-col gap-1">{groupSessions.map(sessionButton)}</div>}
            </div>
          )
        })}
        <SessionHistory entries={history} repos={repos} />
      </div>
      {horizontal && <ResizeHandle width={listWidth} min={180} max={480} onResize={setListWidth} />}
    </div>
  )

  if (sessions.length === 0) {
    return (
      <div className="flex h-full">
        <EmptyState fill icon="terminal" title={`Start a session in ${worktreeLabel(repos, cwd)}`}>
          {(Object.keys(SESSION_KINDS) as SessionKind[]).map((kind) => (
            <button
              key={kind}
              onClick={() => createSession(cwd, kind)}
              className="flex h-8 items-center gap-2 rounded-md px-3 text-xs text-foreground ring-1 ring-border hover:bg-accent"
            >
              <KindBadge kind={kind} />
              {SESSION_KINDS[kind].label}
            </button>
          ))}
          {history.length > 0 && (
            <div className="w-72 basis-full text-left">
              <SessionHistory entries={history} repos={repos} />
            </div>
          )}
        </EmptyState>
      </div>
    )
  }

  return (
    <div className={`flex h-full min-h-0 ${horizontal ? '' : 'flex-col'}`}>
      {listOpen && sessionList}
      <div className="flex min-h-0 min-w-0 flex-1">
        {columns.map((column, columnIndex) => (
          <Fragment key={column[0].id}>
            {columnIndex > 0 && <SplitDivider axis="x" before={columns[columnIndex - 1][0].id} after={column[0].id} weights={weights} onResize={setWeights} />}
            <div style={{ flexGrow: weights[column[0].id] ?? 1 }} className="flex min-h-0 min-w-0 basis-0 flex-col">
              {column.map((session, rowIndex) => (
                <Fragment key={session.id}>
                  {rowIndex > 0 && <SplitDivider axis="y" before={`row:${column[rowIndex - 1].id}`} after={`row:${session.id}`} weights={weights} onResize={setWeights} />}
                  <div style={{ flexGrow: weights[`row:${session.id}`] ?? 1 }} className="flex min-h-0 min-w-0 basis-0">
                    <TerminalPane session={session} repos={repos} horizontal={horizontal} />
                  </div>
                </Fragment>
              ))}
            </div>
          </Fragment>
        ))}
        {columns.length === 0 && (
          <p
            onDragOver={(event) => draggingSession(event) && event.preventDefault()}
            onDrop={(event) => draggingSession(event) && showPane(event.dataTransfer.getData(SESSION_MIME))}
            className="flex flex-1 items-center justify-center bg-card px-6 text-center text-[13px] text-muted-foreground"
          >
            Pick or drag a session to show it here
          </p>
        )}
      </div>
    </div>
  )
}
