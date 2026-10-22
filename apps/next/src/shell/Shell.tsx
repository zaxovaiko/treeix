import { useEffect, useEffectEvent, useLayoutEffect, useReducer, useRef, useState } from 'react'
import { emit, listen } from '@tauri-apps/api/event'
import type { Api, Place, SessionEvent, SessionInfo, SessionKind } from '../ipc/api'
import { applyTheme } from '../styles/theme'
import { Icon } from '../lib/icons'
import { IN_TAURI, pickFolder, registerQuickShortcut, UI_CHANGED } from '../lib/native'
import { groupTabs, initialUi, leaves, neighbor, newTabId, parseUi, reducer, restore, tabPlace, type Action, type Group, type SplitDir, type Tab, type UiState } from './state'
import { fallbackPlace, type Sessions } from './model'
import { isCommandId, menuChord, shortcut, type CommandId } from './shortcuts'
import { CenterTop, HStrip, Sidebar, SidebarResize, StatusBar, TitleBar, Welcome } from './Chrome'
import { Settings } from './Settings'
import { TabPanes } from './Panes'
import { Palette } from './Palette'
import { paneGrid } from '../panes/terminal/xterm'

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
}

const byId = (list: SessionInfo[]): Sessions => Object.fromEntries(list.map((s) => [s.id, s]))

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
  const [page, setPage] = useState<'settings' | null>(null)
  const resolving = useRef(new Set<string>())
  /** Panes closed while their process still ran; forgotten once it exits */
  const closing = useRef(new Set<string>())

  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let cancelled = false
    Promise.all([api.getUi(), api.sessions(), api.homeDir()]).then(
      ([json, list, homeDir]) => {
        if (cancelled) return
        const saved = parseUi(json)
        setHome(homeDir)
        setSessions(byId(list))
        dispatch({ type: 'load', ui: restore(saved, list) })
        setUnreachable(false)
        setLoaded(true)
        if (saved.quickShortcut) registerQuickShortcut(saved.quickShortcut).catch((e: unknown) => console.warn('quick terminal shortcut:', e))
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
    Promise.all([api.sessions(), api.getUi()]).then(([list, json]) => {
      setSessions(byId(list))
      dispatch({ type: 'load', ui: restore({ ...ui, quick: parseUi(json).quick }, list) })
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

  useEffect(() => {
    const cwds = [...new Set(Object.values(sessions).map((s) => s.cwd))].filter((cwd) => !places[cwd] && !resolving.current.has(cwd))
    if (!cwds.length) return
    cwds.forEach((cwd) => resolving.current.add(cwd))
    void api
      .places(cwds)
      .then((found) => setPlaces((all) => ({ ...all, ...Object.fromEntries(cwds.map((cwd, i) => [cwd, found[i]] as const).filter(([, p]) => p)) })))
      .finally(() => cwds.forEach((cwd) => resolving.current.delete(cwd)))
  }, [api, sessions, places])

  const placeOf = (session: string): Place => {
    const cwd = sessions[session]?.cwd ?? home
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
  useEffect(() => {
    if (loaded && IN_TAURI) void emit(UI_CHANGED, { theme: ui.theme, ui: ui.ui, renderer: ui.renderer })
  }, [loaded, ui.theme, ui.ui, ui.renderer])

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
    const info = sessions[session]
    if (!info || GONE.has(info.status)) void api.remove(session)
    else {
      closing.current.add(session)
      void api.kill(session)
    }
  }
  const closeTab = (tab: Tab) => leaves(tab.root).forEach(closePane)

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
      case 'next-tab':
        return cycle(1)
      case 'prev-tab':
        return cycle(-1)
      case 'palette':
        return setPalette(true)
      case 'toggle-sidebar':
        return dispatch({ type: 'set', patch: { sidebar: !ui.sidebar } })
      case 'settings':
        return setPage(page ? null : 'settings')
      case 'toggle-tabs':
        return dispatch({ type: 'set', patch: { orientation: ui.orientation === 'vertical' ? 'horizontal' : 'vertical' } })
      case 'toggle-ui':
        return dispatch({ type: 'set', patch: { ui: ui.ui === 'compact' ? 'islands' : 'compact' } })
      case 'toggle-theme':
        return dispatch({ type: 'set', patch: { theme: ui.theme === 'dark' ? 'light' : 'dark' } })
    }
  }

  const onKey = useEffectEvent((e: KeyboardEvent) => {
    // The settings recorder is taking a chord
    if (document.querySelector('.krec.on')) return
    const id = shortcut(e)
    if (!id || (IN_TAURI && menuChord(e))) return
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
    if (isCommandId(id)) run(id)
  })
  useEffect(() => {
    if (!IN_TAURI) return
    const unlisten = listen<{ id: string }>('menu', (e) => onMenu(e.payload.id))
    return () => void unlisten.then((stop) => stop())
  }, [])

  if (!loaded)
    return (
      <div className="win">
        {unreachable && <Unreachable onRetry={retry} />}
      </div>
    )

  const view: ShellView = { api, ui, dispatch, sessions, home, groups, ordered, activeTab, placeOf, placeOfTab, run, newSession, split, closePane, closeTab }
  const vertical = ui.orientation === 'vertical'
  const tabsInTitle = !vertical && ui.ui === 'compact'
  const empty = ui.tabs.length === 0

  return (
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
        <main className="card center">
          {page === 'settings' ? (
            <Settings view={view} onClose={() => setPage(null)} />
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
      </div>
      <StatusBar view={view} />
      {palette && <Palette view={view} onClose={() => setPalette(false)} />}
    </div>
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
