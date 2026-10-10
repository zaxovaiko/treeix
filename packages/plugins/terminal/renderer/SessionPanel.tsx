import { useEffect, useRef, useState } from 'react'
import type { Repo } from '@treeix/shared/types'
import { useService } from '@treeix/app/plugins'
import { actionKeys, shortcutOf } from '@treeix/shared/keymap'
import { toAccelerator } from '@treeix/shared/shortcut'
import { Icon } from '@treeix/app/Icon'
import { copyText, type MenuEntry, openMenu } from '@treeix/app/contextMenu'
import { KindBadge, StatusDot, worktreeLabel } from '@treeix/app/sessionUi'
import { baseName, branchLabel } from '@treeix/app/Sidebar'
import { agentOr, chatAgent, useAgents } from '@treeix/app/agents'
import { useSettings } from '@treeix/app/settings'
import { timeAgo } from '@treeix/app/time'
import { PANE_HEADER, useHost, usePanels } from '@treeix/sdk'
import { errorMessage, ResizeGrip, useChromeless } from '@treeix/app/ui'
import { Picker, type PickerOption } from '@treeix/app/Picker'
import { LazyMarkdown as Markdown } from '@treeix/app/LazyMarkdown'
import { droppedPaths } from './fileLinks'
import { pickedFolder, recentFolders, setFolderPickerOpen, setPickedFolder, useFolderPickerOpen } from './folder'
import { NameInput, renaming, startRename } from './rename'
import { NEW_TAB_ACTIONS, newTabEntries, type NewTabEntry } from './sessionMeta'
import {
  attachSession,
  releaseGpu,
  clearTerminal,
  type ClosedSession,
  createSession,
  focusSession,
  focusShown,
  forgetClosedSession,
  killSession,
  otherView,
  pasteClipboard,
  renameSession,
  sendText,
  restoreClosedSession,
  selectAllTerminal,
  sessionDiagrams,
  splitSession,
  switchView,
  terminalSelection,
  transcriptRef,
  type Session,
  type SessionKind,
  type SessionView as SessionViewKind,
  setPaneGrow,
  useTerminals,
  wakeSession
} from './terminals'

type DockSide = 'left' | 'right' | 'bottom'
const DOCK_SIDES: DockSide[] = ['bottom', 'left', 'right']

const draggingFiles = (event: React.DragEvent): boolean => event.dataTransfer.types.includes('Files')

const LONG_PRESS_MS = 400

/** The menu shows an action's key as rebound in Settings */
const acceleratorOf = (action: string | undefined): string | undefined => {
  const shortcut = action ? shortcutOf(action) : null
  return (shortcut && toAccelerator(shortcut)) ?? undefined
}

/** Starts a session in the folder, puts it on screen and focuses it */
export const openSession = (cwd: string, kind: SessionKind, view: SessionViewKind = 'terminal'): void =>
  void createSession(cwd, kind, undefined, view).then((id) => setTimeout(() => focusSession(id)))

/** Each agent in a terminal, then a chat while the chat plugin is on */
export function useNewSessionEntries(): NewTabEntry[] {
  const chat = useService('chat')
  // The chat starts with the agent last picked in one
  useSettings()
  return newTabEntries(useAgents(), chat ? chatAgent() : undefined)
}

/** Beside the agent's badge, a session open as a chat */
export const ChatMark = (): React.JSX.Element => (
  <span title="Chat" className="shrink-0 text-muted-foreground">
    <Icon name="comment" className="size-3" />
  </span>
)

/** Opens the mermaid diagrams the session's agent wrote as a tab, newest first; the diagrams plugin draws them */
function DiagramsButton({ session }: { session: Session }): React.JSX.Element | null {
  const host = useHost()
  const ref = transcriptRef(session)
  if (!ref || !host.isEnabled('diagrams')) return null
  const open = async (): Promise<void> => {
    const diagrams = await sessionDiagrams(ref)
    if (diagrams.length === 0) return host.flash('No mermaid diagrams in this session yet')
    host.openTab({
      key: `diagrams:${session.id}`,
      title: `Diagrams: ${session.title}`,
      icon: <Icon name="layers" className="size-3.5 text-muted-foreground" />,
      parent: 'terminal',
      panels: ['terminal'],
      content: (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[860px] px-5 py-4">
            <Markdown>{diagrams.map((code) => `\`\`\`mermaid\n${code}\n\`\`\``).join('\n\n')}</Markdown>
          </div>
        </div>
      )
    })
  }
  return (
    <button
      title="Render the mermaid diagrams of this session"
      aria-label="Diagrams"
      onClick={() => void open()}
      className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      <Icon name="layers" className="size-3" />
    </button>
  )
}

const restore = (entry: ClosedSession): void => void restoreClosedSession(entry).then((id) => setTimeout(() => focusSession(id)))

/** Closed sessions, newest first; a row starts the session again, resuming an agent conversation */
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
            {entry.view === 'chat' && <ChatMark />}
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

/** Actions of a session, in the toolbar, the sidebar and the terminal menu */
export const sessionEntries = (session: Session, flash: (message: string) => void): MenuEntry[] => [
  {
    label: session.view === 'chat' ? 'New chat here' : `New ${agentOr(session.kind).label} session here`,
    run: () => openSession(session.worktreePath, session.kind, session.view)
  },
  otherView(session) === 'chat' && { label: 'Open as chat', run: () => void switchView(session.id).catch((reason: unknown) => flash(errorMessage(reason))) },
  otherView(session) === 'terminal' && { label: 'Open in terminal', run: () => void switchView(session.id).catch((reason: unknown) => flash(errorMessage(reason))) },
  { label: 'Rename…', run: () => startRename(session.id) },
  null,
  { label: 'Split right', accelerator: acceleratorOf('terminal.splitRight'), run: () => void splitSession(session.id, 'right', flash) },
  { label: 'Split down', accelerator: acceleratorOf('terminal.splitDown'), run: () => void splitSession(session.id, 'bottom', flash) },
  null,
  { label: 'Copy working directory', run: () => copyText(session.worktreePath) },
  { label: 'Reveal in Finder', run: () => window.api.revealInFinder(session.worktreePath) },
  null,
  { label: 'Close session', accelerator: 'CmdOrCtrl+W', run: () => killSession(session.id) }
]

const SessionNameInput = ({ session }: { session: Session }): React.JSX.Element => (
  <NameInput value={session.title} label="Session name" onSave={(name) => renameSession(session.id, name)} onDone={focusShown} />
)

/** The session on screen: its terminal, or the chat plugin's view */
function SessionView({ session }: { session: Session }): React.JSX.Element {
  const host = useHost()
  const hostRef = useRef<HTMLDivElement>(null)
  const chat = useService('chat')

  useEffect(() => {
    const element = hostRef.current
    if (!element || session.view !== 'terminal') return
    attachSession(session.id, element)
    // The Terminal page and a panel docked on another page show the same session, so whichever comes on screen takes it back
    const observer = new ResizeObserver(() => (element.offsetWidth > 0 ? attachSession(session.id, element) : releaseGpu(session.id, element)))
    observer.observe(element)
    return () => {
      observer.disconnect()
      releaseGpu(session.id, element)
    }
  }, [session.id])
  // A dormant chat connects once shown, and once the chat plugin has loaded
  useEffect(() => {
    if (session.view === 'chat' && chat) void wakeSession(session.id)
  }, [session.id, chat])

  return (
    <div
      data-session-id={session.id}
      // The shell focuses the session through this; the terminal inside takes the keys
      data-zone-focus=""
      tabIndex={-1}
      onFocus={(event) => event.target === event.currentTarget && focusSession(session.id)}
      // A chat takes clicks itself: its feed has text to select and buttons
      onMouseDown={() => session.view === 'terminal' && focusSession(session.id)}
      // A chat's composer takes files itself
      onDragOver={(event) => session.view === 'terminal' && draggingFiles(event) && event.preventDefault()}
      onDrop={(event) => {
        // Files dropped from Finder are typed as their paths, which agents like Claude Code read as attachments
        if (session.view !== 'terminal' || !draggingFiles(event)) return
        event.preventDefault()
        const paths = [...event.dataTransfer.files].map((file) => window.api.pathForFile(file)).filter(Boolean)
        if (paths.length) sendText(session.id, droppedPaths(paths), false)
      }}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background"
    >
      {session.view === 'chat' ? (
        <div className="flex min-h-0 flex-1 flex-col">
          {chat ? <chat.View chatId={session.id} /> : <p className="m-auto p-4 text-xs text-muted-foreground">Turn on the Chat plugin in Settings to open this chat</p>}
        </div>
      ) : (
        <div
          ref={hostRef}
          // Text keeps off the pane's edge, as an editor's does
          className="min-h-0 flex-1 pt-1 pl-2"
          onContextMenu={(event) =>
            openMenu(event, [
              { label: 'Copy', enabled: terminalSelection(session.id) !== '', accelerator: 'CmdOrCtrl+C', run: () => copyText(terminalSelection(session.id)) },
              { label: 'Paste', accelerator: 'CmdOrCtrl+V', run: () => void pasteClipboard(session.id) },
              { label: 'Select all', run: () => selectAllTerminal(session.id) },
              null,
              { label: 'Clear scrollback', run: () => clearTerminal(session.id) },
              null,
              ...sessionEntries(session, host.flash)
            ])
          }
        />
      )}
    </div>
  )
}

const stripButton = 'grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground'

const CHOOSE = 'choose:'
const DEFAULT = 'default:'

/** Where new sessions start: the workspace's checkouts, recent picks, home, or any folder (⌘O) */
function FolderPicker({ label, current, onGo }: { label: string; current: string; onGo: (path: string) => void }): React.JSX.Element {
  const host = useHost()
  const open = useFolderPickerOpen()
  const [query, setQuery] = useState('')
  const inScope = (host.repos ?? []).filter((repo) => !host.scopeRepoPaths || host.scopeRepoPaths.includes(repo.path))
  const home = window.api.home
  const option =
    (section: string, label?: string) =>
    (path: string): PickerOption => {
      const name = label ?? worktreeLabel(host.repos, path)
      return { id: path, label: `${section} ${name} ${path}`, section, render: <FolderRow name={name} path={path} /> }
    }
  // Recent picks first, the likeliest next; everything below leaves them out so no folder shows twice
  const recent = recentFolders()
  const unseen = (path: string): boolean => !recent.includes(path)
  // A project with one checkout is one row under Projects; one with worktrees gets a section, its main checkout first
  const single = inScope.filter((repo) => repo.worktrees.length <= 1 && unseen(repo.worktrees[0]?.path ?? repo.path))
  const withWorktrees = inScope.filter((repo) => repo.worktrees.length > 1)
  const projectOptions = [
    ...single.map((repo) => option('Projects', baseName(repo.path))(repo.worktrees[0]?.path ?? repo.path)),
    ...withWorktrees.flatMap((repo) =>
      [...repo.worktrees]
        .sort((a, b) => Number(b.path === repo.path) - Number(a.path === repo.path))
        .filter((worktree) => unseen(worktree.path))
        .map((worktree) => option(baseName(repo.path), branchLabel(worktree))(worktree.path))
    )
  ]
  const action = (id: string, text: string, match = text): PickerOption => ({
    id,
    label: `${text} ${match}`,
    section: '',
    render: <span className="truncate text-muted-foreground">{text}</span>
  })
  // A typed absolute or ~ path is an option of its own, so folders outside the lists are reachable
  const typedPath = query.startsWith('~/') ? `${home}${query.slice(1)}` : query.startsWith('/') ? query : null
  const picked = pickedFolder(host.workspaceId)
  const options = [
    ...recent.map((path) => option('Recent')(path)),
    ...projectOptions,
    ...(unseen(home) ? [option('Home')(home)] : []),
    ...(typedPath ? [action(typedPath, `Go to ${typedPath}`, query)] : []),
    action(CHOOSE, 'Choose folder…'),
    ...(picked ? [action(DEFAULT, `Back to the default, ${worktreeLabel(host.repos, host.defaultCwd)}`)] : [])
  ]
  const pick = (id: string): void => {
    if (id === DEFAULT) return setPickedFolder(host.workspaceId, null)
    if (id !== CHOOSE) return onGo(id)
    void window.api.pickFolder().then((path) => {
      if (path) onGo(path)
    })
  }
  return (
    <Picker
      title={`${label}: go to a folder (${actionKeys('terminal.goToFolder')}); new sessions start there`}
      trigger={
        <span className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground">
          <Icon name="folder" className="size-3.5" />
        </span>
      }
      options={options}
      current={current}
      placeholder="Go to folder"
      open={open}
      onOpenChange={setFolderPickerOpen}
      onQuery={setQuery}
      onPick={pick}
      width="w-96"
    />
  )
}

function FolderRow({ name, path }: { name: string; path: string }): React.JSX.Element {
  return (
    <span title={path} className="flex min-w-0 items-baseline gap-2">
      <span className="max-w-[70%] shrink-0 truncate text-foreground">{name}</span>
      {/* Right to left so a long path keeps its end, the part that tells checkouts apart */}
      <span dir="rtl" className="min-w-0 shrink-[3] truncate text-left text-[11px] text-muted-foreground">
        <bdi>{path.replace(window.api.home, '~')}</bdi>
      </span>
    </span>
  )
}

/** The session on screen with a new session button; on the Terminal page also the list and inspector toggles */
function SessionBar({
  session,
  label,
  cwd,
  repos,
  page,
  onHide,
  side,
  onMove,
  onGoToFolder
}: {
  session: Session | null
  label: string
  cwd: string
  repos: Repo[] | null
  page: boolean
  onHide?: () => void
  side?: DockSide
  onMove?: (side: DockSide) => void
  onGoToFolder?: (path: string) => void
}): React.JSX.Element {
  const host = useHost()
  const panels = usePanels()
  const { id: renamingId } = renaming.use()
  // In zen the page's strip moves up beside the traffic lights and drags the window, in place of the title bar
  const chromeless = useChromeless()
  const topBar = page && panels.zen && !chromeless
  const newSession = (kind: SessionKind, view: SessionViewKind): void => openSession(session?.worktreePath ?? cwd, kind, view)
  const entries = useNewSessionEntries()
  const menuEntry = (entry: NewTabEntry): MenuEntry => ({
    label: entry.label,
    accelerator: acceleratorOf(entry.view === 'chat' ? 'terminal.newChat' : NEW_TAB_ACTIONS[entry.agent]),
    run: () => newSession(entry.agent, entry.view)
  })
  const shell = entries.find((entry) => entry.agent === 'shell' && entry.view === 'terminal')
  const terminals = entries.filter((entry) => entry.view === 'terminal')
  const chats = entries.filter((entry) => entry.view === 'chat')
  const showMenu = (event: React.MouseEvent): void => openMenu(event, [...terminals.map(menuEntry), null, ...chats.map(menuEntry)])
  // A click opens a shell; holding opens the menu instead, and the click that ends the hold does nothing
  const pressTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const held = useRef(false)
  const endPress = (): void => clearTimeout(pressTimer.current)
  const plans = useService('plans')
  const planName = session?.view === 'terminal' ? session.planName : null
  return (
    <div className={`@container ${PANE_HEADER} gap-1 px-1.5 ${topBar ? 'pl-[80px] [-webkit-app-region:drag] [&_button]:[-webkit-app-region:no-drag]' : ''}`}>
      {page && (
        <div className="flex min-w-0 shrink-0 items-center gap-1 pr-1">
          {onGoToFolder && <FolderPicker label={label} current={session?.worktreePath ?? cwd} onGo={onGoToFolder} />}
          <span className="ml-1 h-4 w-px shrink-0 bg-border" />
        </div>
      )}
      {session && (
        <div
          onContextMenu={(event) => openMenu(event, sessionEntries(session, host.flash))}
          className="flex min-w-0 items-center gap-2 overflow-hidden [-webkit-app-region:no-drag]"
        >
          <KindBadge kind={session.kind} />
          {session.view === 'chat' && <ChatMark />}
          {renamingId === session.id ? (
            <SessionNameInput session={session} />
          ) : (
            <span onDoubleClick={() => startRename(session.id)} className="min-w-0 truncate text-xs font-medium text-foreground">
              {session.title}
            </span>
          )}
          <span className="min-w-0 truncate text-[11px] text-muted-foreground">{worktreeLabel(repos, session.worktreePath)}</span>
          <StatusDot session={session} />
        </div>
      )}
      <span className="min-w-2 flex-1" />
      {session && <DiagramsButton session={session} />}
      {plans && session?.view === 'terminal' && (session.kind === 'claude' || planName) && <plans.PlanButton startedAt={session.startedAt} name={planName} />}
      <button
        title={`New shell (${actionKeys('terminal.newTab')}); hold or right-click for Claude (${actionKeys('terminal.newClaudeTab')}) and other agents`}
        aria-label="New session"
        onPointerDown={(event) => {
          held.current = false
          pressTimer.current = setTimeout(() => {
            held.current = true
            showMenu(event)
          }, LONG_PRESS_MS)
        }}
        onPointerUp={endPress}
        onPointerLeave={endPress}
        onClick={() => !held.current && shell && newSession(shell.agent, shell.view)}
        onContextMenu={showMenu}
        className={stripButton}
      >
        <Icon name="plus" className="size-3.5" />
      </button>
      {session && (
        <button
          title="Close to History (⌘W)"
          aria-label="Close session"
          onClick={() => {
            killSession(session.id)
            focusShown()
          }}
          className={stripButton}
        >
          <Icon name="close" className="size-3" />
        </button>
      )}
      {page && !panels.inIsland('inspector') && (
        <button
          title={`${panels.inspector ? 'Hide' : 'Show'} inspector${actionKeys('panel.inspector') ? ` (${actionKeys('panel.inspector')})` : ''}`}
          aria-label="Toggle inspector"
          onClick={() => panels.toggle('inspector')}
          className={`${stripButton} ${panels.inspector ? 'text-foreground' : ''}`}
        >
          <Icon name="panel" className="size-3.5 -scale-x-100" />
        </button>
      )}
      {side && onMove && (
        <button
          title={`Docked ${side}; click to move`}
          aria-label="Move terminal panel"
          onClick={(event) =>
            openMenu(
              event,
              DOCK_SIDES.filter((target) => target !== side).map((target) => ({ label: `Dock ${target}`, run: () => onMove(target) }))
            )
          }
          className={stripButton}
        >
          <Icon name="panel" className={`size-3.5 ${side === 'bottom' ? 'rotate-90 -scale-x-100' : side === 'right' ? '-scale-x-100' : ''}`} />
        </button>
      )}
      {onHide && (
        <button
          title={`Hide the terminal panel${actionKeys('panel.terminal') ? ` (${actionKeys('panel.terminal')})` : ''}`}
          aria-label="Hide terminal panel"
          onClick={onHide}
          className={stripButton}
        >
          {/* Points to the edge it folds into; a cross here would read as the session's close beside it */}
          <Icon name="chevron" className={`size-3.5 ${side === 'bottom' ? 'rotate-90' : side === 'left' ? 'rotate-180' : ''}`} />
        </button>
      )}
    </div>
  )
}

const PANE_MIN = 120

/** The line between two split panes, on the edge of the later one; dragging it shares their space anew */
function PaneDivider({
  across,
  before,
  after,
  grow,
  onGrow
}: {
  /** Between stacked rows rather than columns */
  across: boolean
  before: string
  after: string
  grow: Record<string, number>
  onGrow: (grow: Record<string, number>) => void
}): React.JSX.Element {
  const startDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const handle = event.currentTarget
    const second = handle.parentElement
    const first = second?.previousElementSibling
    if (!second || !first) return
    const size = (element: Element): number => (across ? element.getBoundingClientRect().height : element.getBoundingClientRect().width)
    const [firstSize, total] = [size(first), size(first) + size(second)]
    const weight = (grow[before] ?? 1) + (grow[after] ?? 1)
    const start = across ? event.clientY : event.clientX
    handle.setPointerCapture(event.pointerId)
    handle.onpointermove = (move) => {
      const next = Math.max(PANE_MIN, Math.min(total - PANE_MIN, firstSize + (across ? move.clientY : move.clientX) - start))
      onGrow({ ...grow, [before]: (weight * next) / total, [after]: (weight * (total - next)) / total })
    }
    handle.onpointerup = () => {
      handle.onpointermove = null
    }
  }
  return (
    <div onPointerDown={startDrag} className={`group absolute z-10 ${across ? 'inset-x-0 -top-1.5 h-3 cursor-row-resize' : 'inset-y-0 -left-1.5 w-3 cursor-col-resize'}`}>
      <span className={`pointer-events-none absolute bg-border ${across ? 'inset-x-0 top-1.5 h-px' : 'inset-y-0 left-1.5 w-px'}`} />
      <ResizeGrip across={across} />
    </div>
  )
}

/** A workspace with no sessions: start one, or bring back a closed one */
function EmptySessions({ label, cwd, history, repos }: { label: string; cwd: string; history: ClosedSession[]; repos: Repo[] | null }): React.JSX.Element {
  const entries = useNewSessionEntries()
  return (
    <div data-terminal-empty className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-y-auto bg-background p-4 text-center">
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-foreground/5 text-muted-foreground">
        <Icon name="terminal" className="size-5" />
      </span>
      <p className="max-w-full truncate text-[13px] text-muted-foreground">
        No sessions in <span className="text-foreground">{label}</span>
      </p>
      {/* Capped, so many profiles wrap into a block instead of one ribbon across the window */}
      <div className="flex max-w-md flex-wrap justify-center gap-2">
        {entries.map(({ agent: kind, label: kindLabel, view }, index) => (
          <button
            key={`${view}:${kind}`}
            data-zone-focus={index === 0 ? '' : undefined}
            onClick={() => openSession(cwd, kind, view)}
            className="flex h-8 items-center gap-2 rounded-md bg-foreground/5 px-3 text-xs text-foreground hover:bg-accent"
          >
            {view === 'chat' ? <Icon name="comment" className="size-3.5 text-muted-foreground" /> : <KindBadge kind={kind} />}
            {kindLabel}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground">
        <kbd className="kbd">⌘T</kbd> new shell
      </p>
      {history.length > 0 && (
        <div className="w-full max-w-md text-left">
          <p className="px-1.5 pb-1 text-[11px] font-semibold text-foreground">Recently closed</p>
          <ClosedSessions entries={history.slice(0, 8)} repos={repos} />
        </div>
      )}
    </div>
  )
}

/** The session the workspace has on screen, under its toolbar */
export function WorkspaceTerminals({
  session,
  panes,
  label,
  cwd,
  history,
  repos,
  page,
  onHide,
  side,
  onMove,
  onGoToFolder
}: {
  /** The session on screen, picked in the sidebar */
  session: Session | null
  /** The sessions on screen, as columns of stacked panes: the shown session alone, or the split it is in */
  panes: Session[][]
  /** The workspace's name for the empty state */
  label: string
  /** Where sessions start */
  cwd: string
  /** Closed sessions of the workspace */
  history: ClosedSession[]
  repos: Repo[] | null
  /** On the Terminal page rather than docked */
  page: boolean
  /** Closes the panel, when docked */
  onHide?: () => void
  /** Where the panel is docked, and moving it elsewhere */
  side?: DockSide
  onMove?: (side: DockSide) => void
  /** Goes to a folder picked from the toolbar, on the Terminal page */
  onGoToFolder?: (path: string) => void
}): React.JSX.Element {
  useSettings()
  const grow = useTerminals().paneGrow
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <SessionBar session={session} label={label} cwd={cwd} repos={repos} page={page} onHide={onHide} side={side} onMove={onMove} onGoToFolder={onGoToFolder} />
      {session ? (
        <div data-terminal-panes className="flex min-h-0 min-w-0 flex-1">
          {panes.map((column, index) => (
            <div key={column[0].id} style={{ flexGrow: grow[`column:${column[0].id}`] ?? 1 }} className="relative flex min-w-0 basis-0 flex-col">
              {index > 0 && <PaneDivider across={false} before={`column:${panes[index - 1][0].id}`} after={`column:${column[0].id}`} grow={grow} onGrow={setPaneGrow} />}
              {column.map((pane, row) => (
                <div key={pane.id} style={{ flexGrow: grow[pane.id] ?? 1 }} className="relative flex min-h-0 basis-0">
                  {row > 0 && <PaneDivider across before={column[row - 1].id} after={pane.id} grow={grow} onGrow={setPaneGrow} />}
                  {/* Like iTerm, the panes without the keys dim a little, so the one typed into stands out; the divider keeps its tone */}
                  <div className={`flex min-h-0 min-w-0 flex-1 ${pane.id !== session.id ? 'opacity-60' : ''}`}>
                    <SessionView session={pane} />
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : (
        <EmptySessions label={label} cwd={cwd} history={history} repos={repos} />
      )}
    </div>
  )
}
