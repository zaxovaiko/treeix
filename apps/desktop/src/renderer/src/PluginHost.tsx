import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { type DocumentTab, HostContext, type HostApi, ISLAND } from '@treeix/sdk'
import { matchesAction, withKeys } from '../../shared/keymap'
import type { Repo } from '../../shared/types'
import './actions'
import { addComment, Changes, clearComments, deleteComment, HostFileView, SendComments, updateComment, useComments } from './Changes'
import type { Navigate } from './codeNavigation'
import { CommentsPanel } from './Comments'
import { ErrorBoundary } from './ErrorBoundary'
import { FileView } from './FileView'
import { FileIcon, Icon } from './Icon'
import { baseName } from './Sidebar'
import { IconButton, ResizeHandle, usePersisted } from './ui'
import { findService, usePlugins } from './plugins'
import { useSettings } from './settings'
import { isPageId, showSettingsPage } from './settingsNav'
import { useWorkspaces } from './workspaces'

export const TERMINAL = 'terminal'
/** The open chat's folder against HEAD, in the right panel */
export const CHANGES = 'changes'
const noop = (): void => undefined
// Pulls shiki's shared highlighter for result lines
const SearchDialog = lazy(() => import('./LocationBrowser').then((module) => ({ default: module.SearchDialog })))

/** What the right panel shows: the terminal, a plugin's page by its tab id, or a tab a plugin opened, like a pull request */
export type Side = string | DocumentTab

/**
 * Enough of the old shell's host for plugins to run in the Bots shell: their background Roots mount, and the terminal,
 * plugin pages, the folder's changes, files and the tabs plugins open dock on the right. Comments on code go to the
 * open chat's composer
 */

const FLASH_MS = 3000
export function PluginHost({
  page,
  folder,
  side,
  onSide,
  send,
  search,
  onSearch,
  onSettings,
  lead,
  children
}: {
  page: string
  /** The open chat's folder, which pages like Schema read */
  folder: string
  side: Side | null
  onSide: (side: Side | null) => void
  /** Puts text in the open chat's composer; null with no chat to take it */
  send: ((prompt: string) => void) | null
  /** The ⇧⌘F search over the folder, or every worktree of its repo */
  search: boolean
  onSearch: (open: boolean) => void
  /** Shows Settings, on the page asked for once it is up */
  onSettings: () => void
  /** Room for the collapsed sidebar's corner over the panel while it fills the window */
  lead: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  const { loaded: plugins } = usePlugins()
  const { currentId } = useWorkspaces()
  const island = useSettings().islandUi
  const [sideWidth, setSideWidth] = usePersisted<number>('bots.terminalWidth', 440)
  const terminalShown = side === TERMINAL
  // The panel in the page's place, kept only while one is open
  const [filled, setFilled] = useState(false)
  if (filled && !side) setFilled(false)
  const onTerminal = (shown: boolean): void => (shown ? show(TERMINAL) : terminalShown ? show(null) : undefined)
  const comments = useComments()
  // The panels shown before and after this one, like a browser's, so a jump to a definition can come back
  const [back, setBack] = useState<Side[]>([])
  const [forward, setForward] = useState<Side[]>([])
  const show = (next: Side | null): void => {
    if (!next) {
      setBack([])
      setForward([])
    } else if (side && sideKey(side) !== sideKey(next)) {
      setBack([...back, side])
      setForward([])
    }
    onSide(next)
  }
  const goBack = (): void => {
    if (!side || !back.length) return
    setForward([side, ...forward])
    setBack(back.slice(0, -1))
    onSide(back[back.length - 1])
  }
  const goForward = (): void => {
    if (!side || !forward.length) return
    setBack([...back, side])
    setForward(forward.slice(1))
    onSide(forward[0])
  }
  const [repos, setRepos] = useState<Repo[] | null>(null)
  // ponytail: one disk scan per app run, on the first search; rescan if new worktrees must show up mid-run
  useEffect(() => void (search && !repos && window.api.scan().then(setRepos, () => setRepos([]))), [search, repos])
  const worktrees = repos?.find((repo) => repo.worktrees.some((worktree) => worktree.path === folder))?.worktrees.map((worktree) => worktree.path) ?? [folder]
  // ponytail: opens the first location; a pick list (the old shell's LocationsDialog) if several matter
  const navigate: Navigate = (kind, target, worktreePath) =>
    void window.api
      .navigate(worktreePath, kind, target)
      .catch(() => [])
      .then(([first]) => first && openFile(worktreePath, first.path, first.line))
  const fileView = (worktreePath: string, path: string, line: number | null): React.JSX.Element => (
    <HostFileView worktreePath={worktreePath} path={path} line={line} onNavigate={navigate} />
  )
  const openFile = (worktreePath: string, path: string, line: number | null): void =>
    show({ key: `file:${worktreePath}:${path}`, title: baseName(path), icon: <FileIcon path={path} />, parent: page, content: fileView(worktreePath, path, line) })
  // A plugin's short note, like "No room to split right", held for a few seconds
  const [flashed, setFlashed] = useState<{ message: string; at: number } | null>(null)
  useEffect(() => {
    if (!flashed) return
    const timer = setTimeout(() => setFlashed(null), FLASH_MS)
    return () => clearTimeout(timer)
  }, [flashed])
  const host = useMemo(
    (): HostApi => ({
      repos: null,
      workspaceId: currentId,
      scopeRepoPaths: [folder],
      scopeLabel: '',
      selectedWorktree: folder,
      selectedWorktreeLabel: null,
      explorerRoot: window.api.home,
      browsedFolder: null,
      setBrowsedFolder: noop,
      defaultCwd: folder,
      diffStyle: 'unified',
      activeTab: page,
      keyboardPage: page,
      activePage: page,
      setActiveTab: (id) => id === TERMINAL && onTerminal(true),
      openTab: show,
      closeTab: (key) => typeof side === 'object' && side?.key === key && show(null),
      openLink: (url) => void window.open(url),
      openWorktree: noop,
      createWorktree: async () => undefined,
      openSettings: (page) => {
        onSettings()
        if (page && isPageId(page)) showSettingsPage(page)
      },
      flash: (message) => setFlashed({ message, at: Date.now() }),
      comments,
      addComment,
      deleteComment,
      clearComments,
      renderSendButton: (worktreePath) => <SendComments worktreePath={worktreePath} send={send} />,
      renderCommentsPanel: (worktreePath, open) => (
        <CommentsPanel
          comments={comments.filter((comment) => comment.worktreePath === worktreePath)}
          footer={<SendComments worktreePath={worktreePath} send={send} />}
          onClear={() => clearComments(worktreePath)}
          onOpen={(comment) => open(comment.filePath)}
          onDelete={deleteComment}
          onUpdate={updateComment}
        />
      ),
      renderFileView: fileView,
      renderExplorer: () => null,
      registerFileOpener: () => noop,
      withDock: (content) => content,
      showPanel: (id) => id === TERMINAL && onTerminal(true),
      hidePanel: (id) => id === TERMINAL && onTerminal(false),
      isPanelVisible: (id) => id === TERMINAL && terminalShown,
      movePanel: noop,
      panelFilled: filled,
      fillPanel: setFilled,
      isEnabled: (pluginId) => plugins.some(({ manifest }) => manifest.id === pluginId),
      service: findService,
      onSent: () => onTerminal(true)
    }),
    [currentId, page, folder, side, back, plugins, comments, send, filled]
  )
  // Plugins' keys (the terminal's ⌘T, ⌘D, ⌘[ and more) and ⌘W, which closes the focused terminal's session, else the panel
  const keys = {
    host,
    plugins,
    onSearch,
    goBack,
    goForward,
    toggleTerminal: () => onTerminal(!terminalShown),
    toggleFill: () => side !== null && setFilled(!filled),
    closeSide: () => side !== null && show(null)
  }
  const latest = useRef(keys)
  latest.current = keys
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const { host, plugins } = latest.current
      const run = matchesAction(event, 'app.search')
        ? () => latest.current.onSearch(true)
        : matchesAction(event, 'panel.terminal')
          ? latest.current.toggleTerminal
          : matchesAction(event, 'app.back')
            ? latest.current.goBack
            : matchesAction(event, 'app.forward')
              ? latest.current.goForward
              : matchesAction(event, 'panel.fill')
                ? latest.current.toggleFill
                : null
      if (run && !event.defaultPrevented) {
        event.preventDefault()
        run()
        return
      }
      if (!event.defaultPrevented && plugins.some(({ plugin }) => plugin.onKeyDown?.(event, host))) event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    const offClose = window.api.onCloseShortcut(() => latest.current.plugins.some(({ plugin }) => plugin.onCloseShortcut?.(latest.current.host)) || latest.current.closeSide())
    return () => {
      window.removeEventListener('keydown', onKey)
      offClose()
    }
  }, [])
  const pageNav = { onClose: () => show(null), onBack: back.length ? goBack : null, onForward: forward.length ? goForward : null, filled, onFill: setFilled }
  const Terminal = plugins.flatMap(({ plugin }) => plugin.panels ?? []).find((panel) => panel.id === TERMINAL)?.render
  const tab = typeof side === 'string' ? plugins.flatMap(({ plugin }) => plugin.tabs ?? []).find((candidate) => candidate.id === side) : undefined
  const content =
    side === TERMINAL ? (
      Terminal && <Terminal side="right" />
    ) : side === CHANGES ? (
      <SidePage title="Changes" icon={<Icon name="compare" className="size-3.5" />} {...pageNav}>
        <Changes folder={folder} send={send} onOpen={(path, line) => openFile(folder, path, line)} />
      </SidePage>
    ) : tab ? (
      <SidePage title={tab.label} icon={<Icon name={tab.icon} className="size-3.5" />} {...pageNav}>
        <tab.render />
      </SidePage>
    ) : side && typeof side === 'object' ? (
      <SidePage title={side.title} icon={side.icon} {...pageNav}>
        {side.content}
      </SidePage>
    ) : null
  return (
    <HostContext.Provider value={host}>
      <div className={`flex min-h-0 min-w-0 flex-1 ${island ? 'gap-2 py-2 pr-2' : ''}`}>
        {/* Hidden rather than unmounted while the panel fills the window, so the chat keeps its scroll and draft */}
        <div className={filled ? 'hidden' : 'contents'}>{children}</div>
        {content && (
          // Shrinks before the content does when the window gets narrow
          <aside
            style={filled ? undefined : { width: sideWidth }}
            className={`relative flex min-w-[240px] flex-col ${filled ? 'flex-1' : ''} ${island ? ISLAND : 'border-l border-border'}`}
          >
            {filled ? lead : <ResizeHandle edge="left" onResize={setSideWidth} />}
            <ErrorBoundary
              label={tab?.label ?? (typeof side === 'object' ? side?.title : side === CHANGES ? 'Changes' : undefined) ?? 'Terminal'}
              resetKey={typeof side === 'object' ? side?.key : (side ?? '')}
            >
              {/* Clips the content to the island's rounded corners, leaving the resize handle outside */}
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[inherit]">{content}</div>
            </ErrorBoundary>
          </aside>
        )}
      </div>
      {plugins.map(({ manifest, plugin }) =>
        plugin.Root ? (
          <ErrorBoundary key={manifest.id} label={manifest.name} resetKey={manifest.id}>
            <plugin.Root />
          </ErrorBoundary>
        ) : null
      )}
      {flashed && (
        <div
          role="status"
          className="pointer-events-none fixed bottom-6 left-1/2 z-50 max-w-md -translate-x-1/2 rounded-lg bg-popover px-3 py-1.5 text-xs text-popover-foreground shadow-lg ring-1 ring-border"
        >
          {flashed.message}
        </div>
      )}
      <Suspense fallback={null}>
        {search && (
          <SearchDialog
            worktreePaths={[folder]}
            allWorktreePaths={worktrees}
            activeWorktree={folder}
            scopeLabel={baseName(folder)}
            renderPreview={(location) => (
              <FileView worktreePath={location.worktreePath} path={location.path} line={location.line} comments={[]} onNavigate={noop} onAddComment={noop} onDeleteComment={noop} />
            )}
            onClose={() => onSearch(false)}
            onPick={(location) => {
              onSearch(false)
              openFile(location.worktreePath, location.path, location.line)
            }}
          />
        )}
      </Suspense>
    </HostContext.Provider>
  )
}

const sideKey = (side: Side): string => (typeof side === 'string' ? side : side.key)

function SidePage({
  title,
  icon,
  onClose,
  onBack,
  onForward,
  filled,
  onFill,
  children
}: {
  title: string
  icon: React.ReactNode
  onClose: () => void
  onBack: (() => void) | null
  onForward: (() => void) | null
  filled: boolean
  onFill: (fill: boolean) => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <>
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border pr-2 pl-3 text-xs">
        {(onBack || onForward) && (
          <span className="-ml-1 flex shrink-0">
            <IconButton label={withKeys('Back', 'app.back')} disabled={!onBack} onClick={() => onBack?.()}>
              <Icon name="arrowLeft" className="size-3.5" />
            </IconButton>
            <IconButton label={withKeys('Forward', 'app.forward')} disabled={!onForward} onClick={() => onForward?.()}>
              <Icon name="arrowRight" className="size-3.5" />
            </IconButton>
          </span>
        )}
        <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">{icon}</span>
        <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
        <IconButton label={withKeys(filled ? 'Bring the chat back' : 'Fill the window', 'panel.fill')} active={filled} onClick={() => onFill(!filled)}>
          <Icon name={filled ? 'minimize' : 'maximize'} className="size-3.5" />
        </IconButton>
        <IconButton label="Close panel (⌘W)" onClick={onClose}>
          <Icon name="close" className="size-3" />
        </IconButton>
      </header>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </>
  )
}

/** A page a plugin contributes, like the hub's Configure, or null while that plugin is off or loading */
export function PluginPage({ id }: { id: string }): React.JSX.Element | null {
  const { loaded: plugins } = usePlugins()
  const Page = plugins.flatMap(({ plugin }) => plugin.tabs ?? []).find((tab) => tab.id === id)?.render
  return Page ? <Page /> : null
}
