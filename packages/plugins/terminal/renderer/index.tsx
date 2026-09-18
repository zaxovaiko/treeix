import { lazy, Suspense, useEffect } from 'react'
import { definePluginSettings, type HostApi, type RendererPlugin, SESSION_KINDS, type SessionKind, type SessionSummary, useHost } from '@treeix/sdk'
import { FileIcon, Icon } from '@treeix/app/Icon'
import { KindBadge } from '@treeix/app/sessionUi'
import { digitPressed, getSettings } from '@treeix/app/settings'
import { IconButton, ResizeHandle, usePersisted } from '@treeix/app/ui'
import { inWorkspace, useWorkspaces } from '@treeix/app/workspaces'
import { SessionsDialog } from './SessionsDialog'
import {
  closeActivePane,
  createSession,
  focusNeighbor,
  focusPaneAt,
  focusSession,
  getTerminals,
  isTerminalFocused,
  type Session,
  sendText,
  showPane,
  splitPane,
  subscribeTerminals,
  toggleZoom,
  useTerminals,
  whenReady
} from './terminals'

const TerminalPanel = lazy(() => import('./TerminalPanel').then((module) => ({ default: module.TerminalPanel })))

const TAB_ID = 'terminal'

const view = definePluginSettings('terminal', (stored) => ({
  explorerOpen: stored.explorerOpen !== false,
  preview: null as { path: string; line: number | null } | null
}))

/** Whether the ⌘⇧J session switcher is open */
const dialog = definePluginSettings('terminal-dialog', () => ({ open: false }))

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

/** Sessions of the current workspace */
function useWorkspaceSessions(): Session[] {
  const { repos } = useHost()
  const { workspaces, currentId } = useWorkspaces()
  const workspace = workspaces.find((candidate) => candidate.id === currentId)
  return useTerminals().sessions.filter((session) => inWorkspace(session, workspace, repos, workspaces))
}

function useIncludeSession(): (session: Session) => boolean {
  const { repos } = useHost()
  const { workspaces, currentId } = useWorkspaces()
  const workspace = workspaces.find((candidate) => candidate.id === currentId)
  return (session) => inWorkspace(session, workspace, repos, workspaces)
}

const WaitingDot = ({ className }: { className: string }): React.JSX.Element | null => {
  const waiting = useWorkspaceSessions().filter((session) => session.status === 'input').length
  return waiting > 0 ? <span title={`${waiting} waiting for input`} className={`rounded-full bg-amber-400 ${className}`} /> : null
}

function TerminalTab(): React.JSX.Element {
  const host = useHost()
  const includeSession = useIncludeSession()
  const { explorerOpen, preview } = view.use()
  const [explorerWidth, setExplorerWidth] = usePersisted<number>('terminalTab.explorerWidth', 260)
  const [previewWidth, setPreviewWidth] = usePersisted<number>('terminalTab.previewWidth', 560)
  const open = (path: string, line: number | null = null): void => view.update({ preview: { path, line } })
  useEffect(() => host.registerFileOpener(TAB_ID, open), [])

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-card">
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <Suspense fallback={null}>
            <TerminalPanel repos={host.repos} worktreePath={host.defaultCwd} orientation="horizontal" includeSession={includeSession} />
          </Suspense>
        </div>
        {host.selectedWorktree && preview && (
          <aside style={{ width: previewWidth }} className="relative flex shrink-0 flex-col border-l border-border bg-background">
            <ResizeHandle edge="left" width={previewWidth} min={320} max={1100} onResize={setPreviewWidth} />
            <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border pr-1.5 pl-3">
              <FileIcon path={preview.path} />
              <span className="min-w-0 truncate font-mono text-xs text-foreground/85 select-text" title={preview.path}>
                {preview.path}
                {preview.line && <span className="text-muted-foreground">:{preview.line}</span>}
              </span>
              <span className="flex-1" />
              <IconButton label="Close preview" onClick={() => view.update({ preview: null })}>
                <Icon name="close" className="size-3" />
              </IconButton>
            </div>
            {host.renderFileView(host.selectedWorktree, preview.path, preview.line)}
          </aside>
        )}
        {explorerOpen && (
          <aside style={{ width: explorerWidth }} className="relative flex shrink-0 flex-col border-l border-border">
            <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border pr-1.5 pl-3">
              <span className="truncate text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{host.selectedWorktreeLabel ?? 'Files'}</span>
            </div>
            <div className="min-h-0 flex-1">{host.renderExplorer(preview?.path ?? null, (path) => open(path))}</div>
            <ResizeHandle edge="left" width={explorerWidth} min={180} max={520} onResize={setExplorerWidth} />
          </aside>
        )}
      </div>
    </div>
  )
}

function DockedTerminal({ side }: { side: 'left' | 'right' | 'bottom' }): React.JSX.Element {
  const host = useHost()
  const includeSession = useIncludeSession()
  return <TerminalPanel repos={host.repos} worktreePath={host.defaultCwd} orientation={side === 'bottom' ? 'horizontal' : 'vertical'} includeSession={includeSession} />
}

function SessionsButton(): React.JSX.Element {
  const sessions = useWorkspaceSessions()
  const waiting = sessions.filter((session) => session.status === 'input').length
  return (
    <button
      title={`Sessions${waiting ? ` · ${waiting} waiting for input` : ''} (⌘⇧J)`}
      onClick={() => dialog.update({ open: true })}
      className="flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground [-webkit-app-region:no-drag]"
    >
      <Icon name="terminal" className="size-3.5" />
      <span className="tabular-nums">{sessions.length}</span>
      {waiting > 0 && <span className="size-1.5 animate-pulse rounded-full bg-amber-400" />}
      <kbd className="font-sans text-[10.5px] text-muted-foreground/70">⌘⇧J</kbd>
    </button>
  )
}

function FilesToggle(): React.JSX.Element | null {
  const { activeTab } = useHost()
  const { explorerOpen } = view.use()
  if (activeTab !== TAB_ID) return null
  return (
    <IconButton label="Toggle files (⌘P)" active={explorerOpen} onClick={() => view.update({ explorerOpen: !explorerOpen })}>
      <Icon name="folder" />
    </IconButton>
  )
}

/** Shows the terminal: the tab when it is open or no dock applies, else the docked panel */
function reveal(host: HostApi, id: string): void {
  showPane(id)
  if (host.activeTab === 'worktrees') {
    if (!host.isPanelVisible(TAB_ID)) host.showPanel(TAB_ID)
  } else if (host.activeTab !== TAB_ID) host.setActiveTab(TAB_ID)
  setTimeout(() => focusSession(id), 50)
}

function Root(): React.JSX.Element | null {
  const host = useHost()
  const { open } = dialog.use()
  const sessions = useWorkspaceSessions()
  // An empty terminal panel is just a gap: close it once the last session in this workspace is gone
  useEffect(() => {
    if (sessions.length === 0 && host.isPanelVisible(TAB_ID)) host.hidePanel(TAB_ID)
  }, [sessions.length === 0])
  if (!open) return null
  return (
    <SessionsDialog
      sessions={sessions}
      repos={host.repos}
      cwd={host.defaultCwd}
      onClose={() => dialog.update({ open: false })}
      onNew={(kind) => startIn(host, kind)}
      onPick={(session) => reveal(host, session.id)}
    />
  )
}

function startIn(host: HostApi, kind: SessionKind, cwd = host.defaultCwd): void {
  void createSession(cwd, kind)
  if (host.activeTab !== TAB_ID && !host.isPanelVisible(TAB_ID)) host.showPanel(TAB_ID)
}

const ARROWS: Record<string, 'left' | 'right' | 'top' | 'bottom'> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'top', ArrowDown: 'bottom' }

function onKeyDown(event: KeyboardEvent, host: HostApi): boolean {
  if (event.metaKey && event.shiftKey && event.code === 'KeyJ') {
    dialog.update({ open: !dialog.get().open })
    return true
  }
  if (event.metaKey && !event.shiftKey && !event.altKey && event.key === 'p' && host.activeTab === TAB_ID) {
    view.update({ explorerOpen: !view.get().explorerOpen })
    return true
  }
  const paneDigit = digitPressed(event, getSettings().digitShortcuts.panes)
  if (paneDigit) {
    if (!focusPaneAt(paneDigit)) {
      host.setActiveTab(TAB_ID)
      setTimeout(() => focusPaneAt(paneDigit), 50)
    }
    return true
  }
  if (!event.metaKey || event.ctrlKey) return false
  const terminalShown = host.activeTab === TAB_ID || host.isPanelVisible(TAB_ID)
  // ⌘N and ⌥⌘T start a shell session, ⇧⌘T a Claude one
  if (event.code === 'KeyN' && !event.altKey && !event.shiftKey) {
    startIn(host, 'shell')
    return true
  }
  // ⌘T opens the tab
  if (event.code === 'KeyT' && !event.altKey && !event.shiftKey) {
    host.setActiveTab(TAB_ID)
    return true
  }
  if (event.code === 'KeyT' && (event.altKey || event.shiftKey)) {
    startIn(host, event.shiftKey ? 'claude' : 'shell')
    return true
  }
  if (event.code === 'KeyD' && !event.altKey && terminalShown) {
    if (host.activeTab !== TAB_ID && !host.isPanelVisible(TAB_ID)) host.showPanel(TAB_ID)
    void splitPane(event.shiftKey ? 'bottom' : 'right', host.defaultCwd)
    return true
  }
  if (event.altKey && !event.shiftKey && ARROWS[event.code] && isTerminalFocused()) {
    focusNeighbor(ARROWS[event.code])
    return true
  }
  if (event.shiftKey && !event.altKey && event.code === 'Enter' && isTerminalFocused()) {
    toggleZoom()
    return true
  }
  return false
}

const plugin: RendererPlugin = {
  tabs: [{ id: TAB_ID, label: 'Terminal', icon: 'terminal', order: 10, render: TerminalTab, Badge: () => <WaitingDot className="size-1.5" /> }],
  panels: [
    {
      id: TAB_ID,
      label: 'Terminal',
      icon: 'terminal',
      shortcut: '⌘J',
      render: DockedTerminal,
      Badge: () => <WaitingDot className="absolute top-1 right-1 size-1.5 ring-2 ring-background" />
    }
  ],
  Root,
  titleBar: [
    { order: 20, render: SessionsButton },
    { order: 90, render: FilesToggle }
  ],
  onKeyDown,
  onCloseShortcut: () => {
    if (!isTerminalFocused()) return false
    closeActivePane()
    return true
  },
  commands: (host) => [
    { id: 'sessions', group: 'Actions', label: 'Find session', icon: 'terminal', shortcut: '⌘⇧J', run: () => dialog.update({ open: true }) },
    ...(Object.keys(SESSION_KINDS) as SessionKind[]).map((kind) => ({
      id: `session:${kind}`,
      group: 'Actions',
      label: `New ${SESSION_KINDS[kind].label} session`,
      detail: host.selectedWorktreeLabel ?? '~ home',
      icon: 'terminal' as const,
      run: () => startIn(host, kind)
    }))
  ],
  services: {
    sessions: {
      subscribe: subscribeTerminals,
      getSessions: sessionSummaries,
      start: createSession,
      whenReady,
      sendText,
      runCommand: (cwd, command) => createSession(cwd, 'shell', command),
      reveal: (id) => {
        showPane(id)
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

