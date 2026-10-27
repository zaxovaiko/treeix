import { lazy, Suspense, useEffect, useEffectEvent, useLayoutEffect, useReducer, useRef, useState } from 'react'
import { emit } from '@tauri-apps/api/event'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import type { Api, Place, SessionEvent, SessionInfo, SessionKind } from '../ipc/api'
import { applyOpacity, applyTheme } from '../styles/theme'
import { Icon } from '../lib/icons'
import { IN_TAURI, onMenuItem, pickFolder, registerQuickShortcut, setWindowBlur, setZoom, UI_CHANGED } from '../lib/native'
import { groupTabs, initialUi, leaves, neighbor, newTabId, parseUi, reducer, restore, tabPlace, zoomed, type Action, type Group, type SplitDir, type Tab, type UiState } from './state'
import { fallbackPlace, GroupColors, SETTINGS_LEAF, type Sessions } from './model'
import { IS_MAC, isCommandId, menuChord, shortcutsPaused, type CommandId } from './shortcuts'
import { CenterTop, HStrip, Sidebar, SidebarResize, StatusBar, TitleBar, Welcome } from './Chrome'
import { followedMode, RELEASES, showSettingsSection, useAppliedSettings } from '../pages/settings'
import { settingsNow } from '../features/agents/settings'
import { toggleRecording } from '../features/voice'
import { useBrowserAgentPanes } from '../features/browser/open'
import { resolveShortcut } from '../lib/hotkeys'
import { openAbsolute, TabPanes } from './Panes'
import { Palette } from './Palette'
import { Dialogs, useDialogKeys, type DialogRequest } from '../dialogs'
import { paneGrid } from '../panes/terminal/xterm'
import { Panels } from '../panels/Panels'
import { reopenSession } from '../panels/common'
import { isFileLeaf, leafRoot, openFile } from '../panes/file/open'
import { chatLeaf, isChatLeaf, leafChat } from '../panes/chat/open'
import { getChat, initChats, useChatsVersion } from '../panes/chat/store'

const PERSIST_MS = 300
const AGENT_COMMAND: Partial<Record<SessionKind, string[]>> = { claude: ['claude'], codex: ['codex'] }
const GONE = new Set(['exited', 'restored', 'crashed'])
/** Reconnecting this long turns the banner into "can't reach" with a Retry */
const UNREACHABLE_MS = 15_000

/** What the chrome components read and call */
export interface ShellView {
  api: Api
  ui: UiState
  dispatch: (action: Action) => void
  sessions: Sessions
  home: string
  groups: Group[]
  /** Tabs in sidebar order */
  ordered: Tab[]
  activeTab: Tab | undefined
  placeOf: (session: string) => Place
  placeOfTab: (tab: Tab) => Place
  run: (id: CommandId) => void
  newSession: (kind: SessionKind, cwd?: string) => void
  split: (dir: SplitDir, from?: string) => void
  closePane: (session: string) => void
  closeTab: (tab: Tab) => void
  openDialog: (request: DialogRequest) => void
  /** Opens `file` (relative to `root`) in the file view, at a 1-based line and 0-based column when given */
  openFile: (root: string, file: string, line?: number, column?: number) => void
}

const GraphPage = lazy(() => import('../features/graph').then((m) => ({ default: m.GraphPage })))

const byId = (list: SessionInfo[]): Sessions => Object.fromEntries(list.map((s) => [s.id, s]))
/** Chat leaves a restore keeps; none when ptyd can't list chats */
const openChats = (api: Api): Promise<string[]> => api.chatList().then((list) => list.map((chat) => chatLeaf(chat.id)), () => [])
/** Where a leaf that is not a session works: a chat's cwd, a file view's place */
const leafCwd = (leaf: string): string | undefined => (isChatLeaf(leaf) ? getChat(leafChat(leaf)).info?.cwd : isFileLeaf(leaf) ? leafRoot(leaf) : undefined)

export function Shell({ api }: { api: Api }) {
  const [ui, dispatch] = useReducer(reducer, initialUi)
  const [loaded, setLoaded] = useState(false)
  const [sessions, setSessions] = useState<Sessions>({})
  /** Resolved places by cwd */
  const [places, setPlaces] = useState<Record<string, Place>>({})
  const [home, setHome] = useState('/')
  const [connected, setConnected] = useState(true)
  /** The first load failed, or reconnecting has taken longer than UNREACHABLE_MS */
  const [unreachable, setUnreachable] = useState(false)
  /** Bumped on reconnect so every terminal re-attaches */
  const [epoch, setEpoch] = useState(0)
  const [palette, setPalette] = useState(false)
  const [page, setPage] = useState<'graph' | null>(null)
  const [dialog, setDialog] = useState<DialogRequest | null>(null)
  useDialogKeys(setDialog)
  const resolving = useRef(new Set<string>())
  useEffect(() => initChats(api), [api])
  // Chat tabs take their title, icon and place from the chat store
  useChatsVersion()
  /** Panes closed while their process still ran; forgotten once it exits */
  const closing = useRef(new Set<string>())

  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let cancelled = false
    Promise.all([api.getUi(), api.sessions(), api.homeDir(), openChats(api)]).then(
      ([json, list, homeDir, chats]) => {
        if (cancelled) return
        const saved = parseUi(json)
        setHome(homeDir)
        setSessions(byId(list))
        dispatch({ type: 'load', ui: restore({ ...saved, theme: followedMode(saved.theme) }, list, [...chats, SETTINGS_LEAF]) })
        setUnreachable(false)
        setLoaded(true)
        if (saved.quickShortcut) registerQuickShortcut(saved.quickShortcut, saved.quickWholeApp).catch((e: unknown) => console.warn('quick terminal shortcut:', e))
      },
      () => !cancelled && setUnreachable(true)
    )
    return () => {
      cancelled = true
    }
  }, [api, attempt])

  useEffect(() => {
    if (connected) return setUnreachable(false)
    const timer = setTimeout(() => setUnreachable(true), UNREACHABLE_MS)
    return () => clearTimeout(timer)
  }, [connected])

  /** After a daemon restart: re-list, keep the layout, re-attach every terminal. The quick window may have a new session by now */
  const resync = () =>
    Promise.all([api.sessions(), api.getUi(), openChats(api)]).then(([list, json, chats]) => {
      setSessions(byId(list))
      dispatch({ type: 'load', ui: restore({ ...ui, quick: parseUi(json).quick }, list, [...chats, SETTINGS_LEAF]) })
      setEpoch((n) => n + 1)
      setConnected(true)
    })
  const retry = () => (loaded ? void resync().catch(() => setUnreachable(true)) : setAttempt((n) => n + 1))

  const patch = (id: string, change: Partial<SessionInfo>) => setSessions((all) => (all[id] ? { ...all, [id]: { ...all[id], ...change } } : all))

  const onEvent = useEffectEvent((e: SessionEvent) => {
    switch (e.type) {
      case 'status':
        return patch(e.session, { status: e.status })
      case 'title':
        return patch(e.session, { title: e.title })
      case 'cwd':
        return patch(e.session, { cwd: e.cwd })
      case 'kind':
        patch(e.session, { kind: e.kind })
        // An agent started in a shell this window has no tab for (the quick terminal's) joins the sidebar
        if ((e.kind === 'claude' || e.kind === 'codex') && !ui.tabs.some((tab) => leaves(tab.root).includes(e.session))) dispatch({ type: 'open', session: e.session, tabId: newTabId(), background: true })
        return
      case 'exit':
        patch(e.session, { status: 'exited', exitCode: e.code })
        // A clean shell exit closes its pane; a failed one stays to show why. Closed panes are forgotten either way
        if (closing.current.delete(e.session) || (e.code === 0 && sessions[e.session]?.kind === 'shell')) void api.remove(e.session)
        return
      case 'removed':
        dispatch({ type: 'remove', session: e.session })
        setSessions(({ [e.session]: _, ...rest }) => rest)
        return
      case 'created':
        // Listed only: tabs open where the session was asked for (this window, the quick terminal, later routines)
        setSessions((all) => ({ ...all, [e.info.id]: e.info }))
        return
      case 'daemon':
        if (e.state === 'connected') resync().catch(() => setUnreachable(true))
        else setConnected(false)
    }
  })
  useEffect(() => api.onEvent(onEvent), [api])

  const leafCwds = ui.tabs.flatMap((tab) => leaves(tab.root)).flatMap((leaf) => leafCwd(leaf) ?? [])
  useEffect(() => {
    const cwds = [...new Set([...Object.values(sessions).map((s) => s.cwd), ...leafCwds])].filter((cwd) => !places[cwd] && !resolving.current.has(cwd))
    if (!cwds.length) return
    cwds.forEach((cwd) => resolving.current.add(cwd))
    void api
      .places(cwds)
      .then((found) => setPlaces((all) => ({ ...all, ...Object.fromEntries(cwds.map((cwd, i) => [cwd, found[i]] as const).filter(([, p]) => p)) })))
      .finally(() => cwds.forEach((cwd) => resolving.current.delete(cwd)))
  }, [api, sessions, places, leafCwds.join('\n')])

  const placeOf = (session: string): Place => {
    const cwd = sessions[session]?.cwd ?? leafCwd(session) ?? home
    return places[cwd] ?? fallbackPlace(cwd, home)
  }
  const placeOfTab = (tab: Tab): Place => {
    const key = tabPlace(tab, placeOf)
    return (key && Object.values(places).find((p) => p.key === key)) || placeOf(tab.focus)
  }
  const groups = groupTabs(ui.tabs, placeOfTab, ui.groupOrder)
  const ordered = groups.flatMap((g) => g.places.flatMap((p) => p.tabs))
  const activeTab = ui.tabs.find((t) => t.id === ui.active)
  const tabPlaces = ordered.map(placeOfTab)
  const seen = useEffectEvent(() => {
    dispatch({ type: 'groups', keys: groups.map((g) => g.key) })
    dispatch({ type: 'recent', places: tabPlaces })
  })
  const placesKey = tabPlaces.map((p) => p.path).join('\n')
  useEffect(() => {
    if (loaded) seen()
  }, [loaded, placesKey])

  useEffect(() => {
    if (!loaded) return
    const timer = setTimeout(async () => {
      // The quick terminal window owns `quick`; keep what it wrote
      const stored = parseUi(await api.getUi())
      await api.putUi(JSON.stringify({ ...ui, quick: stored.quick }))
    }, PERSIST_MS)
    return () => clearTimeout(timer)
  }, [api, ui, loaded])

  // Before the terminals mount, so they open with the right colors
  useLayoutEffect(() => applyTheme(ui.theme, ui.ui), [ui.theme, ui.ui])
  // Only the Mac window is transparent (lib.rs); elsewhere a see-through page would show the webview's own fill
  const opacity = IN_TAURI && IS_MAC ? ui.windowOpacity : 1
  const blur = ui.windowBlur && opacity < 1
  useLayoutEffect(() => applyOpacity(opacity), [opacity])
  useEffect(() => void setWindowBlur(blur).catch((e: unknown) => console.warn('window blur:', e)), [blur])
  useAppliedSettings(api, ui.theme, (theme) => dispatch({ type: 'set', patch: { theme } }))
  useBrowserAgentPanes({ api, dispatch, activeTab, placeOfTab })
  useEffect(() => {
    if (loaded && IN_TAURI) void emit(UI_CHANGED, { theme: ui.theme, ui: ui.ui, renderer: ui.renderer, zoom: ui.zoom, quickAnimate: ui.quickAnimate, quickOpacity: ui.quickOpacity, quickBlur: ui.quickBlur })
  }, [loaded, ui.theme, ui.ui, ui.renderer, ui.zoom, ui.quickAnimate, ui.quickOpacity, ui.quickBlur])
  useEffect(() => void setZoom(ui.zoom).catch((e: unknown) => console.warn('zoom:', e)), [ui.zoom])

  const focusCwd = () => (activeTab ? (sessions[activeTab.focus]?.cwd ?? home) : home)

  /** Created at the size of the pane it opens in, so its first output isn't drawn for another width */
  const create = async (kind: SessionKind, cwd: string, box: { width: number; height: number } = stageBox()) => {
    const info = await api.create({ kind, cwd, command: AGENT_COMMAND[kind], ...paneGrid(box.width, box.height) })
    setSessions((all) => ({ ...all, [info.id]: info }))
    return info
  }

  const newSession = (kind: SessionKind, cwd = focusCwd()) => {
    setPage(null)
    void create(kind, cwd).then((info) => dispatch({ type: 'open', session: info.id, tabId: newTabId() }))
  }

  const split = (dir: SplitDir, from = activeTab?.focus) => {
    if (!activeTab || !from) return newSession('shell')
    dispatch({ type: 'focus', session: from })
    const place = placeOfTab(activeTab).key
    const box = paneBox(from) ?? stageBox()
    const half = dir === 'row' ? { width: box.width / 2, height: box.height } : { width: box.width, height: box.height / 2 }
    void create('shell', sessions[from]?.cwd ?? home, half).then((info) => dispatch({ type: 'split', session: info.id, dir, place }))
  }

  const closePane = (session: string) => {
    dispatch({ type: 'remove', session })
    if (session === SETTINGS_LEAF) return
    const info = sessions[session]
    if (!info || GONE.has(info.status)) void api.remove(session)
    else {
      closing.current.add(session)
      void api.kill(session)
    }
  }
  const closeTab = (tab: Tab) => leaves(tab.root).forEach(closePane)

  /** The newest closed session, resumed where it ran; routine runs closed on their own and stay in History */
  const reopenLast = async () => {
    const [last] = (await api.sessionHistory()).filter((r) => !r.run).sort((a, b) => b.closedAt - a.closedAt)
    if (!last) return
    await reopenSession(view, last)
    await api.forgetSession(last.id)
  }

  const activateAt = (index: number) => {
    const tab = ordered[index]
    if (tab) dispatch({ type: 'activate', tabId: tab.id })
  }
  const cycle = (by: number) => activateAt((ordered.findIndex((t) => t.id === ui.active) + by + ordered.length) % ordered.length)

  const run = (id: CommandId) => {
    setPalette(false)
    if (id.startsWith('tab-')) return activateAt(Number(id.slice(4)) - 1)
    if (id.startsWith('focus-')) {
      const dir = id.slice(6)
      const next = activeTab && (dir === 'left' || dir === 'right' || dir === 'up' || dir === 'down') ? neighbor(activeTab.root, activeTab.focus, dir) : null
      if (next) dispatch({ type: 'focus', session: next })
      return
    }
    switch (id) {
      case 'new-shell':
        return newSession('shell')
      case 'new-claude':
        return newSession('claude')
      case 'new-codex':
        return newSession('codex')
      case 'open-folder':
        return void pickFolder(home).then((dir) => dir && newSession('shell', dir))
      case 'split-right':
        return split('row')
      case 'split-down':
        return split('col')
      case 'close-pane':
        if (page) return setPage(null)
        if (activeTab) closePane(activeTab.focus)
        return
      case 'reopen-tab':
        setPage(null)
        return void reopenLast().catch((e: unknown) => console.warn('reopen:', e))
      case 'next-tab':
        return cycle(1)
      case 'prev-tab':
        return cycle(-1)
      case 'palette':
        return setPalette(true)
      case 'toggle-sidebar':
        return dispatch({ type: 'set', patch: { sidebar: !ui.sidebar } })
      case 'settings':
        setPage(null)
        return dispatch(ui.tabs.some((tab) => leaves(tab.root).includes(SETTINGS_LEAF)) ? { type: 'focus', session: SETTINGS_LEAF } : { type: 'open', session: SETTINGS_LEAF, tabId: newTabId() })
      case 'module-graph':
        if (!settingsNow()?.features.graph || !activeTab || placeOfTab(activeTab).kind === 'scratch') return
        return setPage(page === 'graph' ? null : 'graph')
      case 'record':
        if (settingsNow()?.features.recording) void toggleRecording(api).catch((e: unknown) => console.warn('recording:', e))
        return
      case 'zoom-in':
        return dispatch({ type: 'set', patch: { zoom: zoomed(ui.zoom, 1) } })
      case 'zoom-out':
        return dispatch({ type: 'set', patch: { zoom: zoomed(ui.zoom, -1) } })
      case 'zoom-reset':
        return dispatch({ type: 'set', patch: { zoom: 1 } })
      case 'toggle-tabs':
        return dispatch({ type: 'set', patch: { orientation: ui.orientation === 'vertical' ? 'horizontal' : 'vertical' } })
      case 'toggle-ui':
        return dispatch({ type: 'set', patch: { ui: ui.ui === 'compact' ? 'islands' : 'compact' } })
      case 'toggle-theme':
        // A picked mode stops following the OS, else the next launch or OS switch undoes it
        if (settingsNow()?.appearance.followSystem) void api.updateSettings({ appearance: { followSystem: false } }).catch((e: unknown) => console.warn('settings:', e))
        return dispatch({ type: 'set', patch: { theme: ui.theme === 'dark' ? 'light' : 'dark' } })
    }
  }

  const onKey = useEffectEvent((e: KeyboardEvent) => {
    if (shortcutsPaused()) return
    const keys = settingsNow()?.keys ?? {}
    const id = resolveShortcut(e, keys)
    if (!id) return
    // The menu runs it; the pane under focus (editor, terminal) must not take the keys too
    if (IN_TAURI && menuChord(e, keys)) return e.stopPropagation()
    e.preventDefault()
    e.stopPropagation()
    run(id)
  })
  useEffect(() => {
    const handler = (e: KeyboardEvent) => onKey(e)
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [])

  const onMenu = useEffectEvent((id: string) => {
    if (shortcutsPaused()) return
    if (isCommandId(id)) return run(id)
    if (id === 'shortcuts') {
      run('settings')
      return showSettingsSection('keys')
    }
    if (id === 'changelog') void api.openUrl(RELEASES)
  })
  useEffect(() => onMenuItem(onMenu), [])

  // Files dropped anywhere but a terminal (which types their paths) open in the file view
  const onDrop = useEffectEvent((paths: string[]) => {
    const opener = { api, openFile: (root: string, file: string, line?: number) => openFile({ ui, dispatch }, root, file, line) }
    for (const path of paths) void openAbsolute(opener, path)
  })
  useEffect(() => {
    if (!IN_TAURI) return
    const stop = getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type !== 'drop') return
      const { x, y } = payload.position.toLogical(window.devicePixelRatio)
      if (!document.elementFromPoint(x, y)?.closest('.term')) onDrop(payload.paths)
    })
    return () => void stop.then((unlisten) => unlisten())
  }, [])

  if (!loaded)
    return (
      <div className="win">
        {unreachable ? (
          <Unreachable onRetry={retry} />
        ) : (
          // Fades in late, so only a slow terminal host shows it and a normal start never flashes it
          <div className="welcome starting">
            <p className="dim">Starting the terminal host...</p>
          </div>
        )}
      </div>
    )

  const view: ShellView = { api, ui, dispatch, sessions, home, groups, ordered, activeTab, placeOf, placeOfTab, run, newSession, split, closePane, closeTab, openDialog: setDialog, openFile: (root, file, line, column) => openFile({ ui, dispatch }, root, file, line, column) }
  const vertical = ui.orientation === 'vertical'
  const tabsInTitle = !vertical && ui.ui === 'compact'
  const empty = ui.tabs.length === 0

  return (
    <GroupColors value={ui.colors}>
      <div className="win">
        <TitleBar view={view} tabbed={tabsInTitle && !empty} />
        {!connected && (
          <div className="offline">
            <Icon name="alert" />
            {unreachable ? "Can't reach the terminal host" : 'Reconnecting to the terminal host...'}
            {unreachable && (
              <button className="btn sm" onClick={retry}>
                Retry
              </button>
            )}
          </div>
        )}
        <div className="body">
          {vertical && ui.sidebar && (
            <>
              <aside className="card side" style={{ width: ui.sidebarWidth }}>
                <Sidebar view={view} />
              </aside>
              <SidebarResize view={view} />
            </>
          )}
          {!vertical && <Panels view={view} hidden={page !== null} />}
          <main className="card center">
            {page === 'graph' ? (
              <Suspense fallback={<div className="empty">Loading...</div>}>
                <GraphPage view={view} onClose={() => setPage(null)} />
              </Suspense>
            ) : empty ? (
              <Welcome view={view} />
            ) : (
              vertical ? <CenterTop view={view} /> : !tabsInTitle && <HStrip view={view} actions />
            )}
            <div className="stage" hidden={page !== null || empty}>
              {[...ui.tabs]
                .sort((a, b) => a.id.localeCompare(b.id))
                .map((tab) => (
                  <TabPanes key={tab.id} view={view} tab={tab} active={tab.id === ui.active && page === null} epoch={epoch} />
                ))}
            </div>
          </main>
          {vertical && <Panels view={view} hidden={page !== null} />}
        </div>
        <StatusBar view={view} />
        {palette && <Palette view={view} onClose={() => setPalette(false)} />}
        {dialog && <Dialogs key={dialog.kind} view={view} request={dialog} onClose={() => setDialog(null)} />}
      </div>
    </GroupColors>
  )
}

/** The stage, or the main card while the stage is hidden (welcome, settings) */
function stageBox(): DOMRect {
  const stage = document.querySelector('.stage')?.getBoundingClientRect()
  return stage?.width ? stage : (document.querySelector('main.center')?.getBoundingClientRect() ?? new DOMRect(0, 0, innerWidth, innerHeight))
}

const paneBox = (session: string): DOMRect | undefined =>
  document.querySelector(`.term[data-session-id="${CSS.escape(session)}"]`)?.closest('.pane')?.getBoundingClientRect()

/** First load failed: the app can't do anything without the terminal host */
function Unreachable({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="welcome">
      <div className="wbox down">
        <Icon name="alert" />
        <h2>Can't reach the terminal host</h2>
        <p className="dim">Treeix runs terminals in a background process, and it isn't answering. It restarts on its own; if this stays, quit and reopen Treeix.</p>
        <button className="btn" onClick={onRetry}>
          Retry
        </button>
      </div>
    </div>
  )
}
