import { useEffect, useRef } from 'react'
import {
  createBridge,
  definePluginSettings,
  getShell,
  type HostApi,
  isTyping,
  onShellCommand,
  PageLayout,
  type RendererPlugin,
  SESSION_KINDS,
  type SessionKind,
  type SessionSummary,
  type ShortcutInfo,
  showPanel,
  togglePanel,
  useHost
} from '@treeix/sdk'
import { actionForEvent, actionKeys, defineActions, key, matchesAction } from '@treeix/shared/keymap'
import { FileIcon, Icon } from '@treeix/app/Icon'
import { MarkdownFoldScope } from '@treeix/app/LazyMarkdown'
import { isMarkdownPath, MarkdownPreview, PreviewToggle, useMarkdownPreview } from '@treeix/app/MarkdownPreview'
import { KindBadge, worktreeLabel } from '@treeix/app/sessionUi'
import { digitPressed } from '@treeix/app/settings'
import { IconButton, ResizeHandle, usePersisted } from '@treeix/app/ui'
import { getCurrentWorkspaceId, inWorkspace, useWorkspaces } from '@treeix/app/workspaces'
import { Inspector } from './Inspector'
import { SessionsDialog } from './SessionsDialog'
import { startRename, TaskList } from './TaskList'
import { openTab, TaskTerminals } from './TerminalPanel'
import { resolvePath } from './fileLinks'
import { type Task, taskOf, uniqueName } from './tasks'
import { switchTask, taskLabel } from './taskUi'
import {
  type ClosedSession,
  closeActivePane,
  createSession,
  createTask,
  deleteTask,
  focusNeighbor,
  focusPaneAt,
  focusSession,
  focusShown,
  getTerminals,
  isTerminalFocused,
  restoreClosedSession,
  revealSession,
  selectTask,
  type Session,
  sendText,
  setActiveTab,
  setFileLinkHandler,
  setWebLinkHandler,
  splitPane,
  subscribeTerminals,
  toggleZoom,
  useTerminals,
  whenReady
} from './terminals'

const TAB_ID = 'terminal'

/** `root` is the folder `path` is relative to; older saved previews have none and use the explorer's */
type FilePreview = { path: string; line: number | null; root?: string }

const view = definePluginSettings('terminal', (stored) => ({
  /** The open file in each workspace */
  previews: (typeof stored.previews === 'object' && stored.previews !== null ? stored.previews : {}) as Record<string, FilePreview | null>,
  /** The file preview fills the main zone, the terminals stay alive behind it */
  previewMaximized: stored.previewMaximized === true
}))

const setPreview = (preview: FilePreview | null): void => view.update({ previews: { ...view.get().previews, [getCurrentWorkspaceId()]: preview } })

/** The ⌘⇧J session switcher, `closed` for G H */
const dialogs = definePluginSettings('terminal-dialog', () => ({ sessions: null as 'all' | 'closed' | null }))

let summaries: { from: Session[]; list: SessionSummary[] } = { from: [], list: [] }
/** Sessions without their xterm objects, the same array until the sessions change */
function sessionSummaries(): SessionSummary[] {
  const { sessions } = getTerminals()
  if (summaries.from !== sessions) {
    summaries = {
      from: sessions,
      list: sessions.map(({ id, kind, title, status, exitCode, worktreePath, workspaceId, startedAt }) => ({ id, kind, title, status, exitCode, worktreePath, workspaceId, startedAt }))
    }
  }
  return summaries.list
}

type TaskScope = { tasks: Task[]; task: Task | null; sessions: Session[]; history: ClosedSession[] }

/** Tasks, sessions and closed sessions of the current workspace, and the task on screen */
function useTaskScope(): TaskScope {
  const { repos } = useHost()
  const { workspaces, currentId } = useWorkspaces()
  const workspace = workspaces.find((candidate) => candidate.id === currentId)
  const state = useTerminals()
  const include = (item: { worktreePath: string; workspaceId: string }): boolean => inWorkspace(item, workspace, repos, workspaces)
  const tasks = state.tasks.filter(include)
  const task = tasks.find((candidate) => candidate.id === state.selected[currentId]) ?? tasks[0] ?? null
  return { tasks, task, sessions: state.sessions.filter(include), history: state.history.filter(include) }
}

/** The latest scope, for keys handled outside React; kept by Root, which is always mounted */
let scope: TaskScope = { tasks: [], task: null, sessions: [], history: [] }

/** Closed sessions of a task; those of deleted tasks, or from before tasks, go with the task on their folder */
const historyOf = (history: ClosedSession[], task: Task): ClosedSession[] => {
  const tasks = getTerminals().tasks
  return history.filter((entry) => entry.taskId === task.id || (!tasks.some((candidate) => candidate.id === entry.taskId) && entry.worktreePath === task.worktreePath))
}

const WaitingDot = ({ className }: { className: string }): React.JSX.Element | null => {
  const waiting = useTaskScope().sessions.filter((session) => session.status === 'input').length
  return waiting > 0 ? <span title={`${waiting} waiting for input`} className={`rounded-full bg-amber-400 ${className}`} /> : null
}

function TerminalPage(): React.JSX.Element {
  const host = useHost()
  const { tasks, task, sessions, history } = useTaskScope()
  const { previews, previewMaximized } = view.use()
  const preview = previews[useWorkspaces().currentId] ?? null
  const [previewWidth, setPreviewWidth] = usePersisted<number>('terminalTab.previewWidth', 560)
  // The file opener is registered once, so it reads the explorer's folder through a ref
  const explorerRoot = useRef(host.explorerRoot)
  explorerRoot.current = host.explorerRoot
  const open = (path: string, line: number | null = null, root = explorerRoot.current): void => setPreview({ path, line, root })
  const [markdownPreview, setMarkdownPreview] = useMarkdownPreview()
  useEffect(() => host.registerFileOpener(TAB_ID, open), [])
  const previewRoot = preview?.root ?? host.explorerRoot
  const label = task ? taskLabel(task, host.repos) : worktreeLabel(host.repos, host.defaultCwd)

  return (
    <PageLayout
      listLabel="Groups"
      inspectorLabel="Group"
      listWidth={240}
      hints={{
        list: [['⌘⇧T', 'new group'], ['e', 'rename'], ['⌘⌫', 'delete']],
        main: [['⌘T', 'new tab'], ['⌃⌘↑↓', 'group']]
      }}
      list={<TaskList tasks={tasks} current={task} sessions={sessions} repos={host.repos} onNew={() => startTask(host)} history={task ? historyOf(history, task) : history} />}
      main={
        <div className="flex min-h-0 min-w-0 flex-1">
          <div className={`min-w-0 flex-1 flex-col ${preview && previewMaximized ? 'hidden' : 'flex'}`}>
            <TaskTerminals task={task} label={label} cwd={host.defaultCwd} history={task ? historyOf(history, task) : history} repos={host.repos} orientation="horizontal" page />
          </div>
          {preview && (
            <aside style={previewMaximized ? undefined : { width: previewWidth }} className={`relative flex min-w-0 flex-col border-border bg-background ${previewMaximized ? 'flex-1' : 'shrink-0 border-l'}`}>
              {!previewMaximized && <ResizeHandle edge="left" width={previewWidth} min={320} max={1100} onResize={setPreviewWidth} />}
              <MarkdownFoldScope>
                <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border pr-1.5 pl-3">
                  <FileIcon path={preview.path} />
                  <span className="min-w-0 truncate font-mono text-xs text-foreground/85 select-text" title={preview.path}>
                    {preview.path}
                    {preview.line && <span className="text-muted-foreground">:{preview.line}</span>}
                  </span>
                  <span className="flex-1" />
                  {isMarkdownPath(preview.path) && <PreviewToggle on={markdownPreview} onChange={setMarkdownPreview} />}
                  <IconButton label={previewMaximized ? 'Show the terminals' : 'Fill the page'} active={previewMaximized} onClick={() => view.update({ previewMaximized: !previewMaximized })}>
                    <Icon name={previewMaximized ? 'minimize' : 'maximize'} className="size-3.5" />
                  </IconButton>
                  <IconButton label="Close preview" onClick={() => setPreview(null)}>
                    <Icon name="close" className="size-3" />
                  </IconButton>
                </div>
                {markdownPreview && isMarkdownPath(preview.path) ? (
                  <div className="min-h-0 flex-1 overflow-auto">
                    <MarkdownPreview loadKey={`${previewRoot}:${preview.path}`} load={() => window.api.readFile(previewRoot, preview.path)} />
                  </div>
                ) : (
                  host.renderFileView(previewRoot, preview.path, preview.line)
                )}
              </MarkdownFoldScope>
            </aside>
          )}
        </div>
      }
      inspector={
        <Inspector
          previewPath={previewRoot === host.explorerRoot ? (preview?.path ?? null) : null}
          onOpenFile={(path, root) => open(path, null, root)}
        />
      }
    />
  )
}

const bridge = createBridge('terminal')

/**
 * ⌘-click on a path in a session: shows the file on the Terminal page, with the Files panel on the folder it is in
 * unless that folder is already shown. Relative paths start where the session's shell is now.
 */
function useFileLinks(): void {
  const host = useHost()
  const showInspector = (): void => {
    if (getShell().pages[TAB_ID]?.inspector === false) togglePanel('inspector', TAB_ID)
  }
  useEffect(() =>
    setFileLinkHandler(async (sessionId, path, line) => {
      const session = getTerminals().sessions.find((candidate) => candidate.id === sessionId)
      const cwd = (await bridge.invoke<string | null>('cwd', sessionId).catch(() => null)) ?? session?.worktreePath ?? window.api.home
      const absolute = resolvePath(path, cwd, window.api.home)
      const parent = absolute.slice(0, absolute.lastIndexOf('/')) || '/'
      const isFolder = (await window.api.listDirectory(parent, '')).includes(`${absolute.slice(parent.length + 1)}/`)
      // Binary and oversized files have no viewer here; the Finder knows what opens them
      if (!isFolder && (await window.api.readFile(absolute, '').catch(() => null)) === null) return window.api.revealInFinder(absolute)
      if (host.activeTab !== TAB_ID) host.setActiveTab(TAB_ID)
      if (isFolder) {
        host.setBrowsedFolder(absolute)
        return showInspector()
      }
      const inside = absolute.startsWith(`${host.explorerRoot}/`)
      const folder = inside ? host.explorerRoot : parent
      if (!inside) host.setBrowsedFolder(folder)
      setPreview({ path: absolute.slice(folder.length + 1), line, root: folder })
    })
  )
  useEffect(() =>
    setWebLinkHandler(async (url) => {
      const opened = (await host.service('pullRequests')?.open(url, host).catch(() => false)) ?? false
      if (!opened) window.open(url)
    })
  )
}

function DockedTerminal({ side }: { side: 'left' | 'right' | 'bottom' }): React.JSX.Element {
  const host = useHost()
  const { task, sessions, history } = useTaskScope()
  // The panel closes itself once the last session exits; opened empty by hand (⌘J) it stays
  const hadSessions = useRef(sessions.length > 0)
  useEffect(() => {
    if (sessions.length > 0) hadSessions.current = true
    else if (hadSessions.current) {
      hadSessions.current = false
      host.hidePanel(TAB_ID)
    }
  }, [sessions.length])
  return (
    <TaskTerminals
      task={task}
      label={task ? taskLabel(task, host.repos) : worktreeLabel(host.repos, host.defaultCwd)}
      cwd={host.defaultCwd}
      history={task ? historyOf(history, task) : history}
      repos={host.repos}
      orientation={side === 'bottom' ? 'horizontal' : 'vertical'}
      page={false}
      onHide={() => host.hidePanel(TAB_ID)}
    />
  )
}

function SessionsButton(): React.JSX.Element {
  const { sessions } = useTaskScope()
  const waiting = sessions.filter((session) => session.status === 'input').length
  return (
    <button
      title={`Sessions${waiting ? `, ${waiting} waiting for input` : ''}${actionKeys('terminal.sessions') ? ` (${actionKeys('terminal.sessions')})` : ''}`}
      onClick={() => dialogs.update({ sessions: 'all' })}
      className="flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground [-webkit-app-region:no-drag]"
    >
      <Icon name="terminal" className="size-3.5" />
      <span className="tabular-nums">{sessions.length}</span>
      {waiting > 0 && (
        <span className="flex items-center gap-1 text-amber-400 tabular-nums">
          <span className="size-1.5 rounded-full bg-amber-400" />
          {waiting}
        </span>
      )}
      <kbd data-key-hint="" className="font-sans text-[10.5px] text-muted-foreground/70">{actionKeys('terminal.sessions')}</kbd>
    </button>
  )
}

/** Brings the terminals on screen: the docked panel on Worktrees, else the Terminal page */
function showTerminals(host: HostApi): void {
  if (host.activeTab === TAB_ID || host.isPanelVisible(TAB_ID)) return
  if (host.activeTab === 'worktrees') host.showPanel(TAB_ID)
  else host.setActiveTab(TAB_ID)
}

function reveal(host: HostApi, id: string): void {
  revealSession(id)
  showTerminals(host)
  setTimeout(() => focusSession(id), 50)
}

/** A new tab of the task on screen, focused */
function newTab(host: HostApi, kind: SessionKind): void {
  openTab(scope.task?.worktreePath ?? host.defaultCwd, kind, scope.task?.id)
  showTerminals(host)
}

/** ⌘⇧T: a task with a shell in the current folder, named after that folder */
function startTask(host: HostApi): void {
  const cwd = host.defaultCwd
  const name = uniqueName(worktreeLabel(host.repos, cwd), scope.tasks.map((task) => taskLabel(task, host.repos)))
  openTab(cwd, 'shell', createTask(name, cwd))
  showTerminals(host)
}

/** ⌃⌘↑ ⌃⌘↓: the previous or next task; focus follows into its terminal unless it is on the task list */
function stepTask(host: HostApi, step: 1 | -1): void {
  const { tasks, task } = scope
  if (tasks.length === 0) return
  const index = tasks.findIndex((candidate) => candidate.id === task?.id)
  switchTask(host, tasks[(index + step + tasks.length) % tasks.length])
  showTerminals(host)
  if (getShell().zone !== 'list') focusShown()
}

function Root(): React.JSX.Element | null {
  const host = useHost()
  const { sessions: switcher } = dialogs.use()
  const current = useTaskScope()
  scope = current
  const { currentId } = useWorkspaces()
  useFileLinks()
  // Keys and new terminals act on the task on screen, so the store knows which that is
  useEffect(() => {
    if (current.task && getTerminals().selected[currentId] !== current.task.id) selectTask(current.task.id)
  }, [current.task?.id, currentId])
  useEffect(() => onShellCommand('closedSessions', () => dialogs.update({ sessions: 'closed' })), [])
  return (
    <>
      {switcher && (
        <SessionsDialog
          sessions={current.sessions}
          history={current.history}
          tasks={current.tasks}
          repos={host.repos}
          mode={switcher}
          onClose={() => dialogs.update({ sessions: null })}
          onPick={(session) => reveal(host, session.id)}
          onRestore={(entry) => void restoreClosedSession(entry).then((id) => reveal(host, id))}
        />
      )}
    </>
  )
}

/** The plugin's keys, all rebindable in Settings */
defineActions([
  { id: 'panel.terminal', label: 'Toggle the terminal panel', section: 'Terminal', keys: key('KeyJ', { meta: true }) },
  { id: 'terminal.sessions', label: 'Find and switch sessions', section: 'Terminal', keys: key('KeyJ', { meta: true, shift: true }) },
  { id: 'terminal.newGroup', label: 'New group with a shell in the current folder', section: 'Terminal', keys: key('KeyT', { meta: true, shift: true }) },
  { id: 'terminal.previousGroup', label: 'Previous group', section: 'Terminal', keys: key('ArrowUp', { meta: true, ctrl: true }) },
  { id: 'terminal.nextGroup', label: 'Next group', section: 'Terminal', keys: key('ArrowDown', { meta: true, ctrl: true }) },
  { id: 'terminal.newTab', label: 'New shell tab in the group', section: 'Terminal', keys: key('KeyT', { meta: true }) },
  { id: 'terminal.newTabAlt', label: 'New shell tab, second key', section: 'Terminal', keys: key('KeyN', { meta: true }) },
  { id: 'terminal.splitRight', label: 'Split the active pane right with a new shell', section: 'Terminal', keys: key('KeyD', { meta: true }) },
  { id: 'terminal.splitDown', label: 'Split the active pane down with a new shell', section: 'Terminal', keys: key('KeyD', { meta: true, shift: true }) },
  { id: 'terminal.paneLeft', label: 'Focus the pane to the left', section: 'Terminal', keys: key('ArrowLeft', { meta: true, alt: true }) },
  { id: 'terminal.paneRight', label: 'Focus the pane to the right', section: 'Terminal', keys: key('ArrowRight', { meta: true, alt: true }) },
  { id: 'terminal.paneUp', label: 'Focus the pane above', section: 'Terminal', keys: key('ArrowUp', { meta: true, alt: true }) },
  { id: 'terminal.paneDown', label: 'Focus the pane below', section: 'Terminal', keys: key('ArrowDown', { meta: true, alt: true }) },
  { id: 'terminal.zoomPane', label: 'Maximize the focused pane, or restore it', section: 'Terminal', keys: key('Enter', { meta: true, alt: true }) },
  { id: 'terminal.inspector', label: 'Inspector with files, alias of ⌘⌥B', section: 'Terminal', page: TAB_ID, keys: key('KeyP', { meta: true }) },
  { id: 'terminal.renameGroup', label: 'Rename the group on screen, from anywhere on the page', section: 'Terminal', page: TAB_ID, keys: key('F2') },
  { id: 'terminal.deleteGroup', label: 'Delete the group on screen, from anywhere on the page', section: 'Terminal', page: TAB_ID, keys: key('Backspace', { meta: true, shift: true }) },
  { id: 'terminal.renameInList', label: 'Rename the group in place, also double-click (group list)', section: 'Terminal', page: TAB_ID, keys: key('KeyE') },
  { id: 'terminal.deleteInList', label: 'Delete the group, its sessions go to History (group list)', section: 'Terminal', page: TAB_ID, keys: key('Backspace', { meta: true }) }
])

const PANE_SIDES: Record<string, 'left' | 'right' | 'top' | 'bottom'> = { 'terminal.paneLeft': 'left', 'terminal.paneRight': 'right', 'terminal.paneUp': 'top', 'terminal.paneDown': 'bottom' }

function onKeyDown(event: KeyboardEvent, host: HostApi): boolean {
  const open = dialogs.get()
  if (matchesAction(event, 'terminal.sessions')) {
    dialogs.update({ sessions: open.sessions ? null : 'all' })
    return true
  }
  if (open.sessions) return false
  const onPage = host.activeTab === TAB_ID
  const terminal = isTerminalFocused()
  // Keys that work from anywhere in the app
  const anywhere: Record<string, () => void> = {
    'terminal.previousGroup': () => stepTask(host, -1),
    'terminal.nextGroup': () => stepTask(host, 1),
    'terminal.newGroup': () => startTask(host),
    'terminal.newTab': () => newTab(host, 'shell'),
    'terminal.newTabAlt': () => newTab(host, 'shell')
  }
  const anywhereId = actionForEvent(event, Object.keys(anywhere))
  if (anywhereId) {
    anywhere[anywhereId]()
    return true
  }
  // Pane and tab digits only apply inside the terminals, elsewhere the app's digits work; digits match the physical key, so ⌥ producing ¡™£ doesn't matter
  const paneDigit = digitPressed(event, 'alt')
  if (paneDigit && terminal) {
    focusPaneAt(paneDigit)
    return true
  }
  const tabDigit = digitPressed(event, 'meta')
  if (tabDigit && terminal) {
    const tabs = scope.task?.tabs ?? []
    // 9 is the last tab, like browsers
    const tab = tabDigit === 9 ? tabs.at(-1) : tabs[tabDigit - 1]
    if (scope.task && tab) {
      setActiveTab(scope.task.id, tab.id)
      focusShown()
    }
    return true
  }
  const split = actionForEvent(event, ['terminal.splitRight', 'terminal.splitDown'])
  if (split && (onPage || host.isPanelVisible(TAB_ID))) {
    void splitPane(split === 'terminal.splitDown' ? 'bottom' : 'right', host.defaultCwd)
    return true
  }
  // Moving between panes and zooming one only make sense with a terminal focused
  const pane = terminal ? actionForEvent(event, ['terminal.paneLeft', 'terminal.paneRight', 'terminal.paneUp', 'terminal.paneDown', 'terminal.zoomPane']) : undefined
  if (pane === 'terminal.zoomPane') {
    toggleZoom()
    return true
  }
  if (pane) {
    focusNeighbor(PANE_SIDES[pane])
    return true
  }
  if (onPage && matchesAction(event, 'terminal.inspector')) {
    togglePanel('inspector', TAB_ID)
    return true
  }
  const task = scope.task
  // Anywhere on the page, even in a terminal: the group on screen can be renamed or deleted
  const inField = isTyping(event) && !terminal
  if (onPage && task && !inField && matchesAction(event, 'terminal.renameGroup')) {
    showPanel('list', TAB_ID)
    startRename(task.id)
    return true
  }
  if (onPage && task && !inField && matchesAction(event, 'terminal.deleteGroup')) {
    deleteTask(task.id)
    return true
  }
  // The task list's own keys
  if (!onPage || !task || getShell().zone !== 'list' || isTyping(event)) return false
  if (matchesAction(event, 'terminal.renameInList')) {
    startRename(task.id)
    return true
  }
  if (matchesAction(event, 'terminal.deleteInList')) {
    deleteTask(task.id)
    return true
  }
  return false
}

/** Keys the plugin owns that aren't single actions: the digit rows and the pane close that rides the app's ⌘W */
const SHORTCUTS: ShortcutInfo[] = (
  [
    ['⌘1-9', 'Tab of the group, 9 is the last (in a terminal)', undefined],
    ['⌥1-9', 'Focus the nth pane (in a terminal)', undefined],
    ['⌘W', 'Close the focused pane to History; the last pane closes its tab', undefined]
  ] satisfies [string, string, string | undefined][]
).map(([keys, label, page]) => ({ keys, label, section: 'Terminal', page }))

const plugin: RendererPlugin = {
  tabs: [{ id: TAB_ID, label: 'Terminal', icon: 'terminal', order: 10, render: TerminalPage, Badge: () => <WaitingDot className="size-1.5" /> }],
  panels: [
    {
      id: TAB_ID,
      label: 'Terminal',
      icon: 'terminal',
      render: DockedTerminal,
      Badge: () => <WaitingDot className="absolute top-1 right-1 size-1.5 ring-2 ring-background" />
    }
  ],
  Root,
  titleBar: [{ order: 20, render: SessionsButton }],
  onKeyDown,
  onCloseShortcut: () => {
    if (!isTerminalFocused()) return false
    closeActivePane()
    return true
  },
  commands: (host) => [
    { id: 'sessions', group: 'Actions', label: 'Find session', icon: 'terminal', shortcut: actionKeys('terminal.sessions') || undefined, run: () => dialogs.update({ sessions: 'all' }) },
    { id: 'task:new', group: 'Actions', label: 'New group', icon: 'plus', shortcut: actionKeys('terminal.newGroup') || undefined, run: () => startTask(host) },
    ...(Object.keys(SESSION_KINDS) as SessionKind[]).map((kind) => ({
      id: `session:${kind}`,
      group: 'Actions',
      label: `New ${SESSION_KINDS[kind].label} tab`,
      detail: scope.task ? taskLabel(scope.task, host.repos) : (host.selectedWorktreeLabel ?? '~ home'),
      icon: 'terminal' as const,
      shortcut: kind === 'shell' ? actionKeys('terminal.newTab') || undefined : undefined,
      run: () => newTab(host, kind)
    })),
    // @ in the palette searches these
    ...scope.tasks.map((task) => ({ id: `task:${task.id}`, group: 'Sessions', label: taskLabel(task, host.repos), detail: 'Group', icon: 'list' as const, run: () => (switchTask(host, task), showTerminals(host), focusShown()) })),
    ...scope.sessions.map((session) => {
      const task = taskOf(scope.tasks, session.id)
      return { id: `session-open:${session.id}`, group: 'Sessions', label: session.title, detail: task ? taskLabel(task, host.repos) : worktreeLabel(host.repos, session.worktreePath), icon: 'terminal' as const, run: () => reveal(host, session.id) }
    })
  ],
  shortcuts: SHORTCUTS,
  services: {
    sessions: {
      subscribe: subscribeTerminals,
      getSessions: sessionSummaries,
      start: createSession,
      whenReady,
      sendText,
      runCommand: (cwd, command) => createSession(cwd, 'shell', command),
      reveal: (id) => {
        revealSession(id)
        setTimeout(() => focusSession(id), 50)
      }
    }
  },
  toolMarks: {
    claude: () => <KindBadge kind="claude" />,
    codex: () => <KindBadge kind="codex" />
  }
}

export default plugin
