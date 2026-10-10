import { useEffect, useRef } from 'react'
import {
  createBridge,
  definePluginSettings,
  getShell,
  type HostApi,
  isTyping,
  onShellCommand,
  PageLayout,
  registerActionRunner,
  type RendererPlugin,
  type SessionKind,
  type SessionSummary,
  type ShortcutInfo,
  togglePanel,
  useHost,
  PANE_HEADER
} from '@treeix/sdk'
import { chatAgent, getAgents } from '@treeix/app/agents'
import { actionForEvent, actionKeys, defineActions, key, matchesAction } from '@treeix/shared/keymap'
import { FileIcon, Icon } from '@treeix/app/Icon'
import { MarkdownFoldScope } from '@treeix/app/LazyMarkdown'
import { useService } from '@treeix/app/plugins'
import { HtmlPreview, isHtmlPath, isPreviewPath, MarkdownPreview, PreviewToggle, useMarkdownPreview } from '@treeix/app/MarkdownPreview'
import { KindBadge, worktreeLabel } from '@treeix/app/sessionUi'
import { digitPressed } from '@treeix/app/settings'
import { IconButton, ResizeHandle, usePersisted } from '@treeix/app/ui'
import { getCurrentWorkspaceId, inWorkspace, useWorkspaces, workspaceOf } from '@treeix/app/workspaces'
import { setFolderPickerOpen, setPickedFolder, terminalCwd, useTerminalCwd } from './folder'
import { Inspector } from './Inspector'
import { SessionsDialog } from './SessionsDialog'
import { startRename } from './rename'
import { openSession, WorkspaceTerminals } from './SessionPanel'
import { findInFiles, resolvePath } from './fileLinks'
import { NEW_TAB_ACTIONS } from './sessionMeta'
import {
  activeSession,
  type ClosedSession,
  closeActiveSession,
  killSession,
  createSession,
  focusSession,
  isRestored,
  focusShown,
  getPorts,
  getTerminals,
  isTerminalFocused,
  restoreClosedSession,
  revealSession,
  selectSession,
  splitSession,
  type Session,
  type SessionView,
  sendText,
  setFileLinkHandler,
  setSessionRevealer,
  setIssueLinks,
  setWebLinkHandler,
  subscribeTerminals,
  syncChats,
  useTerminals,
  whenReady
} from './terminals'

const TAB_ID = 'terminal'

/** `root` is the folder `path` is relative to; older saved previews have none and use the explorer's */
type FilePreview = { path: string; line: number | null; root?: string }

const view = definePluginSettings('terminal', (stored) => ({
  /** The open file in each workspace */
  previews: (typeof stored.previews === 'object' && stored.previews !== null ? stored.previews : {}) as Record<string, FilePreview | null>,
  /** The files open as tabs in each workspace, the preview being the active one */
  fileTabs: (typeof stored.fileTabs === 'object' && stored.fileTabs !== null ? stored.fileTabs : {}) as Record<string, FilePreview[]>,
  /** The file preview fills the main zone, the terminals stay alive behind it */
  previewMaximized: stored.previewMaximized === true
}))

const sameFile = (a: FilePreview, b: FilePreview): boolean => a.path === b.path && a.root === b.root

/** Shows a file, opening a tab for it unless it has one */
const setPreview = (preview: FilePreview | null): void => {
  const { previews, fileTabs } = view.get()
  const workspaceId = getCurrentWorkspaceId()
  const tabs = fileTabs[workspaceId] ?? []
  const nextTabs = !preview || tabs.some((tab) => sameFile(tab, preview)) ? tabs : [...tabs, preview]
  view.update({ previews: { ...previews, [workspaceId]: preview }, fileTabs: { ...fileTabs, [workspaceId]: preview ? nextTabs : [] } })
}

/** Closes a tab; closing the shown file shows its neighbour */
const closeFileTab = (file: FilePreview): void => {
  const { previews, fileTabs } = view.get()
  const workspaceId = getCurrentWorkspaceId()
  const tabs = fileTabs[workspaceId] ?? []
  const index = tabs.findIndex((tab) => sameFile(tab, file))
  const rest = tabs.filter((_, position) => position !== index)
  const shown = previews[workspaceId]
  const nextShown = shown && !sameFile(shown, file) ? shown : (rest[Math.min(index, rest.length - 1)] ?? null)
  view.update({ previews: { ...previews, [workspaceId]: nextShown }, fileTabs: { ...fileTabs, [workspaceId]: rest } })
}

/** The ⌘⇧J session switcher, `closed` for G H */
const dialogs = definePluginSettings('terminal-dialog', () => ({ sessions: null as 'all' | 'closed' | null }))

let summaries: { from: Session[]; list: SessionSummary[] } = { from: [], list: [] }
/** Sessions without their xterm objects, the same array until the sessions change */
function sessionSummaries(): SessionSummary[] {
  const { sessions } = getTerminals()
  if (summaries.from !== sessions) {
    summaries = {
      from: sessions,
      list: sessions.map(({ id, kind, view, title, status, exitCode, worktreePath, workspaceId, startedAt }) => ({
        id,
        kind,
        view,
        title,
        status,
        exitCode,
        worktreePath,
        workspaceId,
        startedAt
      }))
    }
  }
  return summaries.list
}

type Scope = { sessions: Session[]; session: Session | null; panes: Session[][]; history: ClosedSession[] }

/** Sessions and closed sessions of the current workspace, and the session on screen */
function useScope(): Scope {
  const { repos } = useHost()
  const { workspaces, currentId } = useWorkspaces()
  const workspace = workspaceOf(workspaces, currentId)
  const state = useTerminals()
  const include = (item: { worktreePath: string; workspaceId: string }): boolean => inWorkspace(item, workspace, repos, workspaces)
  const sessions = state.sessions.filter(include)
  const session = sessions.find((candidate) => candidate.id === state.selected[currentId]) ?? sessions[0] ?? null
  // The split the shown session is in, else the session alone
  const layout = session && state.splits[session.workspaceId]
  const panes = layout?.flat().includes(session.id)
    ? layout.map((column) => column.flatMap((id) => sessions.filter((candidate) => candidate.id === id))).filter((column) => column.length > 0)
    : session
      ? [[session]]
      : []
  return { sessions, session, panes, history: state.history.filter(include) }
}

/** The latest scope, for keys handled outside React; kept by Root, which is always mounted */
let scope: Scope = { sessions: [], session: null, panes: [], history: [] }

const WaitingDot = ({ className }: { className: string }): React.JSX.Element | null => {
  const waiting = useScope().sessions.filter((session) => session.status === 'input').length
  return waiting > 0 ? <span title={`${waiting} waiting for input`} className={`rounded-full bg-amber-400 ${className}`} /> : null
}

function TerminalPage(): React.JSX.Element {
  const host = useHost()
  const { session, panes, history } = useScope()
  const { previews, fileTabs, previewMaximized } = view.use()
  const { currentId } = useWorkspaces()
  const preview = previews[currentId] ?? null
  // Previews saved before tabs existed have no tab of their own
  const openTabs = fileTabs[currentId]?.length ? fileTabs[currentId] : preview ? [preview] : []
  // A share of the page rather than a width, so in a narrow page, like one opened beside another, the file never pushes the terminals out
  const [previewShare, setPreviewShare] = usePersisted<number>('terminalTab.previewShare', 0.4)
  const row = useRef<HTMLDivElement>(null)
  // The file opener is registered once, so it reads the explorer's folder through a ref
  const explorerRoot = useRef(host.explorerRoot)
  explorerRoot.current = host.explorerRoot
  const open = (path: string, line: number | null = null, root = explorerRoot.current): void => setPreview({ path, line, root })
  const [markdownPreview, setMarkdownPreview] = useMarkdownPreview()
  useEffect(() => host.registerFileOpener(TAB_ID, open), [])
  const previewRoot = preview?.root ?? host.explorerRoot
  const cwd = useTerminalCwd(host)

  return (
    <PageLayout
      main={
        <div ref={row} className="flex min-h-0 min-w-0 flex-1">
          <div style={{ flex: preview ? 1 - previewShare : 1 }} className={`min-w-6 flex-col ${preview && previewMaximized ? 'hidden' : 'flex'}`}>
            <WorkspaceTerminals
              session={session}
              panes={panes}
              label={worktreeLabel(host.repos, cwd)}
              cwd={cwd}
              history={history}
              repos={host.repos}
              page
              onGoToFolder={(path) => goToFolder(host, path)}
            />
          </div>
          {preview && (
            <aside
              style={{ flex: previewMaximized ? 1 : previewShare }}
              className={`relative flex min-w-0 flex-col border-border bg-background ${previewMaximized ? '' : 'border-l'}`}
            >
              {!previewMaximized && <ResizeHandle edge="left" onResize={(width) => row.current && setPreviewShare(Math.min(1, width / row.current.clientWidth))} />}
              <MarkdownFoldScope>
                <div className={`${PANE_HEADER} gap-1 px-1.5`}>
                  <div className="flex h-full min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]">
                    {openTabs.map((tab) => {
                      const name = tab.path.split('/').pop() ?? tab.path
                      return (
                        <div
                          key={`${tab.root ?? ''}:${tab.path}`}
                          title={tab.path}
                          onMouseDown={(event) => event.button === 1 && closeFileTab(tab)}
                          className={`flex h-6 max-w-52 shrink-0 items-center gap-1.5 rounded-md pr-1 pl-2 text-xs ${
                            sameFile(tab, preview) ? 'bg-foreground/8 text-foreground ring-1 ring-border' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                          }`}
                        >
                          <button onClick={() => setPreview({ ...tab, line: null })} className="flex min-w-0 items-center gap-1.5">
                            <FileIcon path={tab.path} />
                            <span className="truncate">{name}</span>
                          </button>
                          <button aria-label={`Close ${name}`} onClick={() => closeFileTab(tab)} className="grid size-4 shrink-0 place-items-center rounded hover:bg-accent">
                            <Icon name="close" className="size-2.5" />
                          </button>
                        </div>
                      )
                    })}
                  </div>
                  {isPreviewPath(preview.path) && <PreviewToggle path={preview.path} on={markdownPreview} onChange={setMarkdownPreview} />}
                  <IconButton
                    label={previewMaximized ? 'Show the terminals' : 'Fill the page'}
                    active={previewMaximized}
                    onClick={() => view.update({ previewMaximized: !previewMaximized })}
                  >
                    <Icon name={previewMaximized ? 'minimize' : 'maximize'} className="size-3.5" />
                  </IconButton>
                  <IconButton label="Close all files" onClick={() => setPreview(null)}>
                    <Icon name="close" className="size-3" />
                  </IconButton>
                </div>
                {markdownPreview && isHtmlPath(preview.path) ? (
                  <HtmlPreview path={`${previewRoot}/${preview.path}`} reloadKey={preview.path} />
                ) : markdownPreview && isPreviewPath(preview.path) ? (
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
      inspector={<Inspector previewPath={previewRoot === host.explorerRoot ? (preview?.path ?? null) : null} onOpenFile={(path, root) => open(path, null, root)} />}
    />
  )
}

const bridge = createBridge('terminal')

/** Whether a path is a file, a folder, or nothing */
async function entryAt(absolute: string): Promise<'file' | 'folder' | null> {
  const parent = absolute.slice(0, absolute.lastIndexOf('/')) || '/'
  const name = absolute.slice(parent.length + (parent === '/' ? 0 : 1))
  const entries = await window.api.listDirectory(parent, '')
  return entries.includes(`${name}/`) ? 'folder' : entries.includes(name) ? 'file' : null
}

/** The first target that is there, read from each folder in turn; agents print paths from the repo root, cut short, or bare names */
async function locate(targets: { path: string; line: number | null }[], bases: string[]): Promise<{ absolute: string; entry: 'file' | 'folder'; line: number | null } | null> {
  for (const { path, line } of targets)
    for (const base of bases) {
      const direct = resolvePath(path, base, window.api.home)
      const entry = await entryAt(direct)
      if (entry) return { absolute: direct, entry, line }
      if (/^[/~]/.test(path)) break
      const inFiles = findInFiles(path, (await window.api.listFiles(base).catch(() => ({ files: [] }))).files)
      if (inFiles) return { absolute: `${base}/${inFiles}`, entry: 'file', line }
    }
  return null
}

/**
 * ⌘-click on a path in a session: shows the file on the Terminal page, with the Files panel on the folder it is in
 * unless that folder is already shown. Relative paths start where the session's shell is now, else where it started.
 */
function useFileLinks(): void {
  const host = useHost()
  const showInspector = (): void => {
    if (getShell().pages[TAB_ID]?.inspector === false) togglePanel('inspector', TAB_ID)
  }
  useEffect(() =>
    setFileLinkHandler(async (sessionId, targets) => {
      const session = getTerminals().sessions.find((candidate) => candidate.id === sessionId)
      const shellCwd = await bridge.invoke<string | null>('cwd', sessionId).catch(() => null)
      // Agents print paths from the folder the session started in even after their shell moved
      const bases = [...new Set([shellCwd, session?.worktreePath].filter((base): base is string => !!base))]
      if (!bases.length) bases.push(window.api.home)
      const found = await locate(targets, bases)
      if (!found) return
      const { absolute, line } = found
      const isFolder = found.entry === 'folder'
      const parent = absolute.slice(0, absolute.lastIndexOf('/')) || '/'
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
  // Looked up on use: the Jira plugin may load after this one, or be switched off later
  useEffect(() => setIssueLinks({ isProject: (project) => host.service('jira')?.isProject(project) ?? false, open: (key) => host.service('jira')?.open(key, host) }))
  useEffect(() => setWebLinkHandler(host.openLink))
  // The Terminal page itself, not the docked panel: a notification may have just switched the workspace and its page
  useEffect(() =>
    setSessionRevealer((id) => {
      revealSession(id)
      host.setActiveTab(TAB_ID)
      setTimeout(() => focusSession(id), 50)
    })
  )
}

function DockedTerminal({ side }: { side: 'left' | 'right' | 'bottom' }): React.JSX.Element {
  const host = useHost()
  const cwd = useTerminalCwd(host)
  const { session, panes, sessions, history } = useScope()
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
    <WorkspaceTerminals
      session={session}
      panes={panes}
      label={worktreeLabel(host.repos, cwd)}
      cwd={cwd}
      history={history}
      repos={host.repos}
      page={false}
      onHide={() => host.hidePanel(TAB_ID)}
      side={side}
      onMove={(target) => host.movePanel(TAB_ID, target)}
    />
  )
}

/** On the Terminal tab: how many sessions are open, with an amber dot while any waits for an answer */
function SessionsCount(): React.JSX.Element | null {
  const { sessions } = useScope()
  const waiting = sessions.filter((session) => session.status === 'input').length
  if (!sessions.length) return null
  return (
    <span
      title={`${sessions.length} session${sessions.length === 1 ? '' : 's'}${waiting ? `, ${waiting} waiting for input` : ''}`}
      className="flex items-center gap-1 text-muted-foreground tabular-nums"
    >
      {sessions.length}
      {waiting > 0 && <span className="size-1.5 rounded-full bg-amber-400" />}
    </span>
  )
}

/** Brings the terminals on screen: the docked panel on Worktrees, else the Terminal page */
function showTerminals(host: HostApi): void {
  if (host.activeTab === TAB_ID || host.isPanelVisible(TAB_ID)) return
  if (host.activeTab === 'worktrees') host.showPanel(TAB_ID)
  else host.setActiveTab(TAB_ID)
}

/** The newest closed session of this workspace, like a browser's reopen closed tab */
function reopenClosed(host: HostApi): void {
  const last = scope.history[0]
  if (last) void restoreClosedSession(last).then((id) => reveal(host, id))
}

function reveal(host: HostApi, id: string): void {
  revealSession(id)
  showTerminals(host)
  setTimeout(() => focusSession(id), 50)
}

/** A session in the folder the one on screen runs in, focused */
function newSession(host: HostApi, kind: SessionKind, view: SessionView = 'terminal'): void {
  openSession(scope.session?.worktreePath ?? terminalCwd(host), kind, view)
  showTerminals(host)
}

/** A chat with the agent last picked in one; chats need the chat plugin on */
function newChat(host: HostApi): void {
  const agent = chatAgent()
  if (agent && host.service('chat')) newSession(host, agent.id, 'chat')
}

/** The folder dropdown lives on the Terminal page, so it goes there first */
function openFolderPicker(host: HostApi): void {
  if (host.activeTab !== TAB_ID) host.setActiveTab(TAB_ID)
  setFolderPickerOpen(true)
}

/** Goes to a folder: a session already there, else a new shell in it; later sessions start there too */
function goToFolder(host: HostApi, path: string): void {
  setPickedFolder(host.workspaceId, path)
  const existing = scope.sessions.find((session) => session.worktreePath === path)
  if (existing) return reveal(host, existing.id)
  openSession(path, 'shell')
  showTerminals(host)
}

/** ⌃⌘↑ ⌃⌘↓: the previous or next session of the workspace, focused */
function stepSession(host: HostApi, step: 1 | -1): void {
  const { sessions, session } = scope
  if (sessions.length === 0) return
  const index = sessions.findIndex((candidate) => candidate.id === session?.id)
  selectSession(sessions[(index + step + sessions.length) % sessions.length].id)
  showTerminals(host)
  focusShown()
}

function Root(): React.JSX.Element | null {
  const host = useHost()
  const { sessions: switcher } = dialogs.use()
  const current = useScope()
  scope = current
  const { currentId } = useWorkspaces()
  useFileLinks()
  // Chats go dormant while the chat plugin is off
  const chat = useService('chat')
  useEffect(syncChats, [chat])
  // Keys and new sessions act on the session on screen, so the store knows which that is
  useEffect(() => {
    if (isRestored() && current.session && getTerminals().selected[currentId] !== current.session.id) selectSession(current.session.id)
  }, [current.session?.id, currentId])
  // A workspace switched to starts from its own default folder, not one picked the last time it was on screen
  useEffect(() => setPickedFolder(currentId, null), [currentId])
  useEffect(() => onShellCommand('closedSessions', () => dialogs.update({ sessions: 'closed' })), [])
  const hostRef = useRef(host)
  hostRef.current = host
  useEffect(() => registerActionRunner('terminal.reopenClosed', () => reopenClosed(hostRef.current)), [])
  return (
    <>
      {switcher && (
        <SessionsDialog
          sessions={current.sessions}
          history={current.history}
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
  { id: 'terminal.goToFolder', label: 'Go to folder: a session there, or a new shell in it', section: 'Terminal', keys: key('KeyO', { meta: true }) },
  { id: 'terminal.previousSession', label: 'Previous session', section: 'Terminal', keys: key('ArrowUp', { meta: true, ctrl: true }) },
  { id: 'terminal.nextSession', label: 'Next session', section: 'Terminal', keys: key('ArrowDown', { meta: true, ctrl: true }) },
  { id: 'terminal.newTab', label: 'New shell session', section: 'Terminal', keys: key('KeyT', { meta: true }) },
  { id: 'terminal.newTabAlt', label: 'New shell session, second key', section: 'Terminal', keys: key('KeyN', { meta: true }) },
  { id: 'terminal.newClaudeTab', label: 'New Claude session', section: 'Terminal', keys: key('KeyT', { meta: true, alt: true }) },
  { id: 'terminal.newChat', label: 'New chat, with the agent last picked in one', section: 'Terminal', keys: key('KeyC', { meta: true, alt: true }) },
  { id: 'terminal.splitRight', label: 'Split right with a new shell', section: 'Terminal', keys: key('KeyD', { meta: true }) },
  { id: 'terminal.splitDown', label: 'Split down with a new shell', section: 'Terminal', keys: key('KeyD', { meta: true, shift: true }) },
  { id: 'terminal.previousPane', label: 'Previous split pane', section: 'Terminal', keys: key('BracketLeft', { meta: true }) },
  { id: 'terminal.nextPane', label: 'Next split pane', section: 'Terminal', keys: key('BracketRight', { meta: true }) },
  {
    id: 'terminal.reopenClosed',
    label: 'Reopen the last closed session, resuming its agent conversation',
    menuLabel: 'Reopen Closed Session',
    section: 'Terminal',
    keys: key('KeyZ', { meta: true, alt: true })
  },
  { id: 'terminal.inspector', label: 'Inspector with files, alias of ⌘⌥B', section: 'Terminal', page: TAB_ID, keys: key('KeyP', { meta: true }) },
  { id: 'terminal.rename', label: 'Rename the session on screen, from anywhere on the page', section: 'Terminal', page: TAB_ID, keys: key('F2') }
])

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
    'terminal.previousSession': () => stepSession(host, -1),
    'terminal.nextSession': () => stepSession(host, 1),
    'terminal.newTab': () => newSession(host, 'shell'),
    'terminal.newTabAlt': () => newSession(host, 'shell'),
    'terminal.newClaudeTab': () => newSession(host, 'claude'),
    'terminal.newChat': () => newChat(host),
    'terminal.reopenClosed': () => reopenClosed(host),
    'terminal.goToFolder': () => openFolderPicker(host)
  }
  const anywhereId = actionForEvent(event, Object.keys(anywhere))
  if (anywhereId) {
    anywhere[anywhereId]()
    return true
  }
  // On the Terminal page or in a docked terminal, like iTerm's ⌘D and ⇧⌘D
  const split = (onPage || terminal) && scope.session ? actionForEvent(event, ['terminal.splitRight', 'terminal.splitDown']) : null
  if (split && scope.session) {
    void splitSession(scope.session.id, split === 'terminal.splitRight' ? 'right' : 'bottom', host.flash)
    return true
  }
  // Between split panes in reading order, like iTerm's ⌘[ and ⌘]
  const panes = scope.panes.flat()
  const pane = (onPage || terminal) && panes.length > 1 ? actionForEvent(event, ['terminal.previousPane', 'terminal.nextPane']) : null
  if (pane) {
    const index = panes.findIndex((candidate) => candidate.id === scope.session?.id)
    focusSession(panes[(index + (pane === 'terminal.nextPane' ? 1 : -1) + panes.length) % panes.length].id)
    return true
  }
  // Session digits only apply inside the terminals, elsewhere the app's digits work; digits match the physical key, so ⌥ producing ¡™£ doesn't matter
  const digit = digitPressed(event, 'alt')
  if (digit && terminal) {
    // 9 is the last session, like browsers
    const session = digit === 9 ? scope.sessions.at(-1) : scope.sessions[digit - 1]
    if (session) {
      selectSession(session.id)
      focusShown()
    }
    return true
  }
  if (onPage && matchesAction(event, 'terminal.inspector')) {
    togglePanel('inspector', TAB_ID)
    return true
  }
  // Anywhere on the page, even in a terminal: the session on screen can be renamed
  if (onPage && scope.session && !(isTyping(event) && !terminal) && matchesAction(event, 'terminal.rename')) {
    startRename(scope.session.id)
    return true
  }
  return false
}

/** Keys the plugin owns that aren't single actions: the digit row and the close that rides the app's ⌘W */
const SHORTCUTS: ShortcutInfo[] = (
  [
    ['⌥ 1-9', 'Nth session of the workspace, 9 is the last (in a terminal)', undefined],
    ['⌘ W', 'Close the session on screen to History', undefined]
  ] satisfies [string, string, string | undefined][]
).map(([keys, label, page]) => ({ keys, label, section: 'Terminal', page }))

const plugin: RendererPlugin = {
  tabs: [{ id: TAB_ID, label: 'Terminal', icon: 'terminal', order: 10, render: TerminalPage, Badge: SessionsCount }],
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
  onKeyDown,
  onCloseShortcut: () => {
    if (!isTerminalFocused()) return false
    closeActiveSession()
    return true
  },
  commands: (host) => [
    {
      id: 'sessions',
      group: 'Actions',
      label: 'Find session',
      icon: 'terminal',
      shortcut: actionKeys('terminal.sessions') || undefined,
      run: () => dialogs.update({ sessions: 'all' })
    },
    { id: 'terminal:folder', group: 'Actions', label: 'Go to folder', icon: 'folder', shortcut: actionKeys('terminal.goToFolder') || undefined, run: () => openFolderPicker(host) },
    ...getAgents().map((agent) => ({
      id: `session:${agent.id}`,
      group: 'Actions',
      label: `New ${agent.label} session`,
      detail: worktreeLabel(host.repos, scope.session?.worktreePath ?? terminalCwd(host)),
      icon: 'terminal' as const,
      shortcut: actionKeys(NEW_TAB_ACTIONS[agent.id] ?? '') || undefined,
      run: () => newSession(host, agent.id)
    })),
    ...(host.service('chat') && chatAgent()
      ? [
          {
            id: 'chat:new',
            group: 'Actions',
            label: 'New chat',
            detail: worktreeLabel(host.repos, scope.session?.worktreePath ?? terminalCwd(host)),
            icon: 'comment' as const,
            shortcut: actionKeys('terminal.newChat') || undefined,
            run: () => newChat(host)
          }
        ]
      : []),
    // @ in the palette searches these
    ...scope.sessions.map((session) => ({
      id: `session-open:${session.id}`,
      group: 'Sessions',
      label: session.title,
      detail: worktreeLabel(host.repos, session.worktreePath),
      icon: session.view === 'chat' ? ('comment' as const) : ('terminal' as const),
      run: () => reveal(host, session.id)
    }))
  ],
  shortcuts: SHORTCUTS,
  services: {
    sessions: {
      subscribe: subscribeTerminals,
      getSessions: sessionSummaries,
      getPorts,
      start: createSession,
      whenReady,
      sendText,
      runCommand: (cwd, command) => createSession(cwd, 'shell', command),
      active: () => activeSession()?.id ?? null,
      reveal: (id) => {
        revealSession(id)
        setTimeout(() => focusSession(id), 50)
      },
      close: killSession,
      showFile: (root, path) => setPreview({ root, path, line: null })
    }
  },
  toolMarks: {
    claude: () => <KindBadge kind="claude" />,
    codex: () => <KindBadge kind="codex" />
  }
}

export default plugin
