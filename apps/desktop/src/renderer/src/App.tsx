import { type DiffLineAnnotation, PatchDiff } from '@pierre/diffs/react'
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  type Attachment,
  extractLines,
  commentsPrompt as promptForComments,
  isReviewComment,
  type LineRange,
  type PatchRow,
  patchRows,
  rangeLabel,
  type ReviewComment
} from '../../shared/comments'
import { DockSlot, type DocumentTab, focusZone, getShell, HostContext, type HostApi, isPageKey, isTyping, Kbd, KeyHintLabel, PageLayout, pageHasPanel, type PanelName, runShellCommand, type SessionKind, togglePanel, toggleZen, updateShell, useModifierHints, usePanels, useShell, Zone, zoneBack } from '@treeix/sdk'
import { getAgents, isAgent } from './agents'
import { BranchDialog, type NewBranchRequest } from './BranchDialog'
import { HistoryDialog } from './HistoryDialog'
import type { Branch, CodeLocation, FilePatch, SearchMatch, Repo, Worktree, WorktreeFiles } from '../../shared/types'
import { allFolders, ChangedFileList, folderPaths } from './ChangedFiles'
import { copyText, type MenuEntry, openMenu } from './contextMenu'
import type { Command } from './CommandPalette'
import { AgentCommentsDrawer, CommentCard, CommentDraft, CommentsPanel, orderRange, useCodeDrag } from './Comments'
import { type DockSide, DropZones, type PanelId, type PanelInfo, PanelToggle, SIZE_LIMITS, useLayout } from './Dock'
import { ErrorBoundary } from './ErrorBoundary'
import { MarkdownFoldScope } from './LazyMarkdown'
import { isMarkdownPath, MarkdownPreview, PreviewToggle, useMarkdownPreview } from './MarkdownPreview'
import { emptyHistory, recordPlace, stepPlace } from './navigationHistory'
import { Explorer, FolderExplorer } from './Explorer'
import { matcherFor } from './searchMatcher'
import { CodeNavigationContext, getActiveTarget, type Navigate, navigationKindForKey, useSymbolNavigation } from './codeNavigation'
import { codeThemeOptions, diffBackground, FileView, findLineElement } from './FileView'
import { FileIcon, Icon } from './Icon'
import { findService, usePlugins, useSessions } from './plugins'
import { SendButton } from './SendButton'
import { LEADER_PAGES, leaderOf, ShortcutSheet, StatusBar, useShellKeys, WhichKey } from './Shell'
import { isPageId, showSettingsPage } from './settingsNav'
import { WorkspaceDialog, WorkspaceRail } from './WorkspaceRail'
import { addRepoToWorkspace, commonFolder, getCurrentWorkspaceId, workspaceKey, inWorkspace, recentWorkspaces, reposOf, saveWorkspace, setCurrentWorkspace, useWorkspaces, type Workspace } from './workspaces'
import { baseName, branchLabel, reposInScope, type RepoScope, Sidebar, ZoneHeader } from './Sidebar'
import { menuActions, registerActionRunner, runAction, subscribeRunners } from './actionRunners'
import { inlineByDefault, refreshToolStatus } from './toolStatus'
import { actionForEvent, actionKeys, matchesAction, onKeymapChange } from '../../shared/keymap'
import { WORKTREE_ACTIONS } from './actions'
import { digitLabel, digitPressed, groupOpen, type Settings, stepFontSize, updateSettings, useSettings } from './settings'
import { UpdateBanner } from './updates'

import { CopyButton, EmptyState, errorMessage, FoldAllButton, IconButton, readStored, ResizeHandle, TextPrompt, Tooltips, useChromeless, usePersisted } from './ui'

/** Document tabs a plugin opened (one pull request, one plan) don't survive a restart; plugin tab ids never contain a colon */
const isRestorableTab = (tab: string): boolean => tab !== 'settings' && !tab.includes(':')
/** Where Worktrees sits among the plugin tabs */
const WORKTREES_ORDER = 30

/** A browser comment's page, in the built-in browser when it's enabled */
function openPage(url: string): void {
  const browser = findService('browser')
  if (browser) browser.open(url)
  else window.open(url)
}

const isTerminalFocused = (): boolean => document.activeElement?.closest('[data-session-id]') != null
type SavedPlace = { appTab: string; selected: string | null; viewer: { path: string; line: number | null } | null }
/** Where a workspace was left: its tab, worktree and open file */
function readPlace(workspaceId: string): SavedPlace {
  const stored = readStored(workspaceKey('app.place', workspaceId))
  const record = typeof stored === 'object' && stored !== null ? (stored as Record<string, unknown>) : {}
  const viewer = typeof record.viewer === 'object' && record.viewer !== null ? (record.viewer as Record<string, unknown>) : null
  return {
    appTab: typeof record.appTab === 'string' && isRestorableTab(record.appTab) ? record.appTab : 'worktrees',
    selected: typeof record.selected === 'string' ? record.selected : null,
    viewer: viewer && typeof viewer.path === 'string' ? { path: viewer.path, line: typeof viewer.line === 'number' ? viewer.line : null } : null
  }
}
const SAVED_PLACE = readPlace(getCurrentWorkspaceId())

const BROWSED_FOLDERS_KEY = 'explorer.browsedFolders'
function readBrowsedFolders(): Record<string, string> {
  const stored = readStored(BROWSED_FOLDERS_KEY)
  if (typeof stored !== 'object' || stored === null) return {}
  return Object.fromEntries(Object.entries(stored).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

type Place = { appTab: string; selected: string | null; viewer: { path: string; line: number | null } | null; filePath: string | null }
const samePlace = (a: Place, b: Place): boolean =>
  a.appTab === b.appTab && a.selected === b.selected && a.filePath === b.filePath && a.viewer?.path === b.viewer?.path && a.viewer?.line === b.viewer?.line
const PLACE_SETTLE_MS = 400

/** The numpad twins of the font size keys, which the recorded shortcuts don't cover */
const NUMPAD_FONT_STEPS = new Map<string, -1 | 0 | 1>([
  ['NumpadEqual', 1],
  ['NumpadAdd', 1],
  ['NumpadSubtract', -1],
  ['Numpad0', 0]
])

// Dialogs and settings load on first use; plugin code loads with its plugin
const CommandPalette = lazy(() => import('./CommandPalette').then((module) => ({ default: module.CommandPalette })))
const SettingsView = lazy(() => import('./SettingsView').then((module) => ({ default: module.SettingsView })))
// Pulls shiki's shared highlighter for result lines
const SearchDialog = lazy(() => import('./LocationBrowser').then((module) => ({ default: module.SearchDialog })))
const LocationsDialog = lazy(() => import('./LocationBrowser').then((module) => ({ default: module.LocationsDialog })))

const COMMENTS_KEY = 'comments'
const RESIZE_EDGE: Record<DockSide, 'left' | 'right' | 'top'> = { left: 'right', right: 'left', bottom: 'top' }

const SCAN_KEY = 'scan.cache'

const isRepoList = (value: unknown): value is Repo[] =>
  Array.isArray(value) &&
  value.every(
    (repo) => typeof repo === 'object' && repo !== null && typeof repo.path === 'string' && Array.isArray(repo.worktrees)
  )

/** Last scan, so the sidebar paints instantly while a fresh scan walks the disk */
function loadScanCache(): Repo[] | null {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(SCAN_KEY) ?? 'null')
    return isRepoList(stored) ? stored : null
  } catch {
    return null
  }
}

type WorktreeData = { patches: FilePatch[]; files: WorktreeFiles }
// ponytail: least recently loaded worktrees drop out past the cap and load from git again
const WORKTREE_CACHE_MAX = 20
const worktreeCache = new Map<string, WorktreeData>()
// Focus fires on every switch back to the app; agents' edits can wait a few seconds
const FOCUS_REFRESH_MS = 10_000

const sameList = (a: string[], b: string[]): boolean => a.length === b.length && a.every((item, index) => item === b[index])
const samePatches = (a: FilePatch[], b: FilePatch[]): boolean =>
  a.length === b.length && a.every((patch, index) => patch.path === b[index].path && patch.patch === b[index].patch)
const sameFiles = (a: WorktreeFiles, b: WorktreeFiles): boolean => sameList(a.files, b.files) && sameList(a.ignored, b.ignored)

function loadComments(): ReviewComment[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(COMMENTS_KEY) ?? '[]')
    return Array.isArray(stored) ? stored.filter(isReviewComment) : []
  } catch {
    return []
  }
}

const annotationSide = (range: LineRange): 'deletions' | 'additions' => range.endSide ?? range.side ?? 'additions'
/** The one-line range of a patch row, on the side it shows */
const rowRange = (row: PatchRow): LineRange =>
  row.new !== null ? { start: row.new, end: row.new, side: 'additions' } : { start: row.old ?? 1, end: row.old ?? 1, side: 'deletions' }

function Placeholder({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <EmptyState title={children} />
}

/**
 * A tab's docked panels: around the whole tab when the bottom panel spans the window. Beside the list, a PageLayout inside
 * docks them around its main zone; a tab without one still gets them around all of it
 */
function TabDock({
  placement,
  withDock,
  children
}: {
  placement: Settings['bottomPanel']
  withDock: (content: React.ReactNode, frames: boolean) => React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  const [claims, setClaims] = useState(0)
  // Children claim in their layout effects, which run before this one, so the first paint already knows
  const [settled, setSettled] = useState(false)
  useLayoutEffect(() => setSettled(true), [])
  const claim = useCallback(() => {
    setClaims((count) => count + 1)
    return () => setClaims((count) => count - 1)
  }, [])
  if (placement === 'full') return <>{withDock(children, true)}</>
  return <>{withDock(<DockSlot.Provider value={claim}>{children}</DockSlot.Provider>, settled && claims === 0)}</>
}

function App(): React.JSX.Element {
  const [repos, setRepos] = useState<Repo[] | null>(loadScanCache)
  const [scanning, setScanning] = useState(false)
  const [selected, setSelected] = useState<string | null>(() => SAVED_PLACE.selected)
  const [patches, setPatches] = useState<FilePatch[] | null>(null)
  const [filePath, setFilePath] = useState<string | null>(null)
  const [filesOpen, setFilesOpen] = usePersisted<boolean>('files.open', true)
  const [filesWidth, setFilesWidth] = usePersisted<number>('files.width', 260)
  const [allComments, setAllComments] = useState<ReviewComment[]>(loadComments)
  const [draft, setDraft] = useState<LineRange | null>(null)
  const [worktreeFiles, setWorktreeFiles] = useState<WorktreeFiles | null>(null)
  /** A folder the explorer shows instead of the selected worktree, picked by the user */
  /** Folders the explorer shows instead of the selected worktree, one per workspace */
  const [browsedFolders, setBrowsedFolders] = useState<Record<string, string>>(readBrowsedFolders)
  const [viewer, setViewer] = useState<{ path: string; line: number | null } | null>(null)
  /** Files opened in the worktree view, shown as editor tabs; the viewer is the active one */
  const [editorTabs, setEditorTabs] = useState<string[]>([])
  const [historyFor, setHistoryFor] = useState<{ worktreePath: string; path: string } | null>(null)
  /** Bumped after restoring a version so open editors reload from disk */
  const [fileReload, setFileReload] = useState(0)
  const [markdownPreview, setMarkdownPreview] = useMarkdownPreview()
  const [peek, setPeek] = useState<{ title: string; symbol: string; locations: SearchMatch[] } | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  /** A viewer to show once switching worktrees has reset the view */
  // Seeded with the saved open file: selecting the saved worktree at startup would otherwise clear it
  const pendingViewer = useRef<{ path: string; line: number | null } | null>(SAVED_PLACE.viewer)
  /** A diff file to show once switching worktrees has reset the view, when going back to a place */
  const pendingFilePath = useRef<string | null>(null)
  const pendingTabs = useRef<string[] | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [updateDismissed, setUpdateDismissed] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const shell = useShell()
  const worktreePanels = usePanels('worktrees')
  const settings = useSettings()
  const { diffStyle } = settings
  const setDiffStyle = (style: 'split' | 'unified'): void => updateSettings({ diffStyle: style })
  const [appTab, setAppTab] = useState(SAVED_PLACE.appTab)
  // Reopen where the app was left: tab, worktree and file
  useEffect(() => {
    const place: SavedPlace = { appTab: isRestorableTab(appTab) ? appTab : 'worktrees', selected, viewer }
    localStorage.setItem(workspaceKey('app.place'), JSON.stringify(place))
  }, [appTab, selected, viewer])
  const tabBeforeSettings = useRef('worktrees')
  const openSettings = (page?: unknown): void => {
    // Menu and button handlers may pass their event, so only a page id counts
    if (typeof page === 'string' && isPageId(page)) showSettingsPage(page)
    if (appTab !== 'settings') tabBeforeSettings.current = appTab
    setAppTab('settings')
  }
  const closeSettings = (): void => setAppTab(tabBeforeSettings.current)
  const [docTabs, setDocTabs] = useState<DocumentTab[]>([])
  const { loaded: plugins, ready: pluginsReady } = usePlugins()
  const pluginTabs = plugins.flatMap(({ plugin }) => plugin.tabs ?? [])
  /** The title bar row: Worktrees sits among the plugin tabs, all in `order` */
  const tabs = [{ id: 'worktrees', label: 'Worktrees', icon: 'branch' as const, order: WORKTREES_ORDER }, ...pluginTabs].sort((a, b) => a.order - b.order)
  const pluginPanels = plugins.flatMap(({ plugin }) => plugin.panels ?? [])
  const panelInfo = (id: PanelId): PanelInfo | undefined => pluginPanels.find((panel) => panel.id === id)
  const panelIds = pluginPanels.map((panel) => panel.id)
  /** Views that open files themselves while their tab is active, like the terminal tab's preview */
  const fileOpeners = useRef(new Map<string, (path: string, line: number | null) => void>())
  const [draggingPanel, setDraggingPanel] = useState<PanelId | null>(null)
  // React flushes dragstart updates synchronously; mounting drop zones inside the handler makes Chromium cancel the drag
  const startPanelDrag = (panel: PanelId): void => void setTimeout(() => setDraggingPanel(panel))
  const [scopeFolder, setScopeFolder] = usePersisted<string>('sidebar.folder', '')
  const [scopeFocus, setScopeFocus] = usePersisted<string>('sidebar.focus', '')
  const drag = useCodeDrag(setDraft)
  const dock = useLayout(panelIds)
  const allSessions = useSessions()
  const workspacesState = useWorkspaces()
  const { workspaces, currentId: workspaceId } = workspacesState
  const browseRoot = browsedFolders[workspaceId] || null
  const setBrowsedFolder = (path: string | null): void => {
    const next = { ...browsedFolders, [workspaceId]: path ?? '' }
    localStorage.setItem(BROWSED_FOLDERS_KEY, JSON.stringify(next))
    setBrowsedFolders(next)
  }
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId)
  const workspaceRepos = repos ? reposOf(workspace, repos) : null
  // A workspace replaces the folder filter; focus only applies to a project inside it
  const scope: RepoScope = {
    folder: workspace ? '' : scopeFolder,
    focus: !workspace || workspace.repoPaths.includes(scopeFocus) ? scopeFocus : '',
    setFolder: setScopeFolder,
    setFocus: setScopeFocus
  }
  // New sessions start in the selected worktree, else the focused project, folder filter, the workspace's chosen project or the folder holding its projects
  const terminalPath = workspace?.terminalPath && workspace.repoPaths.includes(workspace.terminalPath) ? workspace.terminalPath : ''
  const defaultCwd = selected ?? (scope.focus || scope.folder || terminalPath || commonFolder(workspace?.repoPaths ?? []) || window.api.home)

  const inCurrentWorkspace = (session: { worktreePath: string; workspaceId: string }): boolean => inWorkspace(session, workspace, repos, workspaces)
  const sessions = allSessions.filter(inCurrentWorkspace)
  /** Each workspace keeps its own agent comments, even on a checkout two workspaces share */
  const inThisWorkspace = (comment: ReviewComment): boolean =>
    comment.workspaceId ? comment.workspaceId === workspaceId : inCurrentWorkspace({ worktreePath: comment.worktreePath, workspaceId: '' })
  // Memoized so the plugin host only changes when these do
  const comments = useMemo(() => allComments.filter(inThisWorkspace), [allComments, workspaceId, workspace, repos, workspaces])
  /** Replaces this workspace's comments and leaves the others alone; new comments are stamped with the workspace */
  const setComments = (next: ReviewComment[] | ((visible: ReviewComment[]) => ReviewComment[])): void =>
    setAllComments((current) => {
      const updated = typeof next === 'function' ? next(current.filter(inThisWorkspace)) : next
      return [...current.filter((comment) => !inThisWorkspace(comment)), ...updated.map((comment) => (comment.workspaceId ? comment : { ...comment, workspaceId }))]
    })
  const chromeless = useChromeless()
  const [editingWorkspace, setEditingWorkspace] = useState<Workspace | null | undefined>(undefined)
  type WorkspaceView = { selected: string | null; docTabs: DocumentTab[]; appTab: string; editorTabs: string[]; viewer: typeof viewer }
  const workspaceViews = useRef(new Map<string, WorkspaceView>())

  useEffect(() => localStorage.setItem(COMMENTS_KEY, JSON.stringify(allComments)), [allComments])

  const rescan = (): void => {
    setScanning(true)
    window.api
      .scan()
      .then((result) => {
        localStorage.setItem(SCAN_KEY, JSON.stringify(result))
        setRepos(result)
      })
      .finally(() => setScanning(false))
  }

  useEffect(rescan, [])

  const selectedRef = useRef(selected)
  selectedRef.current = selected

  /** Serve the cached diff at once, then refresh it: agents change files while you look */
  const loadWorktree = (worktreePath: string): void => {
    Promise.all([
      window.api.diff(worktreePath),
      window.api.listFiles(worktreePath).catch(() => ({ files: [], ignored: [] }))
    ]).then(([freshPatches, freshFiles]) => {
      // Autosave refreshes after every pause in typing; reuse unchanged data so diff and file tree don't re-render
      const cached = worktreeCache.get(worktreePath)
      const nextPatches = cached && samePatches(cached.patches, freshPatches) ? cached.patches : freshPatches
      const nextFiles = cached && sameFiles(cached.files, freshFiles) ? cached.files : freshFiles
      // Re-inserting keeps the Map in load order, oldest first
      worktreeCache.delete(worktreePath)
      worktreeCache.set(worktreePath, { patches: nextPatches, files: nextFiles })
      if (worktreeCache.size > WORKTREE_CACHE_MAX) worktreeCache.delete(worktreeCache.keys().next().value!)
      if (selectedRef.current !== worktreePath) return
      setPatches(nextPatches)
      setWorktreeFiles(nextFiles)
      setFilePath((current) =>
        current && nextPatches.some((patch) => patch.path === current) ? current : (nextPatches[0]?.path ?? null)
      )
    })
  }

  useEffect(() => {
    if (!selected) return
    const cached = worktreeCache.get(selected)
    setPatches(cached?.patches ?? null)
    setWorktreeFiles(cached?.files ?? null)
    setFilePath(pendingFilePath.current ?? cached?.patches[0]?.path ?? null)
    pendingFilePath.current = null
    setViewer(pendingViewer.current)
    setEditorTabs(pendingTabs.current ?? (pendingViewer.current ? [pendingViewer.current.path] : []))
    pendingViewer.current = null
    pendingTabs.current = null
    loadWorktree(selected)
  }, [selected])

  // ⌃- / ⌃⇧- walk back and forward through places visited, like VS Code's Go Back
  useEffect(() => {
    const cancelLeader = (): void => void (getShell().leader && updateShell({ leader: false }))
    window.addEventListener('mousedown', cancelLeader, true)
    return () => window.removeEventListener('mousedown', cancelLeader, true)
  }, [])

  const places = useRef(emptyHistory<Place>())
  /** Restoring a place settles over a few renders (worktree reset, cached diff); none of them are new places */
  const restoringUntil = useRef(0)
  useEffect(() => {
    if (Date.now() < restoringUntil.current) return
    places.current = recordPlace(places.current, { appTab, selected, viewer, filePath }, samePlace)
  }, [appTab, selected, viewer, filePath])

  const goToPlace = (delta: -1 | 1): void => {
    const step = stepPlace(places.current, delta)
    if (!step) return
    places.current = step.history
    restoringUntil.current = Date.now() + PLACE_SETTLE_MS
    const { place } = step
    setAppTab(place.appTab)
    if (place.selected !== selected) {
      pendingViewer.current = place.viewer
      pendingFilePath.current = place.filePath
      setSelected(place.selected)
    } else {
      setViewer(place.viewer)
      setFilePath(place.filePath)
    }
  }

  useEffect(() => {
    let refreshedAt = 0
    const refresh = (): void => {
      if (!selectedRef.current || Date.now() - refreshedAt < FOCUS_REFRESH_MS) return
      refreshedAt = Date.now()
      loadWorktree(selectedRef.current)
    }
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])

  const showDiff = (path: string): void => {
    setViewer(null)
    setFilePath(path)
  }

  const flash = (message: string): void => {
    setNotice(message)
    setTimeout(() => setNotice(null), 2500)
  }

  /** Opens files where the active tab shows them, otherwise in the worktree view */
  const openFile = (path: string, line: number | null): void => (fileOpeners.current.get(appTab) ?? ((next, nextLine) => setViewer({ path: next, line: nextLine })))(path, line)

  const TITLES = { definition: 'Definitions of', typeDefinition: 'Type definitions of', implementation: 'Implementations of', references: 'References to' }
  /** Opens a navigation result, switching to its worktree when it came from a PR or another checkout */
  const openLocation = (worktreePath: string, path: string, line: number | null): void => {
    setPeek(null)
    setSearchOpen(false)
    if (worktreePath === selected && (appTab === 'worktrees' || fileOpeners.current.has(appTab))) return openFile(path, line)
    setAppTab('worktrees')
    if (worktreePath === selected) return setViewer({ path, line })
    pendingViewer.current = { path, line }
    setSelected(worktreePath)
  }

  const navigate: Navigate = async (kind, target, worktreePath) => {
    if (!worktreePath) return
    // The first lookup builds the TypeScript program, which takes a few seconds in big repos
    const slow = setTimeout(() => flash(`Analyzing ${target.symbol}...`), 600)
    const locations = await window.api.navigate(worktreePath, kind, target).catch(() => [])
    clearTimeout(slow)
    // Asking for the definition while standing on it shows its usages instead, like VS Code
    const onItself = (location: CodeLocation): boolean => location.path === target.path && location.line === target.line
    if (kind === 'definition' && locations.length === 1 && onItself(locations[0])) return navigate('references', target, worktreePath)
    if (locations.length === 0) return flash(`No ${kind === 'references' ? 'references' : TITLES[kind].toLowerCase().replace(/ of$/, '')} found for ${target.symbol}`)
    if (kind !== 'references' && locations.length === 1) return openLocation(worktreePath, locations[0].path, locations[0].line)
    setPeek({ title: TITLES[kind], symbol: target.symbol, locations: locations.map((location) => ({ ...location, worktreePath })) })
  }

  /** `preview` is for result lists: read-only, no editor, far cheaper to mount while arrowing through results */
  const fileView = (worktreePath: string, path: string, line: number | null, preview = false): React.JSX.Element => (
    <FileView
      key={`${worktreePath}:${path}:${fileReload}`}
      onShowHistory={preview ? undefined : () => setHistoryFor({ worktreePath, path })}
      worktreePath={worktreePath}
      path={path}
      line={line}
      comments={comments.filter((comment) => comment.worktreePath === worktreePath && comment.kind === 'file' && comment.filePath === path)}
      onNavigate={navigate}
      onDeleteComment={deleteComment}
      onSaved={preview ? undefined : () => loadWorktree(worktreePath)}
      onAddComment={(range, code, text, attachments) =>
        setComments([...comments, { id: crypto.randomUUID(), worktreePath, filePath: path, range, code, text, attachments, kind: 'file' }])
      }
    />
  )

  const tabExists = (tab: string): boolean => tab === 'worktrees' || tab === 'settings' || pluginTabs.some((candidate) => candidate.id === tab) || docTabs.some((candidate) => candidate.key === tab)

  /** Shows a page with the keyboard in it: its list, or the terminal on the Terminal page */
  const goPage = (tab: string): void => {
    if (tab === 'settings') openSettings()
    else setAppTab(tab)
    focusZone(tab === 'terminal' || !(shell.pages[tab]?.list ?? true) ? 'main' : 'list')
  }

  /** The key after G or ⌘G: a page letter, a workspace number, or H for recently closed sessions */
  const onLeader = (event: KeyboardEvent): void => {
    const digit = event.code.match(/^Digit([1-9])$/)?.[1]
    if (digit) {
      const target = workspaces[Number(digit) - 1]
      return target ? switchWorkspace(target.id) : flash(`No workspace ${digit}`)
    }
    const letter = event.code.match(/^Key([A-Z])$/)?.[1].toLowerCase()
    if (letter === 'a') return setDrawerOpen(true)
    if (letter === 'h') return void (runShellCommand('closedSessions') || flash('Recently closed sessions need the Terminal plugin'))
    const page = letter ? LEADER_PAGES[letter] : undefined
    if (!page) return
    if (!tabExists(page)) return flash('That page belongs to a plugin that is off; turn it on in Settings')
    goPage(page)
  }

  // A tab whose plugin was switched off, or a saved tab from a plugin that no longer exists
  useEffect(() => {
    if (pluginsReady && !tabExists(appTab)) setAppTab('worktrees')
  })

  /** Each workspace remembers its selected worktree and open tabs */
  const switchWorkspace = (id: string): void => {
    if (id === workspaceId) return
    workspaceViews.current.set(workspaceId, { selected, docTabs, appTab, editorTabs, viewer })
    // In memory for workspaces visited this run, else where the workspace was left last time
    const view = workspaceViews.current.get(id) ?? { ...readPlace(id), docTabs: [], editorTabs: [] }
    const nextSelected = view?.selected ?? null
    if (nextSelected === selected || nextSelected === null) {
      setViewer(view?.viewer ?? null)
      setEditorTabs(view?.editorTabs ?? [])
    } else {
      // Selecting a worktree resets the open file, so its effect restores these
      pendingViewer.current = view?.viewer ?? null
      pendingTabs.current = view?.editorTabs ?? null
    }
    setSelected(nextSelected)
    setDocTabs(view?.docTabs ?? [])
    setAppTab(view?.appTab ?? (isRestorableTab(appTab) ? appTab : 'worktrees'))
    setCurrentWorkspace(id)
  }

  const openWorktree = (worktreePath: string): void => {
    setAppTab('worktrees')
    setSelected(worktreePath)
  }

  /** Replaces a document tab with the same key, so reopening refreshes its content */
  const openTab = (tab: DocumentTab): void => {
    setDocTabs((tabs) => (tabs.some((candidate) => candidate.key === tab.key) ? tabs.map((candidate) => (candidate.key === tab.key ? tab : candidate)) : [...tabs, tab]))
    setAppTab(tab.key)
  }

  const closeTab = (key: string): void => {
    const tab = docTabs.find((candidate) => candidate.key === key)
    setDocTabs(docTabs.filter((candidate) => candidate.key !== key))
    if (appTab === key) setAppTab(tab?.parent ?? 'worktrees')
  }

  const startSession = (kind: SessionKind, cwd = defaultCwd): void => {
    const service = findService('sessions')
    if (!service) return
    void service.start(cwd, kind)
    // Sessions show in the terminal panel unless the Terminal tab is already open
    if (appTab !== 'terminal' && panelIds.includes('terminal') && !dock.isVisible('terminal')) dock.show('terminal')
  }

  const sessionsAvailable = findService('sessions') !== null
  const [branchDialog, setBranchDialog] = useState<{ repo: Repo; worktree: boolean; base?: string } | null>(null)
  const [prompt, setPrompt] = useState<{ title: string; description?: string; placeholder?: string; initialValue?: string; confirmLabel: string; onSubmit: (value: string) => Promise<void> } | null>(null)

  const createWorktree = async (repoPath: string, branch: string, base?: string, session: SessionKind | null = null): Promise<void> => {
    const path = await window.api.addWorktree(repoPath, branch, base)
    flash(`Created worktree ${branch}`)
    rescan()
    openWorktree(path)
    if (session) startSession(session, path)
  }

  const submitBranch = async ({ repoPath, name, base, worktree, session }: NewBranchRequest): Promise<void> => {
    if (worktree) return createWorktree(repoPath, name, base, session)
    await window.api.createBranch(repoPath, name, base)
    flash(`Created branch ${name}`)
    rescan()
  }

  /** Remote-only branches are checked out under their local name, tracking origin */
  const openBranch = (branch: Branch, repo: Repo, session: SessionKind | null = null): void => {
    const name = branch.remote ? branch.name.slice(branch.name.indexOf('/') + 1) : branch.name
    flash(`Creating worktree for ${name}...`)
    createWorktree(repo.path, name, undefined, session).catch((reason: unknown) => flash(errorMessage(reason)))
  }

  const branchMenu = (event: React.MouseEvent, branch: Branch, repo: Repo): void =>
    openMenu(event, [
      { label: 'Open as worktree', run: () => openBranch(branch, repo) },
      ...(sessionsAvailable ? getAgents().map((agent) => ({ label: `Open as worktree with ${agent.label}`, run: () => openBranch(branch, repo, agent.id) })) : []),
      null,
      { label: 'New branch from here…', run: () => setBranchDialog({ repo, worktree: false, base: branch.name }) },
      { label: 'Copy branch name', run: () => copyText(branch.name) },
      !branch.remote && null,
      !branch.remote && {
        label: branch.merged ? 'Delete merged branch…' : 'Delete branch…',
        run: () => {
          if (!window.confirm(`Delete branch ${branch.name}?\n\nGit refuses if it has commits that are not merged anywhere.`)) return
          window.api
            .deleteBranch(repo.path, branch.name)
            .then(() => (flash(`Deleted branch ${branch.name}`), rescan()))
            .catch((reason: unknown) => flash(errorMessage(reason)))
        }
      }
    ])

  const removeWorktree = (worktree: Worktree): void => {
    const dirty = worktree.changedFiles > 0
    const warning = dirty ? `\n\nIt has ${worktree.changedFiles} uncommitted changes that will be lost.` : ''
    if (!window.confirm(`Remove worktree ${branchLabel(worktree)}?${warning}\n\nThe branch itself is kept.`)) return
    window.api
      .removeWorktree(worktree.path, dirty)
      .then(() => {
        if (selected === worktree.path) setSelected(null)
        flash(`Removed worktree ${branchLabel(worktree)}`)
        rescan()
      })
      .catch((reason: unknown) => flash(errorMessage(reason)))
  }

  const sessionEntries = (cwd: string): MenuEntry[] =>
    sessionsAvailable ? getAgents().map((agent) => ({ label: `New ${agent.label} session here`, run: () => startSession(agent.id, cwd) })) : []

  const repoMenu = (event: React.MouseEvent, repo: Repo): void =>
    openMenu(event, [
      { label: 'New worktree…', run: () => setBranchDialog({ repo, worktree: true }) },
      { label: 'New branch…', run: () => setBranchDialog({ repo, worktree: false }) },
      scope.focus === repo.path
        ? { label: 'Exit focus', run: () => setScopeFocus('') }
        : { label: 'Focus on this project', run: () => setScopeFocus(repo.path) },
      null,
      ...sessionEntries(repo.path),
      null,
      { label: 'Copy path', run: () => copyText(repo.path) },
      { label: 'Reveal in Finder', run: () => window.api.revealInFinder(repo.path) },
      null,
      ...workspaces
        .filter((candidate) => !candidate.repoPaths.includes(repo.path))
        .map((candidate) => ({ label: `Add to ${candidate.name}`, run: () => addRepoToWorkspace(candidate.id, repo.path) })),
      workspace && {
        label: `Remove from ${workspace.name}`,
        run: () => saveWorkspace({ ...workspace, repoPaths: workspace.repoPaths.filter((path) => path !== repo.path) })
      },
      { label: 'New workspace…', run: () => setEditingWorkspace(null) },
      null,
      { label: 'Rescan worktrees', accelerator: 'R', run: rescan }
    ])

  const worktreeMenu = (event: React.MouseEvent, worktree: Worktree, repo: Repo): void =>
    openMenu(event, [
      { label: 'Open', run: () => openWorktree(worktree.path) },
      { label: 'New worktree…', run: () => setBranchDialog({ repo, worktree: true, base: worktree.branch ?? undefined }) },
      { label: 'New branch from here…', run: () => setBranchDialog({ repo, worktree: false, base: worktree.branch ?? worktree.head }) },
      null,
      ...sessionEntries(worktree.path),
      null,
      { label: 'Copy path', run: () => copyText(worktree.path) },
      { label: 'Copy branch name', enabled: worktree.branch !== null, run: () => copyText(worktree.branch ?? '') },
      { label: 'Copy commit hash', run: () => copyText(worktree.head) },
      { label: 'Reveal in Finder', run: () => window.api.revealInFinder(worktree.path) },
      null,
      worktree.path === repo.path
        ? { label: 'Main worktree cannot be removed', enabled: false, run: () => undefined }
        : { label: 'Remove worktree…', run: () => removeWorktree(worktree) }
    ])

  const fileEntries = (worktreePath: string, path: string): MenuEntry[] => [
    { label: 'Copy relative path', run: () => copyText(path) },
    { label: 'Copy absolute path', run: () => copyText(`${worktreePath}/${path}`) },
    { label: 'Reveal in Finder', run: () => window.api.revealInFinder(`${worktreePath}/${path}`) },
    { label: 'Open with default app', run: () => window.api.openPath(`${worktreePath}/${path}`) }
  ]

  const parentOf = (path: string): string => path.split('/').slice(0, -1).join('/')

  const askCreate = (worktreePath: string, kind: 'file' | 'folder', folder: string, open: (path: string) => void): void =>
    setPrompt({
      title: `New ${kind} in ${folder || baseName(worktreePath)}`,
      description: 'Nested paths like utils/format.ts create the folders in between.',
      placeholder: kind === 'file' ? 'name.ts' : 'folder',
      confirmLabel: `Create ${kind}`,
      onSubmit: async (name) => {
        const path = folder ? `${folder}/${name}` : name
        await window.api.createPath(worktreePath, kind === 'folder' ? `${path}/` : path)
        loadWorktree(worktreePath)
        if (kind === 'file') open(path)
      }
    })

  const askRename = (worktreePath: string, path: string): void =>
    setPrompt({
      title: `Rename ${baseName(path)}`,
      description: 'Changing the folder part moves it.',
      initialValue: path,
      confirmLabel: 'Rename',
      onSubmit: async (next) => {
        await window.api.renamePath(worktreePath, path, next)
        loadWorktree(worktreePath)
        setEditorTabs((tabs) => tabs.map((tab) => (tab === path ? next : tab)))
        if (viewer?.path === path) setViewer({ path: next, line: null })
      }
    })

  const trash = (worktreePath: string, path: string): void => {
    if (!window.confirm(`Move ${path} to the Trash?`)) return
    window.api
      .trashPath(worktreePath, path)
      .then(() => {
        flash(`Moved ${baseName(path)} to the Trash`)
        const removed = (tab: string): boolean => tab === path || tab.startsWith(`${path}/`)
        setEditorTabs((tabs) => tabs.filter((tab) => !removed(tab)))
        if (viewer && removed(viewer.path)) setViewer(null)
        loadWorktree(worktreePath)
      })
      .catch((reason: unknown) => flash(errorMessage(reason)))
  }

  /** New, rename and trash entries for a file or folder ('' is the worktree root) */
  const pathEntries = (worktreePath: string, path: string, isFolder: boolean, open: (path: string) => void): MenuEntry[] => [
    { label: 'New file…', run: () => askCreate(worktreePath, 'file', isFolder ? path : parentOf(path), open) },
    { label: 'New folder…', run: () => askCreate(worktreePath, 'folder', isFolder ? path : parentOf(path), open) },
    path !== '' && null,
    path !== '' && { label: 'Rename…', run: () => askRename(worktreePath, path) },
    path !== '' && { label: 'Move to Trash…', run: () => trash(worktreePath, path) }
  ]

  const discardFile = (worktreePath: string, path: string): void => {
    if (!window.confirm(`Discard all changes to ${path}?\n\nUntracked files are deleted. This cannot be undone.`)) return
    window.api
      .discardChanges(worktreePath, path)
      .then(() => {
        flash(`Discarded changes to ${baseName(path)}`)
        loadWorktree(worktreePath)
      })
      .catch((reason: unknown) => flash(errorMessage(reason)))
  }

  const changedFileMenu = (event: React.MouseEvent, path: string): void => {
    if (!selected) return
    openMenu(event, [
      { label: 'Show diff', run: () => showDiff(path) },
      { label: 'Open file', run: () => setViewer({ path, line: null }) },
      null,
      ...fileEntries(selected, path),
      null,
      { label: 'Discard changes…', run: () => discardFile(selected, path) }
    ])
  }

  const explorerMenu = (event: React.MouseEvent, path: string, open: () => void): void => {
    if (!selected) return
    const changed = files.some((patch) => patch.path === path)
    openMenu(event, [
      { label: 'Open', run: open },
      changed && { label: 'Show diff', run: () => (setAppTab('worktrees'), showDiff(path)) },
      null,
      ...fileEntries(selected, path),
      changed && null,
      changed && { label: 'Discard changes…', run: () => discardFile(selected, path) },
      null,
      ...pathEntries(selected, path, false, (next) => openFile(next, null))
    ])
  }

  const folderMenu = (event: React.MouseEvent, path: string, open: (path: string) => void): void => {
    if (!selected) return
    openMenu(event, [
      ...pathEntries(selected, path, true, open),
      path !== '' && null,
      path !== '' && { label: 'Copy relative path', run: () => copyText(path) },
      { label: 'Reveal in Finder', run: () => window.api.revealInFinder(`${selected}/${path}`) }
    ])
  }

  const tabMenu = (event: React.MouseEvent, close: () => void, closeOthers: () => void): void =>
    openMenu(event, [
      { label: 'Close tab', run: close },
      { label: 'Close other tabs', run: closeOthers }
    ])

  const files = patches ?? []
  const file = files.find((patch) => patch.path === filePath)
  const folderToggles = useState<Set<string>>(new Set())
  const changedFolders = useMemo(() => folderPaths(files), [patches])
  const canFoldChanges = filesOpen && changedFolders.length > 1
  const anyChangedFolderOpen = changedFolders.some((folder) => groupOpen(folderToggles[0], folder))
  const foldChanges = (): void => folderToggles[1](allFolders(changedFolders, !anyChangedFolderOpen))
  const diffSymbols = useSymbolNavigation({ worktreePath: selected ?? '', path: file?.path ?? '', onNavigate: navigate })

  /** The diff's keyboard cursor, an index into the patch rows; -1 before j or k is pressed */
  const [lineCursor, setLineCursor] = useState(-1)
  const diffRows = useMemo(() => (file ? patchRows(file.patch) : []), [file?.patch])
  const cursorRow: PatchRow | undefined = diffRows[lineCursor]
  const diffScroll = useRef<HTMLDivElement>(null)
  useEffect(() => {
    setDraft(null)
    setLineCursor(-1)
  }, [selected, filePath])
  useEffect(() => {
    const container = diffScroll.current
    if (!cursorRow || !container) return
    const type = cursorRow.text.startsWith('+') ? 'change-addition' : cursorRow.text.startsWith('-') ? 'change-deletion' : undefined
    const target = findLineElement(container, rowRange(cursorRow).start, type)
    if (!target) return
    const box = target.getBoundingClientRect()
    const view = container.getBoundingClientRect()
    if (box.top < view.top + 48 || box.bottom > view.bottom - 48) container.scrollTop += box.top - view.top - view.height / 3
  }, [lineCursor, cursorRow])
  const firstChange = diffRows.findIndex((row) => row.text.startsWith('+') || row.text.startsWith('-'))
  const moveLineCursor = (step: 1 | -1): void => setLineCursor(lineCursor < 0 ? Math.max(0, firstChange) : Math.max(0, Math.min(diffRows.length - 1, lineCursor + step)))
  /** Line in the new file at the cursor, for opening the file there; a deleted line uses the one above it */
  const cursorFileLine = (): number | null => diffRows.slice(0, lineCursor + 1).findLast((row) => row.new !== null)?.new ?? null

  useEffect(() => {
    const path = viewer?.path
    if (path) setEditorTabs((tabs) => (tabs.includes(path) ? tabs : [...tabs, path]))
  }, [viewer?.path])

  const closeEditorTab = (path: string): void => {
    const index = editorTabs.indexOf(path)
    const rest = editorTabs.filter((tab) => tab !== path)
    setEditorTabs(rest)
    if (viewer?.path !== path) return
    const next = rest[Math.min(index, rest.length - 1)]
    setViewer(next ? { path: next, line: null } : null)
  }

  // ⌘W never closes the app: plugins go first (the focused terminal), then the active editor tab, then a document tab
  const closeShortcut = useRef(() => undefined as void)
  closeShortcut.current = () => {
    if (plugins.some(({ plugin }) => plugin.onCloseShortcut?.(host))) return
    if (appTab === 'worktrees' && viewer) return closeEditorTab(viewer.path)
    if (openDocTab) closeTab(openDocTab.key)
  }
  useEffect(() => window.api.onCloseShortcut(() => closeShortcut.current()), [])
  const openSettingsRef = useRef(openSettings)
  openSettingsRef.current = openSettings
  // A preload from before this menu item (dev window not reloaded yet) has no listener
  useEffect(() => window.api.onOpenSettings?.(() => openSettingsRef.current()), [])
  useEffect(() => window.api.onRunAction?.((id) => runAction(id)), [])
  useEffect(() => void refreshToolStatus(), [])
  // The native menu is rebuilt from whatever is runnable now, so a plugin loading or a key rebound updates it
  useEffect(() => {
    // A plugin toggle drops and re-registers every runner in one tick; without this the menu bar rebuilds once per call and flashes
    let queued = false
    const send = (): void => {
      if (queued) return
      queued = true
      queueMicrotask(() => {
        queued = false
        window.api.setMenuActions?.(menuActions())
      })
    }
    send()
    const drops = [subscribeRunners(send), onKeymapChange(send)]
    return () => drops.forEach((drop) => drop())
  }, [])

    // Chords the whole app answers to, terminals included; every one is a named action Settings can rebind
    const anywhere: Record<string, () => void> = {
      'app.palette': () => setPaletteOpen(!paletteOpen),
      'app.paletteAlt': () => setPaletteOpen(!paletteOpen),
      'app.settings': openSettings,
      'app.comments': () => setDrawerOpen(!drawerOpen),
      'app.back': () => goToPlace(-1),
      'app.forward': () => goToPlace(1),
      // ⌥⌘= / ⌥⌘- / ⌥⌘0 size the focused terminal's font, else the editor's; ⌘= / ⌘- stay window zoom as in VS Code
      'app.fontBigger': () => stepFontSize(isTerminalFocused() ? 'terminalFontSize' : 'editorFontSize', 1),
      'app.fontSmaller': () => stepFontSize(isTerminalFocused() ? 'terminalFontSize' : 'editorFontSize', -1),
      'app.fontDefault': () => stepFontSize(isTerminalFocused() ? 'terminalFontSize' : 'editorFontSize', 0),
      'app.search': () => setSearchOpen(!searchOpen),
      'app.closedSessions': () => void (runShellCommand('closedSessions') || flash('Recently closed sessions need the Terminal plugin')),
      'app.diffStyle': () => setDiffStyle(diffStyle === 'split' ? 'unified' : 'split'),
      'app.copyComments': () => void navigator.clipboard.writeText(commentsPrompt()).then(() => flash(`Copied ${commentCount}`)),
      'app.clearComments': () => clearComments(),
      'workspace.new': () => setEditingWorkspace(null),
      'workspace.edit': () => workspace && setEditingWorkspace(workspace),
      ...Object.fromEntries(tabs.map((tab) => [`page.${tab.id}`, () => goPage(tab.id)]))
    }
  const anywhereRef = useRef(anywhere)
  anywhereRef.current = anywhere
  // Everything here is runnable from the native menu too, which is why it lives outside the key handler
  useEffect(() => {
    const drops = Object.keys(anywhereRef.current).map((id) => registerActionRunner(id, () => anywhereRef.current[id]?.()))
    return () => drops.forEach((drop) => drop())
  }, [tabs.map((tab) => tab.id).join()])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const anywhere = anywhereRef.current
      const anywhereId = actionForEvent(event, Object.keys(anywhere))
      if (anywhereId) {
        event.preventDefault()
        return anywhere[anywhereId]()
      }
      const numpadStep = event.metaKey && event.altKey && !event.shiftKey && !event.ctrlKey ? NUMPAD_FONT_STEPS.get(event.code) : undefined
      if (numpadStep !== undefined) {
        event.preventDefault()
        return stepFontSize(isTerminalFocused() ? 'terminalFontSize' : 'editorFontSize', numpadStep)
      }
      // Before the dialog guard: previews inside search and references results navigate too
      const navigationKind = navigationKindForKey(event)
      const active = getActiveTarget()
      if (navigationKind && active) {
        event.preventDefault()
        return navigate(navigationKind, active.target, active.worktreePath)
      }
      if (paletteOpen || searchOpen || sheetOpen) return
      if (plugins.some(({ plugin }) => plugin.onKeyDown?.(event, host))) return event.preventDefault()
      // composedPath reaches into shadow roots, where the code editor's input lives
      const origin = event.composedPath()[0]
      const typing = isTyping(event)
      // Bare keys of the zone model, unless the page used the key or focus is in a dialog outside the zones
      const inZones = document.activeElement === document.body || document.activeElement?.closest('[data-zone]') != null
      if (!event.defaultPrevented && inZones && !event.metaKey && !event.ctrlKey && !event.altKey) {
        if (!typing && matchesAction(event, 'app.leaderBare')) return (event.preventDefault(), updateShell({ leader: true }))
        // An open file steps back to its diff before esc leaves main
        if (!typing && event.key === 'Escape' && appTab === 'worktrees' && getShell().zone === 'main' && viewer) return (event.preventDefault(), files.some((patch) => patch.path === viewer.path) ? showDiff(viewer.path) : setViewer(null))
        if (!typing && event.key === 'Escape' && zoneBack()) return event.preventDefault()
        // Settings takes the filter key for its own search
        if (!typing && matchesAction(event, 'app.filterZone') && appTab !== 'settings' && focusZoneField()) return event.preventDefault()
        // Esc in a text field hands the keys back to its zone, as does ↓ from a filter; the terminal and the code editor keep their Esc
        const field = origin instanceof HTMLInputElement || (origin instanceof HTMLTextAreaElement && !isTerminalFocused()) ? origin.closest<HTMLElement>('[data-zone]') : null
        if ((event.key === 'Escape' || (event.key === 'ArrowDown' && origin instanceof HTMLInputElement)) && field) return (event.preventDefault(), field.focus({ preventScroll: true }))
      }
      // Digits match the physical key (event.code), so ⌥ producing ¡™£ or keyboard layouts don't matter
      const workspaceDigit = digitPressed(event, settings.digitShortcuts.workspaces)
      if (workspaceDigit !== null) {
        const target = workspaces[workspaceDigit - 1]?.id
        if (!target) return
        event.preventDefault()
        return switchWorkspace(target)
      }
      const tabDigit = digitPressed(event, settings.digitShortcuts.tabs)
      // ⌥ digits type characters in text fields; a focused terminal owns ⌘ digits (its tabs) and ⌥ digits (its panes)
      const tabModifier = settings.digitShortcuts.tabs
      const heldByFocus = isTerminalFocused() ? tabModifier === 'alt' || tabModifier === 'meta' : typing && tabModifier === 'alt'
      if (tabDigit && !heldByFocus) {
        const digitTabs = [...tabs.map((tab) => tab.id), ...docTabs.map((tab) => tab.key)]
        // 9 goes to the last tab, like browsers
        const tab = tabDigit === 9 ? digitTabs.at(-1) : digitTabs[tabDigit - 1]
        if (!tab) return
        event.preventDefault()
        return setAppTab(tab)
      }
      const panelForKey = panelIds.find((id) => matchesAction(event, `panel.${id}`))
      if (panelForKey) {
        event.preventDefault()
        return dock.toggle(panelForKey)
      }
      // The explorer's filter and the changed files column belong to Worktrees; plugin tabs use their keys themselves
      if (appTab === 'worktrees' && matchesAction(event, 'wt.findFile')) {
        event.preventDefault()
        return focusExplorerFilter()
      }
      if (appTab === 'worktrees' && matchesAction(event, 'wt.changedFiles')) {
        event.preventDefault()
        return setFilesOpen(!filesOpen)
      }
      if (appTab === 'worktrees' && isPageKey(event)) worktreeKey(event)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  /** Worktrees keys outside text fields; which key runs which action comes from the keymap, so Settings can rebind them */
  const worktreeKey = (event: KeyboardEvent): void => {
    const act = (run: () => void): void => {
      event.preventDefault()
      run()
    }
    const id = actionForEvent(event, WORKTREE_ACTIONS)
    if (id === 'wt.rescan') return act(rescan)
    if (getShell().zone !== 'main' || !selected) return
    const shownPath = viewer?.path ?? file?.path
    if (id === 'wt.terminal') return act(() => openTerminal(selected))
    if (id === 'wt.diffStyle') return act(() => setDiffStyle(diffStyle === 'split' ? 'unified' : 'split'))
    if (id === 'wt.fold' && canFoldChanges) return act(foldChanges)
    if ((id === 'wt.nextFile' || id === 'wt.previousFile') && files.length > 0) {
      const at = files.findIndex((patch) => patch.path === filePath)
      return act(() => showDiff(files[Math.max(0, Math.min(files.length - 1, at + (id === 'wt.nextFile' ? 1 : -1)))].path))
    }
    if (id === 'wt.copyPath' && shownPath) return act(() => (copyText(shownPath), flash(`Copied ${shownPath}`)))
    if (id === 'wt.markdown' && shownPath && isMarkdownPath(shownPath)) return act(() => setMarkdownPreview(!markdownPreview))
    if (id === 'wt.history' && viewer) return act(() => setHistoryFor({ worktreePath: selected, path: viewer.path }))
    // An open file handles the comment keys itself
    if (viewer || !file) return
    const arrow = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
    if (id === 'wt.lineDown' || id === 'wt.lineUp' || arrow) return act(() => moveLineCursor(id === 'wt.lineDown' || arrow === 1 ? 1 : -1))
    const row = cursorRow ?? diffRows[firstChange]
    if ((id === 'wt.comment' || id === 'wt.commentAlt') && row) {
      return act(() => {
        if (!cursorRow) setLineCursor(firstChange)
        setDraft(rowRange(row))
      })
    }
    const onButton = event.target instanceof Element && event.target.closest('button, a, [role="button"]')
    if (id === 'wt.open' || (event.key === 'Enter' && !onButton)) return act(() => setViewer({ path: file.path, line: cursorFileLine() }))
  }

  /** A terminal in `path`: its live session if there is one, else a new shell */
  const openTerminal = (path: string): void => {
    const service = findService('sessions')
    if (!service) return flash('Terminals need the Terminal plugin; turn it on in Settings')
    const existing = sessions.find((session) => session.worktreePath === path && session.status !== 'exited')
    if (existing) return service.reveal(existing.id)
    startSession('shell', path)
  }

  /** / puts the cursor in the focused zone's own text field, like a list's filter */
  const focusZoneField = (): boolean => {
    const zone = getShell().zone
    const field = [...document.querySelectorAll<HTMLInputElement>(`[data-zone="${zone}"] input:not([type="checkbox"])`)].find((input) => input.closest('[data-zone]')?.getAttribute('data-zone') === zone)
    field?.select()
    field?.focus()
    return Boolean(field)
  }

  /** ⌘P in Worktrees: the explorer's filter, showing the inspector first when it's hidden */
  const focusExplorerFilter = (): void => {
    if (!worktreePanels.inspector) togglePanel('inspector', 'worktrees')
    // After the shown inspector took focus
    requestAnimationFrame(() => requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[data-zone="inspector"] input')?.focus()))
  }

  const selectedRepo = repos?.find((repo) => repo.worktrees.some((worktree) => worktree.path === selected))
  const worktree = selectedRepo?.worktrees.find((candidate) => candidate.path === selected)
  const additions = files.reduce((sum, patch) => sum + patch.additions, 0)
  const deletions = files.reduce((sum, patch) => sum + patch.deletions, 0)
  const worktreeComments = comments.filter((comment) => comment.worktreePath === selected)
  // Comments collected anywhere in this workspace, e.g. Jira items added from the Tasks tab, reachable from any tab
  const [drawerOpen, setDrawerOpen] = useState(false)
  const checkoutLabel = (path: string): string => {
    const repo = repos?.find((candidate) => candidate.worktrees.some((worktree) => worktree.path === path))
    const checkout = repo?.worktrees.find((worktree) => worktree.path === path)
    return repo && checkout ? `${baseName(repo.path)} · ${branchLabel(checkout)}` : baseName(path)
  }
  const fileComments = worktreeComments.filter((comment) => !comment.kind && comment.filePath === file?.path)

  const activity: Record<string, 'input' | 'running'> = {}
  for (const session of sessions) {
    if (session.status === 'input') activity[session.worktreePath] = 'input'
    else if (session.status === 'running' && isAgent(session.kind)) activity[session.worktreePath] ??= 'running'
  }

  const deleteComment = (comment: ReviewComment): void =>
    setComments(comments.filter((candidate) => candidate.id !== comment.id))

  const lineAnnotations: DiffLineAnnotation<{ commentId: string | null }>[] = [
    ...fileComments.map((comment) => ({
      side: annotationSide(comment.range),
      lineNumber: comment.range.end,
      metadata: { commentId: comment.id }
    })),
    ...(draft ? [{ side: annotationSide(draft), lineNumber: draft.end, metadata: { commentId: null } }] : [])
  ]

  const addComment = (text: string, attachments: Attachment[]): void => {
    if (!file || !selected || !draft) return
    const comment = {
      id: crypto.randomUUID(),
      worktreePath: selected,
      filePath: file.path,
      range: draft,
      code: extractLines(file.patch, draft),
      text,
      attachments
    }
    setComments([...comments, comment])
    setDraft(null)
  }

  const commentCount = `${worktreeComments.length} comment${worktreeComments.length === 1 ? '' : 's'}`

  const commentsPrompt = (): string => {
    // A reference inlines its own text when the drawer says so, else when nothing on this machine could fetch it
    const resolved = worktreeComments.map((comment) => ({ ...comment, inline: comment.inline ?? inlineByDefault(comment.tool) }))
    return promptForComments(resolved, worktree ? `${branchLabel(worktree)} (${worktree.path})` : null)
  }

  const clearComments = (): void => {
    if (window.confirm(`Delete ${commentCount} on this worktree?`)) {
      setComments(comments.filter((comment) => comment.worktreePath !== selected))
    }
  }

  const onSent = (message: string): void => {
    flash(message)
    if (!message.startsWith('Copied') && !dock.isVisible('terminal')) dock.show('terminal')
  }

  /** Sends the comments collected for a checkout to an agent session there; pull requests use their local worktree or repo */
  const commentsSendButton = (worktreePath: string | null, variant: 'pill' | 'panel', hotkeys = false): React.JSX.Element | null => {
    const pathComments = comments.filter((comment) => comment.worktreePath === worktreePath)
    if (!worktreePath || pathComments.length === 0) return null
    const checkout = repos?.flatMap((repo) => repo.worktrees).find((candidate) => candidate.path === worktreePath)
    return (
      <SendButton
        repos={repos}
        worktreePath={worktreePath}
        count={pathComments.length}
        prompt={() => promptForComments(pathComments, checkout ? `${branchLabel(checkout)} (${checkout.path})` : worktreePath)}
        variant={variant}
        hotkeys={hotkeys}
        onDone={onSent}
        onClear={() => {
          if (window.confirm(`Delete ${pathComments.length} comment${pathComments.length === 1 ? '' : 's'} on ${baseName(worktreePath)}?`)) {
            setComments(comments.filter((comment) => comment.worktreePath !== worktreePath))
          }
        }}
      />
    )
  }

  /** The Comments panel for any checkout, with sending and clearing */
  const renderCommentsPanel = (worktreePath: string, open: (path: string) => void): React.JSX.Element => {
    const pathComments = comments.filter((comment) => comment.worktreePath === worktreePath)
    return (
      <CommentsPanel
        comments={pathComments}
        footer={commentsSendButton(worktreePath, 'panel')}
        onClear={() => {
          if (window.confirm(`Delete ${pathComments.length} comment${pathComments.length === 1 ? '' : 's'} on ${baseName(worktreePath)}?`)) {
            setComments(comments.filter((comment) => comment.worktreePath !== worktreePath))
          }
        }}
        onOpen={(comment) => (comment.kind === 'browser' ? openPage(comment.filePath) : open(comment.filePath))}
        onDelete={deleteComment}
        onUpdate={(next) => setComments(comments.map((comment) => (comment.id === next.id ? next : comment)))}
      />
    )
  }

  const renderPanel = (panel: PanelId, side: DockSide): React.JSX.Element | null => {
    const PluginPanel = pluginPanels.find((candidate) => candidate.id === panel)?.render
    return PluginPanel ? <PluginPanel side={side} /> : null
  }

  const dockFrame = (side: DockSide): React.JSX.Element | null => {
    const panel = dock.visiblePanel(side)
    const info = panel ? panelInfo(panel) : undefined
    if (!panel || !info || shell.zen) return null
    const size = dock.layout.sizes[side]
    const [min, max] = SIZE_LIMITS[side]
    const frame = { left: 'border-r', right: 'border-l', bottom: 'border-t' }[side]
    const aside = (
      <aside
        style={side === 'bottom' ? { height: size } : { width: size }}
        className={`relative flex min-h-0 min-w-0 shrink-0 flex-col border-border bg-card ${frame} ${side === 'bottom' ? '' : 'flex-1'}`}
      >
        <ResizeHandle edge={RESIZE_EDGE[side]} width={size} min={min} max={max} onResize={(next) => dock.resize(side, next)} />
        <div
          draggable
          title={`Drag to move ${info.label}`}
          onDragStart={(event) => {
            event.dataTransfer.setData('text/plain', panel)
            startPanelDrag(panel)
          }}
          onDragEnd={() => setDraggingPanel(null)}
          className="group/grip absolute top-0 left-1/2 z-30 flex h-2.5 w-14 -translate-x-1/2 cursor-grab items-start justify-center pt-[3px] active:cursor-grabbing"
        >
          <span className="h-1 w-8 rounded-full bg-foreground/10 group-hover/grip:bg-foreground/40" />
        </div>
        <div className="min-h-0 flex-1">
          <ErrorBoundary label={info.label} resetKey={panel}>
            <Suspense fallback={null}>{renderPanel(panel, side)}</Suspense>
          </ErrorBoundary>
        </div>
      </aside>
    )
    // Every dock is the dock zone, so F6 reaches a terminal docked on either side too
    return (
      <Zone id="dock" label={side === 'bottom' && info.label === 'Terminal' ? 'Bottom terminal' : info.label} className="shrink-0">
        {aside}
      </Zone>
    )
  }

  /** Tabs other than Worktrees keep plugin panels (the terminal) docked where the Worktrees tab has them; without `frames` the same structure stays so content keeps its state */
  const withDock = (content: React.ReactNode, frames = true): React.JSX.Element => (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex min-h-0 min-w-0 flex-1">
        {frames && dockFrame('left')}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <DockSlot.Provider value={null}>{content}</DockSlot.Provider>
        </div>
        {frames && dockFrame('right')}
      </div>
      {frames && dockFrame('bottom')}
      {frames && draggingPanel && (
        <DropZones
          onDrop={(side) => {
            dock.move(draggingPanel, side)
            setDraggingPanel(null)
          }}
        />
      )}
    </div>
  )

  const titleBarItems = (end: boolean): React.ReactNode =>
    plugins
      .flatMap(({ manifest, plugin }) => (plugin.titleBar ?? []).map((item, index) => ({ key: `${manifest.id}:${index}`, ...item })))
      .filter((item) => (item.end ?? false) === end)
      .sort((a, b) => a.order - b.order)
      .map(({ key, render: Item }) => (
        <ErrorBoundary key={key} label={key} resetKey={key}>
          <Item />
        </ErrorBoundary>
      ))

  const scopeLabel = scope.focus ? baseName(scope.focus) : workspace ? workspace.name : scope.folder ? baseName(scope.folder) : 'all repositories'
  const openDocTab = docTabs.find((tab) => tab.key === appTab)

  const explorerRoot = browseRoot ?? selected ?? window.api.home
  // The filesystem root has no parent
  const parentFolder = (path: string): string | null => (path === '/' ? null : path.split('/').slice(0, -1).join('/') || '/')
  const browseParent = (): void => {
    const parent = parentFolder(explorerRoot)
    if (parent) setBrowsedFolder(parent)
  }
  const renderExplorer = (activePath: string | null, open: (path: string) => void): React.JSX.Element =>
    worktree && !browseRoot ? (
      <Explorer
        files={worktreeFiles}
        changed={new Set(files.map((patch) => patch.path))}
        activePath={activePath}
        onOpen={open}
        onFileMenu={(event, path) => explorerMenu(event, path, () => open(path))}
        onFolderMenu={(event, path) => folderMenu(event, path, open)}
        onCreate={(kind, folder) => selected && askCreate(selected, kind, folder, open)}
        onParent={browseParent}
      />
    ) : (
      <FolderExplorer root={explorerRoot} activePath={activePath} onOpen={open} onParent={explorerRoot === '/' ? undefined : browseParent} />
    )

  const activePage = openDocTab?.parent ?? appTab
  const showTitle = shell.title && !shell.zen
  // One workspace needs no switcher; New workspace stays in the palette and the Go menu
  const showRail = shell.rail && !shell.zen && workspaces.length >= 2
  /** A page without that panel says so rather than flipping a hidden state that shows up on some later page */
  const toggleShellPanel = (panel: PanelName): void => {
    if ((panel === 'list' || panel === 'inspector') && !pageHasPanel(activePage, panel)) return flash(`${appTabLabel} has no ${panel}`)
    togglePanel(panel, activePage)
  }
  useModifierHints()
  useShellKeys({
    enabled: !paletteOpen && !searchOpen,
    onLeader,
    onTogglePanel: toggleShellPanel,
    onSheet: () => setSheetOpen(!sheetOpen)
  })

  // Plugins' host changes only with the data they render from; its functions call this render's closures, so none go stale
  const hostCalls = { setBrowsedFolder, openTab, closeTab, openWorktree, createWorktree, openSettings, flash, setComments, deleteComment, commentsSendButton, renderCommentsPanel, fileView, renderExplorer, withDock, dock, plugins, onSent }
  const latest = useRef(hostCalls)
  latest.current = hostCalls
  const scopeRepoPaths = useMemo(() => (workspaceRepos ? reposInScope(workspaceRepos, scope).map((repo) => repo.path) : null), [repos, workspace, scope.folder, scope.focus])
  const host = useMemo(
    (): HostApi => ({
      repos,
      workspaceId,
      scopeRepoPaths,
      scopeLabel,
      selectedWorktree: selected,
      selectedWorktreeLabel: worktree ? branchLabel(worktree) : null,
      explorerRoot,
      browsedFolder: browseRoot,
      setBrowsedFolder: (path) => latest.current.setBrowsedFolder(path),
      defaultCwd,
      diffStyle,
      activeTab: appTab,
      activePage,
      setActiveTab: setAppTab,
      openTab: (tab) => latest.current.openTab(tab),
      closeTab: (key) => latest.current.closeTab(key),
      openWorktree: (path) => latest.current.openWorktree(path),
      createWorktree: (repoPath, branch, base, session) => latest.current.createWorktree(repoPath, branch, base, session),
      openSettings: (page) => latest.current.openSettings(page),
      flash: (message) => latest.current.flash(message),
      comments,
      addComment: (comment) => latest.current.setComments((current) => [...current, comment]),
      deleteComment: (comment) => latest.current.deleteComment(comment),
      clearComments: (worktreePath) => latest.current.setComments((current) => current.filter((comment) => comment.worktreePath !== worktreePath)),
      renderSendButton: (worktreePath, variant) => latest.current.commentsSendButton(worktreePath, variant),
      renderCommentsPanel: (worktreePath, open) => latest.current.renderCommentsPanel(worktreePath, open),
      renderFileView: (worktreePath, path, line) => latest.current.fileView(worktreePath, path, line),
      renderExplorer: (activePath, open) => latest.current.renderExplorer(activePath, open),
      registerFileOpener: (tabId, opener) => {
        fileOpeners.current.set(tabId, opener)
        return () => fileOpeners.current.delete(tabId)
      },
      withDock: (content) => latest.current.withDock(content),
      showPanel: (id) => latest.current.dock.show(id),
      hidePanel: (id) => latest.current.dock.hide(id),
      isPanelVisible: (id) => latest.current.dock.isVisible(id),
      isEnabled: (pluginId) => latest.current.plugins.some(({ manifest }) => manifest.id === pluginId),
      service: findService,
      onSent: (message) => latest.current.onSent(message)
    }),
    // Beyond the fields: what the render functions and isPanelVisible read, so views built from them refresh
    [repos, workspaceId, scopeRepoPaths, scopeLabel, selected, worktree, explorerRoot, browseRoot, defaultCwd, diffStyle, appTab, activePage, comments, patches, worktreeFiles, fileReload, dock.layout, shell.zen, draggingPanel, plugins]
  )

  const commands: Command[] = [
    { id: 'rescan', group: 'Actions', label: 'Rescan worktrees', icon: 'refresh', shortcut: actionKeys('wt.rescan') || undefined, run: rescan },
    { id: 'settings', group: 'Actions', label: 'Settings', icon: 'settings', shortcut: actionKeys('app.settings') || undefined, run: openSettings },
    ...tabs.map((tab): Command => {
      const letter = leaderOf(tab.id)
      return { id: `tab:${tab.id}`, group: 'Actions', label: `Open ${tab.label.toLowerCase()}`, icon: tab.icon, shortcut: letter ? `G ${letter.toUpperCase()}` : undefined, run: () => goPage(tab.id) }
    }),
    { id: 'search', group: 'Actions', label: 'Search in projects', icon: 'search', shortcut: actionKeys('app.search') || undefined, run: () => setSearchOpen(true) },
    ...(
      [
        ['list', 'Toggle list'],
        ['inspector', 'Toggle inspector'],
        ['rail', 'Toggle workspace rail'],
        ['title', 'Toggle title bar'],
        ['status', 'Toggle status bar']
      ] as const
    ).map(([panel, label]): Command => ({ id: `toggle:${panel}`, group: 'Actions', label, icon: 'panel', shortcut: actionKeys(`panel.${panel}`) || undefined, run: () => toggleShellPanel(panel) })),
    { id: 'agent-comments', group: 'Actions', label: 'Agent comments', icon: 'comment', shortcut: actionKeys('app.comments') || undefined, run: () => setDrawerOpen(true) },
    { id: 'zen', group: 'Actions', label: shell.zen ? 'Leave zen mode' : 'Zen mode: only the main zone, nothing else (⌘G still switches pages)', icon: 'maximize', shortcut: actionKeys('shell.zen') || undefined, run: toggleZen },
    { id: 'shortcuts', group: 'Actions', label: 'Keyboard shortcuts', icon: 'keyboard', shortcut: actionKeys('app.shortcuts') || undefined, run: () => setSheetOpen(true) },
    { id: 'changed', group: 'Actions', label: 'Toggle changed files', icon: 'list', shortcut: actionKeys('wt.changedFiles') || undefined, run: () => setFilesOpen(!filesOpen) },
    ...panelIds.flatMap((id): Command[] => {
      const info = panelInfo(id)
      return info ? [{ id: `panel:${id}`, group: 'Actions', label: `Toggle ${info.label.toLowerCase()}`, icon: info.icon, shortcut: actionKeys(`panel.${id}`) || undefined, run: () => dock.toggle(id) }] : []
    }),
    {
      id: 'style',
      group: 'Actions',
      label: diffStyle === 'split' ? 'Switch to unified diff' : 'Switch to split diff',
      icon: 'list',
      shortcut: actionKeys('app.diffStyle') || undefined,
      run: () => setDiffStyle(diffStyle === 'split' ? 'unified' : 'split')
    },
    ...(worktreeComments.length > 0
      ? ([
          {
            id: 'copy',
            group: 'Actions',
            label: `Copy ${commentCount} for agent`,
            icon: 'copy',
            shortcut: actionKeys('app.copyComments') || undefined,
            run: () => navigator.clipboard.writeText(commentsPrompt()).then(() => flash(`Copied ${commentCount}`))
          },
          { id: 'clear', group: 'Actions', label: `Delete ${commentCount}`, icon: 'close', shortcut: actionKeys('app.clearComments') || undefined, run: clearComments }
        ] satisfies Command[])
      : []),
    ...(paletteOpen ? plugins.flatMap(({ plugin }) => plugin.commands?.(host) ?? []) : []),
    // Most recently used first, so the workspace you flip back to sits at the top before you type
    ...recentWorkspaces(workspacesState).map((candidate): Command => {
      const index = workspaces.indexOf(candidate)
      return {
        id: `workspace:${candidate.id}`,
        group: 'Actions',
        label: `Switch to ${candidate.name}`,
        icon: 'folder',
        shortcut: index < 9 ? digitLabel('workspaces', index + 1) || undefined : undefined,
        run: () => switchWorkspace(candidate.id)
      }
    }),
    { id: 'workspace:new', group: 'Actions', label: 'New workspace', icon: 'folder', shortcut: actionKeys('workspace.new') || undefined, run: () => setEditingWorkspace(null) },
    ...(workspace ? [{ id: 'workspace:edit', group: 'Actions', label: `Edit ${workspace.name}`, icon: 'settings', shortcut: actionKeys('workspace.edit') || undefined, run: () => setEditingWorkspace(workspace) } satisfies Command] : []),
    ...(workspaceRepos ?? []).flatMap((repo) =>
      repo.worktrees.map(
        (candidate): Command => ({
          id: `worktree:${candidate.path}`,
          group: 'Worktrees',
          label: branchLabel(candidate),
          icon: 'branch',
          detail: candidate.changedFiles > 0 ? `${baseName(repo.path)} · ${candidate.changedFiles} changed` : baseName(repo.path),
          run: () => openWorktree(candidate.path)
        })
      )
    ),
    ...(worktreeFiles?.files ?? []).map(
      (path): Command => ({
        id: `file:${path}`,
        group: 'Files',
        label: baseName(path),
        detail: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : undefined,
        filePath: path,
        run: () => {
          setAppTab('worktrees')
          setViewer({ path, line: null })
        }
      })
    )
  ]

  const tabClass = (active: boolean): string =>
    `flex h-6 max-w-64 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs [-webkit-app-region:no-drag] ${
      active ? 'bg-foreground/8 text-foreground ring-1 ring-border' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
    }`
  // Each project is searched once: in the selected worktree when it belongs to it, otherwise in its main checkout
  const searchPaths = (workspaceRepos ? reposInScope(workspaceRepos, scope) : []).map((repo) =>
    repo.worktrees.some((candidate) => candidate.path === selected) && selected ? selected : repo.path
  )
  const activePluginTab = pluginTabs.find((tab) => tab.id === appTab)
  const appTabLabel = openDocTab?.title ?? activePluginTab?.label ?? (appTab === 'settings' ? 'Settings' : appTab === 'worktrees' ? 'Worktrees' : 'This tab')

  const changedPaths = new Set(files.map((patch) => patch.path))
  const worktreeInspector = (
    <div className="flex h-full min-h-0 flex-col">
      <ZoneHeader zone="inspector" title="Explorer">
        <IconButton label={`Hide inspector (${actionKeys('panel.inspector')})`} onClick={() => worktreePanels.toggle('inspector')}>
          <Icon name="close" className="size-3" />
        </IconButton>
      </ZoneHeader>
      <div className="min-h-0 flex-1">
        {worktree ? (
          <Explorer
            files={worktreeFiles}
            changed={changedPaths}
            activePath={viewer?.path ?? null}
            onOpen={(path) => setViewer({ path, line: null })}
            onFileMenu={(event, path) => explorerMenu(event, path, () => setViewer({ path, line: null }))}
            onFolderMenu={(event, path) => folderMenu(event, path, (next) => setViewer({ path: next, line: null }))}
            onCreate={(kind, folder) => askCreate(worktree.path, kind, folder, (next) => setViewer({ path: next, line: null }))}
          />
        ) : (
          <EmptyState title="Select a worktree to browse its files" />
        )}
      </div>
    </div>
  )

  const worktreeMain = (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-9 shrink-0 items-center gap-2 overflow-hidden border-b border-border bg-card px-1.5">
        <IconButton label={`Toggle list (${actionKeys('panel.list')})`} active={worktreePanels.list} onClick={() => worktreePanels.toggle('list')}>
          <Icon name="panel" />
        </IconButton>
        {worktree && selectedRepo ? (
          <div className="flex min-w-0 flex-1 items-center gap-2" title={worktree.path}>
            <Icon name="branch" className="size-3.5 text-muted-foreground" />
            <span className="min-w-0 truncate font-mono text-xs">{branchLabel(worktree)}</span>
            <span className="min-w-0 truncate text-[11px] text-muted-foreground">{baseName(selectedRepo.path)}</span>
            <span className="shrink-0 rounded-sm bg-foreground/6 px-1.5 font-mono text-[11px] text-muted-foreground">{worktree.head}</span>
            {patches && (
              <span className="shrink-0 font-mono text-[11px] whitespace-nowrap tabular-nums">
                <span className="text-emerald-400">+{additions}</span> <span className="text-red-400">−{deletions}</span>
              </span>
            )}
          </div>
        ) : (
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">No worktree selected</span>
        )}
        <div title="Split or unified (w)" className="flex h-6 shrink-0 items-center rounded-md bg-muted p-0.5 ring-1 ring-border">
          {(['split', 'unified'] as const).map((style) => (
            <button key={style} onClick={() => setDiffStyle(style)} className={`h-5 rounded px-2 text-[11px] ${diffStyle === style ? 'bg-foreground/10 text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
              {style === 'split' ? 'Split' : 'Unified'}
            </button>
          ))}
        </div>
        {worktree && (
          <button
            title="Terminal in this worktree (t)"
            onClick={() => openTerminal(worktree.path)}
            className="flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-[11px] text-muted-foreground ring-1 ring-border hover:text-foreground"
          >
            <Icon name="terminal" className="size-3" />
            Terminal
            <Kbd hint>t</Kbd>
          </button>
        )}
        <IconButton label={`Toggle changed files (${actionKeys('wt.changedFiles')})`} active={filesOpen} onClick={() => setFilesOpen(!filesOpen)}>
          <Icon name="list" />
        </IconButton>
        <IconButton label={`Toggle inspector (${actionKeys('panel.inspector')})`} active={worktreePanels.inspector} onClick={() => worktreePanels.toggle('inspector')}>
          <Icon name="panel" className="size-3.5 -scale-x-100" />
        </IconButton>
      </header>

      <div className="flex min-h-0 flex-1">
        {dockFrame('left')}

        {!worktree ? (
          <EmptyState fill icon="branch" title="Select a worktree to see its changes" />
        ) : (
          <div className="flex min-w-0 flex-1">
            {filesOpen && (
              <nav style={{ width: filesWidth }} className="relative shrink-0 border-r border-border bg-card">
                <div className="h-full overflow-y-auto p-1.5">
                  <div className="flex h-7 items-center gap-2 pl-2 text-[10.5px] font-medium tracking-wide text-muted-foreground uppercase">
                    <span>Changes</span>
                    <span className="tabular-nums">{files.length}</span>
                    <span className="flex-1" />
                    {canFoldChanges && <FoldAllButton anyOpen={anyChangedFolderOpen} groups="folders" onClick={foldChanges} />}
                  </div>
                  {!patches && <Placeholder>Loading...</Placeholder>}
                  <ChangedFileList
                    patches={files}
                    activePath={viewer ? null : filePath}
                    onOpen={showDiff}
                    onFileMenu={changedFileMenu}
                    toggles={folderToggles}
                    badge={(path) => worktreeComments.some((comment) => comment.filePath === path) && <Icon name="comment" className="size-3 text-muted-foreground" />}
                  />
                </div>
                <ResizeHandle width={filesWidth} min={180} max={520} onResize={setFilesWidth} />
              </nav>
            )}

            <main className="relative flex min-w-0 flex-1 flex-col">
              <ErrorBoundary label={viewer ? baseName(viewer.path) : 'Diff'} resetKey={`${selected}:${viewer?.path ?? filePath}`}>
                <MarkdownFoldScope>
                  {viewer && (
                    <>
                      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-1.5">
                        <div className="flex h-full min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]">
                          {editorTabs.map((tab) => (
                            <div
                              key={tab}
                              title={tab}
                              onMouseDown={(event) => event.button === 1 && closeEditorTab(tab)}
                              onContextMenu={(event) =>
                                tabMenu(event, () => closeEditorTab(tab), () => {
                                  setEditorTabs([tab])
                                  setViewer({ path: tab, line: null })
                                })
                              }
                              className={`flex h-6 max-w-52 shrink-0 items-center gap-1.5 rounded-md pr-1 pl-2 text-xs ${
                                tab === viewer.path ? 'bg-foreground/8 text-foreground ring-1 ring-border' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                              }`}
                            >
                              <button onClick={() => setViewer({ path: tab, line: null })} className="flex min-w-0 items-center gap-1.5">
                                <FileIcon path={tab} />
                                <span className="truncate">{baseName(tab)}</span>
                              </button>
                              <button aria-label={`Close ${baseName(tab)}`} title="Close (⌘W)" onClick={() => closeEditorTab(tab)} className="grid size-4 shrink-0 place-items-center rounded hover:bg-accent">
                                <Icon name="close" className="size-2.5" />
                              </button>
                            </div>
                          ))}
                        </div>
                        <CopyButton label="Copy path (y)" text={() => `${worktree.path}/${viewer.path}`} />
                        {changedPaths.has(viewer.path) && (
                          <button
                            title="Back to the diff (esc)"
                            onClick={() => showDiff(viewer.path)}
                            className="flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-[11px] text-muted-foreground ring-1 ring-border hover:text-foreground"
                          >
                            Diff
                            <Kbd hint>esc</Kbd>
                          </button>
                        )}
                        {isMarkdownPath(viewer.path) && <PreviewToggle on={markdownPreview} onChange={setMarkdownPreview} />}
                        <IconButton label="Close all files" onClick={() => (setEditorTabs([]), setViewer(null))}>
                          <Icon name="close" className="size-3" />
                        </IconButton>
                      </div>
                      {markdownPreview && isMarkdownPath(viewer.path) ? (
                        <div className="min-h-0 flex-1 overflow-auto">
                          {/* Keyed by reload so a save from the editor or an agent shows up after toggling back */}
                          <MarkdownPreview loadKey={`${worktree.path}:${viewer.path}:${fileReload}`} load={() => window.api.readFile(worktree.path, viewer.path)} />
                        </div>
                      ) : (
                        fileView(worktree.path, viewer.path, viewer.line)
                      )}
                    </>
                  )}
                  {!viewer && !file && patches?.length === 0 && (
                    <EmptyState fill icon="check" title="Working tree clean">
                      <KeyHintLabel hint={['t', 'terminal']} />
                      <KeyHintLabel hint={[actionKeys('wt.findFile'), 'find a file']} />
                    </EmptyState>
                  )}
                  {!viewer && file && (
                    <>
                      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
                        <span className="min-w-0 shrink truncate font-mono text-[11.5px] text-foreground/85 select-text" title={file.path}>
                          {file.path}
                        </span>
                        <span className="shrink-0 font-mono text-[11px] whitespace-nowrap tabular-nums">
                          <span className="text-emerald-400">+{file.additions}</span> <span className="text-red-400">−{file.deletions}</span>
                        </span>
                        <CopyButton label="Copy path (y)" text={() => `${worktree.path}/${file.path}`} />
                        <span className="min-w-2 flex-1" />
                        {isMarkdownPath(file.path) && <PreviewToggle on={markdownPreview} onChange={setMarkdownPreview} />}
                        {/* The diff is for reading and commenting; editing happens in the file itself */}
                        <button
                          title="Open the file to edit (o)"
                          onClick={() => setViewer({ path: file.path, line: cursorFileLine() })}
                          className="flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-[11px] text-muted-foreground ring-1 ring-border hover:text-foreground"
                        >
                          <Icon name="pencil" className="size-3" />
                          Edit
                          <Kbd hint>o</Kbd>
                        </button>
                      </div>
                      {markdownPreview && isMarkdownPath(file.path) ? (
                        <div className="min-h-0 flex-1 overflow-auto">
                          <MarkdownPreview loadKey={`${worktree.path}:${file.path}`} load={() => window.api.readFile(worktree.path, file.path)} />
                        </div>
                      ) : (
                        <div
                          ref={diffScroll}
                          className={`min-h-0 flex-1 overflow-auto ${drag.range ? 'select-none' : 'select-text'}`}
                          onPointerDown={drag.onPointerDown}
                          onContextMenu={diffSymbols.onContextMenu}
                        >
                          <PatchDiff
                            key={file.path}
                            patch={file.patch}
                            className="block"
                            style={diffBackground()}
                            lineAnnotations={lineAnnotations}
                            selectedLines={drag.range ?? draft ?? (cursorRow ? rowRange(cursorRow) : null)}
                            renderAnnotation={({ metadata }) => {
                              const comment = fileComments.find((candidate) => candidate.id === metadata.commentId)
                              if (comment) return <CommentCard comment={comment} onDelete={() => deleteComment(comment)} />
                              return draft ? <CommentDraft label={`Agent comment on line ${rangeLabel(draft)}`} onSave={addComment} onCancel={() => setDraft(null)} /> : null
                            }}
                            options={{
                              ...codeThemeOptions(),
                              diffStyle,
                              disableFileHeader: true,
                              enableLineSelection: true,
                              enableGutterUtility: true,
                              onGutterUtilityClick: (range) => setDraft(orderRange(range)),
                              onLineSelectionEnd: (range) => range && setDraft(orderRange(range)),
                              onLineEnter: (line) => drag.enterLine({ lineNumber: line.lineNumber, side: line.annotationSide }),
                              ...diffSymbols.tokenOptions
                            }}
                          />
                          {diffSymbols.hoverCard}
                        </div>
                      )}
                    </>
                  )}
                </MarkdownFoldScope>
              </ErrorBoundary>
            </main>
          </div>
        )}

        {dockFrame('right')}
      </div>

      {settings.bottomPanel === 'content' && dockFrame('bottom')}
      {draggingPanel && (
        <DropZones
          onDrop={(side) => {
            dock.move(draggingPanel, side)
            setDraggingPanel(null)
          }}
        />
      )}
    </div>
  )

  const worktreeView = (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageLayout
        listLabel="Worktrees"
        inspectorLabel="Explorer"
        hints={{
          list: [['n', 'new'], ['t', 'terminal'], ['/', 'filter']],
          main: [['n p', 'file'], ['j k', 'line'], ['c', 'comment'], ['o', 'open'], ['w', 'split'], ['t', 'terminal']],
          inspector: [['h l', 'fold'], ['/', 'filter']]
        }}
        list={
          <Sidebar
            repos={workspaceRepos}
            scanning={scanning}
            selected={selected}
            activity={activity}
            scope={scope}
            onSelect={setSelected}
            onRescan={rescan}
            onRepoMenu={repoMenu}
            onWorktreeMenu={worktreeMenu}
            onBranchMenu={branchMenu}
            onOpenBranch={(branch, repo) => openBranch(branch, repo)}
            onNewWorktree={(repo) => setBranchDialog({ repo, worktree: true })}
            onTerminal={openTerminal}
            onFlash={flash}
            folderFilter={!workspace}
          />
        }
        main={worktreeMain}
        inspector={worktreeInspector}
      />
      {settings.bottomPanel === 'full' && dockFrame('bottom')}
    </div>
  )

  return (
    <HostContext.Provider value={host}>
    <CodeNavigationContext.Provider value={{ worktreePath: selected ?? '', exact: true, onNavigate: navigate }}>
    <div className="flex h-screen flex-col overflow-hidden bg-background font-sans text-foreground antialiased select-none">
      {showTitle && (
      <div
        className={`flex h-9 shrink-0 items-center gap-0.5 border-b border-border bg-card pr-2 ${chromeless ? 'pl-2' : 'pl-[88px] [-webkit-app-region:drag]'}`}
      >
        {tabs.map((tab, index) => {
          const letter = leaderOf(tab.id)?.toUpperCase()
          const keys = [letter && `G ${letter}`, digitLabel('tabs', index + 1)].filter(Boolean).join(', ')
          return (
            <button key={tab.id} title={keys ? `${tab.label} (${keys})` : tab.label} onClick={() => goPage(tab.id)} className={tabClass(appTab === tab.id)}>
              {shell.leader && letter ? <Kbd on>{letter}</Kbd> : <Icon name={tab.icon} className="size-3.5" />}
              {tab.label}
              {'Badge' in tab && tab.Badge && <tab.Badge />}
            </button>
          )
        })}
        {docTabs.map((tab) => (
          <div
            key={tab.key}
            className={tabClass(appTab === tab.key)}
            onContextMenu={(event) =>
              tabMenu(
                event,
                () => closeTab(tab.key),
                () => {
                  setDocTabs([tab])
                  setAppTab(tab.key)
                }
              )
            }
          >
            <button onClick={() => setAppTab(tab.key)} className="flex min-w-0 items-center gap-1.5">
              {tab.icon}
              <span className="truncate">{tab.title}</span>
            </button>
            <button aria-label="Close tab" onClick={() => closeTab(tab.key)} className="text-muted-foreground hover:text-foreground">
              <Icon name="close" className="size-3" />
            </button>
          </div>
        ))}
        <span className="flex-1" />
        {titleBarItems(false)}
        <button
          title={`Search commands, worktrees and files (${actionKeys('app.palette')})`}
          onClick={() => setPaletteOpen(true)}
          // A container, so a narrow window shortens the label instead of wrapping it
          className="@container ml-1 flex h-6 w-60 min-w-28 items-center gap-2 rounded-md bg-muted px-2 text-xs text-muted-foreground ring-1 ring-border hover:text-foreground [-webkit-app-region:no-drag]"
        >
          <Icon name="search" className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-left whitespace-nowrap">
            <span className="@max-[14rem]:hidden">Search or run a command</span>
            <span className="hidden @max-[14rem]:inline">Search</span>
          </span>
          <Kbd hint>{actionKeys('app.palette')}</Kbd>
        </button>
        {/* Dock panels for this tab: all of them in Worktrees, the ones a plugin tab asks for elsewhere */}
        {(appTab === 'worktrees' ? panelIds : (activePluginTab?.panels ?? openDocTab?.panels ?? []).filter((id) => panelIds.includes(id))).map((panel) => {
          const info = panelInfo(panel)
          const Badge = pluginPanels.find((candidate) => candidate.id === panel)?.Badge
          return info ? (
            <PanelToggle
              key={panel}
              id={panel}
              info={info}
              active={dock.isVisible(panel)}
              side={dock.sideOf(panel)}
              badge={Badge && <Badge />}
              onToggle={() => dock.toggle(panel)}
              onMove={(side) => dock.move(panel, side)}
              onDragStart={() => startPanelDrag(panel)}
              onDragEnd={() => setDraggingPanel(null)}
            />
          ) : null
        })}
        <button
          title={`Agent comments (${actionKeys('app.comments')})`}
          onClick={() => setDrawerOpen(!drawerOpen)}
          className={`flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs hover:bg-accent hover:text-foreground [-webkit-app-region:no-drag] ${drawerOpen ? 'bg-foreground/8 text-foreground ring-1 ring-border' : comments.length > 0 ? 'text-foreground' : 'text-muted-foreground'}`}
        >
          <Icon name="comment" />
          {comments.length > 0 && <span className="tabular-nums">{comments.length}</span>}
          <Kbd hint>{actionKeys('app.comments')}</Kbd>
        </button>
        <IconButton label={`Settings (${actionKeys('app.settings')} or G S)`} active={appTab === 'settings'} onClick={() => (appTab === 'settings' ? closeSettings() : openSettings())}>
          <Icon name="settings" />
        </IconButton>
        {titleBarItems(true)}
      </div>
      )}

      {/* Without the title bar the window still needs somewhere to drag it by, and room for the traffic lights */}
      {!showTitle && !chromeless && <div className="h-7 shrink-0 border-b border-border bg-card [-webkit-app-region:drag]" />}
      <div className="flex min-h-0 flex-1">
      {showRail && <WorkspaceRail repos={repos} onSwitch={switchWorkspace} onEdit={setEditingWorkspace} />}
      <Zone id="main" className="flex-1">
      {/* Keyed by workspace so each tab remounts with that workspace's own filters, searches and selection */}
      <div key={workspaceId} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <ErrorBoundary label={appTabLabel} resetKey={`${workspaceId}:${appTab}`}>
      {appTab === 'worktrees' && worktreeView}
      <Suspense fallback={<div className="flex-1" />}>
      {appTab === 'settings' && <SettingsView onClose={closeSettings} />}
      {activePluginTab &&
        (activePluginTab.panels?.length ? (
          <TabDock placement={settings.bottomPanel} withDock={withDock}>
            <activePluginTab.render />
          </TabDock>
        ) : (
          <activePluginTab.render />
        ))}
      {openDocTab && (
        <TabDock placement={settings.bottomPanel} withDock={withDock}>
          {openDocTab.content}
        </TabDock>
      )}
      </Suspense>
      </ErrorBoundary>
      </div>
      </Zone>
      </div>
      {shell.status && !shell.zen && <StatusBar workspace={workspace ?? { name: scopeLabel }} pageLabel={appTabLabel} />}
      <WhichKey
        pages={[...tabs, { id: 'settings', label: 'Settings', icon: 'settings' as const }].flatMap((tab) => {
          const letter = leaderOf(tab.id)
          return letter ? [{ letter, label: tab.label, icon: tab.icon }] : []
        })}
        workspaces={workspaces.map((candidate) => candidate.name)}
      />
      {sheetOpen && <ShortcutSheet onClose={() => setSheetOpen(false)} />}
      {drawerOpen && (
        <AgentCommentsDrawer
          comments={comments}
          labelOf={checkoutLabel}
          top={showTitle ? 36 : chromeless ? 0 : 28}
          bottom={shell.status && !shell.zen ? 24 : 0}
          renderSend={(path, active) => commentsSendButton(path, 'panel', active)}
          onOpen={(comment) => {
            if (comment.kind === 'reference') return
            if (comment.kind === 'browser') return openPage(comment.filePath)
            const line = comment.range.start > 0 ? comment.range.start : null
            if (comment.kind === 'file') return openLocation(comment.worktreePath, comment.filePath, line)
            setAppTab('worktrees')
            if (comment.worktreePath !== selected) {
              pendingFilePath.current = comment.filePath
              return setSelected(comment.worktreePath)
            }
            showDiff(comment.filePath)
          }}
          onOpenWorktree={openWorktree}
          onDelete={deleteComment}
          onClearAll={() => window.confirm(`Delete all ${comments.length} agent comments in this workspace?`) && setComments([])}
          onClose={() => setDrawerOpen(false)}
        />
      )}
      {shell.zen && (
        <button onClick={toggleZen} title={`Leave zen mode (${actionKeys('shell.zen')})`} className="fixed right-3 bottom-3 z-50 flex items-center gap-2 rounded-md border border-border bg-popover px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground">
          Zen <Kbd hint>{actionKeys('shell.zen')}</Kbd>
        </button>
      )}

      {notice && (
        <div className="fixed bottom-4 left-1/2 z-50 max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-full border border-border bg-card px-3.5 py-1.5 text-xs text-foreground shadow-lg shadow-black/40">
          {notice}
        </div>
      )}
      {!updateDismissed && !shell.zen && <UpdateBanner onDismiss={() => setUpdateDismissed(true)} />}
      <Suspense fallback={null}>
        {paletteOpen && <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} />}
      </Suspense>
      <Tooltips />
      {plugins.map(({ manifest, plugin }) =>
        plugin.Root ? (
          <ErrorBoundary key={manifest.id} label={manifest.name} resetKey={manifest.id}>
            <plugin.Root />
          </ErrorBoundary>
        ) : null
      )}
      {editingWorkspace !== undefined && (
        <WorkspaceDialog
          workspace={editingWorkspace}
          repos={repos}
          onClose={() => setEditingWorkspace(undefined)}
          onSaved={(saved) => {
            setEditingWorkspace(undefined)
            switchWorkspace(saved.id)
          }}
        />
      )}
      {historyFor && (
        <HistoryDialog
          {...historyFor}
          onRestored={() => {
            setFileReload((count) => count + 1)
            loadWorktree(historyFor.worktreePath)
          }}
          onClose={() => setHistoryFor(null)}
        />
      )}
      {prompt && <TextPrompt {...prompt} onClose={() => setPrompt(null)} />}
      {branchDialog && (
        <BranchDialog
          repo={branchDialog.repo}
          initialWorktree={branchDialog.worktree}
          initialBase={branchDialog.base}
          onSubmit={submitBranch}
          onClose={() => setBranchDialog(null)}
        />
      )}
      <Suspense fallback={null}>
        {searchOpen && (
          <SearchDialog
            worktreePaths={searchPaths}
            scopeLabel={scopeLabel}
            renderPreview={(location) => fileView(location.worktreePath, location.path, location.line, true)}
            onClose={() => setSearchOpen(false)}
            onPick={(location) => {
              setSearchOpen(false)
              openLocation(location.worktreePath, location.path, location.line)
            }}
          />
        )}
        {/* After search so a references lookup from a search preview opens on top of it */}
        {peek && (
          <LocationsDialog
            header={
              <span className="min-w-0 flex-1 truncate">
                {peek.title} <span className="font-mono text-foreground">{peek.symbol}</span> · {peek.locations.length} in{' '}
                {new Set(peek.locations.map((location) => location.path)).size} files
              </span>
            }
            locations={peek.locations}
            matcher={matcherFor(peek.symbol, { caseSensitive: true, wholeWord: true, regex: false })}
            renderPreview={(location) => fileView(location.worktreePath, location.path, location.line, true)}
            onClose={() => setPeek(null)}
            onPick={(location) => {
              setPeek(null)
              openLocation(location.worktreePath, location.path, location.line)
            }}
          />
        )}
      </Suspense>
    </div>
    </CodeNavigationContext.Provider>
    </HostContext.Provider>
  )
}

export default App
