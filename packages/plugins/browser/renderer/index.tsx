import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { type Command, createBridge, createStore, type HostApi, PageLayout, type SessionPort, type RendererPlugin, type ShortcutInfo, useHost } from '@treeix/sdk'
import { Icon } from '@treeix/app/Icon'
import { BrowserView, runBrowserAction } from './BrowserView'
import { DesignPopover } from './DesignPopover'
import { addVital } from './entries'
import { onPageMessage, PageLayer } from './pages'
import { BrowserSettings } from './SettingsPage'
import { browserSettings } from './settings'
import { portDetail } from './Suggestions'
import { toggleStrip } from './Strip'
import { closeTab, findTab, getBrowser, openTab, openTabIn, selectTab, setBrowserWorkspace, updateBrowser, useBrowser } from './tabs'
import { browserAction, type BrowserAction, type KeyInput } from '../shared/keys'
import type { Vital } from '../shared/types'

const VITAL_NAMES: Vital['name'][] = ['LCP', 'INP', 'CLS', 'Long task']

const TAB_ID = 'browser'
const bridge = createBridge('browser')
let host: HostApi | null = null

const isBrowserFocused = (): boolean => document.activeElement?.closest('[data-browser]') != null
// Closing a tab removes the focused page or button, so focus falls to the body; the Browser page keeps its keys then
const ownsKeys = (current: HostApi): boolean => isBrowserFocused() || (current.activeTab === TAB_ID && document.activeElement === document.body)
const isConsoleKey = (event: KeyboardEvent): boolean => event.code === 'KeyJ' && event.metaKey && !event.shiftKey && !event.altKey && !event.ctrlKey

/** Chrome's keys, while the browser has focus */
const SHORTCUTS: ShortcutInfo[] = (
  [
    ['⌘ L', 'Address bar'],
    ['⌘ T', 'New tab'],
    ['⌘ W', 'Close tab'],
    ['⇧⌘ T', 'Reopen closed tab'],
    ['⌘ [ ]', 'Back, forward'],
    ['⌘ R', 'Reload'],
    ['⌥⌘ I', 'Developer tools'],
    ['⇧⌘ C', 'Design mode, comment on an element'],
    ['⌘ J', 'Console, network and performance']
  ] satisfies [string, string][]
).map(([keys, label]) => ({ keys, label, section: 'Browser' }))

/** Pages opened while the browser was out of sight, so its tab can say so */
const unseen = createStore(0)

/** Opens a page and brings the browser forward: the panel when it's on screen, else the tab */
function openUrl(url: string, id?: string): void {
  updateBrowser((state) => openTab(state, url, id))
  showBrowser()
}

/** An agent's page: it opens where the user left the browser rather than pulling them out of what they were doing */
function openUrlQuietly(url: string, id?: string): void {
  updateBrowser((state) => openTab(state, url, id))
  if (showsBrowser()) return
  unseen.set(unseen.get() + 1)
}

const showsBrowser = (): boolean => !!host && (host.activeTab === TAB_ID || host.isPanelVisible(TAB_ID))

const showBrowser = (): void => {
  if (host && !host.isPanelVisible(TAB_ID)) host.setActiveTab(TAB_ID)
}

/** Dev servers started from the palette; their first port opens in the browser without asking */
const pendingDevServers = new Set<string>()

async function runDevServer(current: HostApi, folder: string): Promise<void> {
  const sessions = current.service('sessions')
  const command = await bridge.invoke<string | null>('devServerCommand', folder)
  if (!sessions || !command) return current.flash('No dev, start or serve script in package.json')
  pendingDevServers.add(await sessions.runCommand(folder, command))
}

const NOTICE_MS = 12_000
const NOTICES_SHOWN = 3
/** Ports seen this soon after the window loads were already up, e.g. after a reload */
// ponytail: a time window, not "the first poll"; getPorts could tell polled-empty from not-polled if restores ever take longer
const SETTLE_MS = 5000
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0'])

type Notice = { id: number; key: string; url: string; label: string; detail: string }

let nextNoticeId = 0

const portKey = ({ sessionId, port }: SessionPort): string => `${sessionId}:${port}`

function showsPort(port: number): boolean {
  return getBrowser().tabs.some((tab) => {
    try {
      const url = new URL(tab.url)
      return LOCAL_HOSTS.has(url.hostname) && Number(url.port) === port
    } catch {
      return false
    }
  })
}

/** "localhost:5173 is up" cards for ports sessions start listening on */
function ServerNotices(): React.JSX.Element | null {
  const service = useHost().service('sessions')
  const [notices, setNotices] = useState<Notice[]>([])
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())
  const dismiss = (id: number): void => setNotices((list) => list.filter((notice) => notice.id !== id))
  // One timer per card on screen: cards closed, replaced or pushed out take theirs along
  useEffect(() => {
    const shown = new Set(notices.map((notice) => notice.id))
    for (const [id, timer] of timers.current) {
      if (shown.has(id)) continue
      clearTimeout(timer)
      timers.current.delete(id)
    }
    for (const { id } of notices)
      if (!timers.current.has(id))
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), NOTICE_MS)
        )
  }, [notices])
  useEffect(() => () => timers.current.forEach(clearTimeout), [])
  // Again when the terminal plugin is turned on later; the host object itself changes on every render
  useEffect(() => {
    if (!service) return
    const settleUntil = Date.now() + SETTLE_MS
    let known = new Set(service.getPorts().map(portKey))
    return service.subscribe(() => {
      const ports = service.getPorts()
      const fresh = ports.filter((port) => !known.has(portKey(port)))
      const started = fresh.filter((port) => pendingDevServers.delete(port.sessionId))
      started.forEach((port) => openUrl(port.url))
      const live = new Set(ports.map(portKey))
      known = live
      const notify = Date.now() >= settleUntil && browserSettings.get().notifyPorts
      const added = (notify ? fresh : [])
        .filter((port) => !showsPort(port.port) && !started.includes(port))
        .map((port) => ({
          id: nextNoticeId++,
          key: portKey(port),
          url: port.url,
          label: `localhost:${port.port}`,
          // What runs it first: the command tells a bun dev server from a python one at a glance
          detail: [port.command, portDetail(service.getSessions(), host?.repos ?? null, port)].filter(Boolean).join(' · ')
        }))
      setNotices((list) => {
        // Stopped servers take their card with them
        const kept = list.filter((notice) => live.has(notice.key) && !added.some((item) => item.key === notice.key))
        return kept.length === list.length && !added.length ? list : [...kept, ...added].slice(-NOTICES_SHOWN)
      })
    })
  }, [service])
  if (!notices.length) return null
  return (
    // Under the title bar on the right, clear of the work below
    <div className="fixed top-11 right-3 z-40 flex w-56 flex-col gap-1.5">
      {notices.map((notice) => (
        <div key={notice.id} role="status" aria-label={`${notice.label} is up`} className="flex items-center gap-2 rounded-lg border border-border bg-card px-2 py-1.5">
          <span className="size-1.5 shrink-0 rounded-full bg-emerald-400" />
          <div className="min-w-0 flex-1">
            <div className="truncate font-mono text-[11px] text-foreground">{notice.label}</div>
            {notice.detail && <div className="truncate text-[10px] text-muted-foreground">{notice.detail}</div>}
          </div>
          <button
            onClick={() => {
              openUrl(notice.url)
              dismiss(notice.id)
            }}
            className="h-5 shrink-0 rounded border border-border px-1.5 text-[11px] hover:bg-accent"
          >
            Open
          </button>
          <button
            aria-label="Dismiss"
            onClick={() => dismiss(notice.id)}
            className="flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Icon name="close" className="size-2.5" />
          </button>
        </div>
      ))}
    </div>
  )
}

function Root(): React.JSX.Element {
  const current = useHost()
  host = current
  // Before paint, so a workspace never flashes the previous one's tabs
  useLayoutEffect(() => setBrowserWorkspace(current.workspaceId), [current.workspaceId])
  // Looking at the browser is reading the pages an agent opened there
  useEffect(() => {
    if (showsBrowser()) unseen.set(0)
  })
  // Agents open, show and close tabs by the id main gives them, through Treeix's MCP server; an agent's tab opens in its session's workspace
  useEffect(
    () =>
      bridge.on('open', (url, id, workspaceId) => {
        if (typeof url !== 'string') return
        if (typeof id === 'string' && typeof workspaceId === 'string' && workspaceId !== host?.workspaceId) openTabIn(workspaceId, url, id)
        else openUrlQuietly(url, typeof id === 'string' ? id : undefined)
      }),
    []
  )
  useEffect(
    () =>
      bridge.on('show', (id) => {
        if (typeof id !== 'string') return
        updateBrowser((state) => selectTab(state, id))
        showBrowser()
      }),
    []
  )
  useEffect(() => bridge.on('close', (id) => typeof id === 'string' && updateBrowser((state) => closeTab(state, id))), [])
  useEffect(
    () =>
      onPageMessage((tabId, channel, args) => {
        const tab = findTab(tabId)
        if (channel !== 'vital' || !tab?.guestId) return
        const vital = args[0] as Partial<Vital> | undefined
        if (!vital || typeof vital.value !== 'number' || typeof vital.name !== 'string') return
        const name = VITAL_NAMES.find((candidate) => candidate === vital.name)
        if (!name) return
        addVital(tab.guestId, {
          kind: 'vital',
          id: `${name}-${vital.time ?? 0}`,
          name,
          value: vital.value,
          element: String(vital.element ?? ''),
          detail: String(vital.detail ?? ''),
          start: Number(vital.start ?? 0),
          time: Number(vital.time ?? 0)
        })
      }),
    []
  )
  useEffect(
    () =>
      bridge.on('action', (guestId, action) => {
        const tab = getBrowser().tabs.find((candidate) => candidate.guestId === guestId)
        if (tab) updateBrowser((state) => selectTab(state, tab.id))
        runBrowserAction(action as BrowserAction)
      }),
    []
  )
  // The app's own ⌘ keys, pressed while a page had focus, replayed where the app listens for them
  useEffect(
    () =>
      bridge.on('key', (input, key) => {
        const { code, meta, shift, alt, control } = input as KeyInput
        window.dispatchEvent(
          new KeyboardEvent('keydown', { code, key: String(key), metaKey: meta, shiftKey: shift, altKey: alt, ctrlKey: control, bubbles: true, cancelable: true })
        )
      }),
    []
  )
  return (
    <>
      <PageLayer>
        <DesignPopover />
      </PageLayer>
      <ServerNotices />
    </>
  )
}

/** The workspace's open pages, on the page tab like the terminal's session count; a dot for pages an agent opened out of sight */
function TabsCount(): React.JSX.Element | null {
  const count = useBrowser().tabs.filter((tab) => tab.url !== 'about:blank').length
  const fresh = unseen.use()
  if (!count) return null
  return (
    <span
      title={fresh ? `${fresh} page${fresh === 1 ? '' : 's'} an agent opened` : `${count} open page${count === 1 ? '' : 's'}`}
      className={`tabular-nums ${fresh ? 'text-amber-400' : 'text-muted-foreground'}`}
    >
      {count}
    </span>
  )
}

function BrowserPage(): React.JSX.Element {
  return <PageLayout id={TAB_ID} main={<BrowserView place="tab" />} />
}

const plugin: RendererPlugin = {
  tabs: [{ id: TAB_ID, label: 'Browser', icon: 'globe', order: 15, render: BrowserPage, panels: ['terminal'], Badge: TabsCount }],
  panels: [{ id: TAB_ID, label: 'Browser', icon: 'globe', render: () => <BrowserView place="panel" /> }],
  Root,
  onKeyDown: (event, current) => {
    if (!ownsKeys(current)) return false
    if (isConsoleKey(event)) return toggleStrip()
    const action = browserAction({ code: event.code, meta: event.metaKey, shift: event.shiftKey, alt: event.altKey, control: event.ctrlKey })
    if (!action || action === 'closeTab') return false
    runBrowserAction(action)
    return true
  },
  onCloseShortcut: (current) => {
    if (!ownsKeys(current)) return false
    runBrowserAction('closeTab')
    return true
  },
  commands: (current) => [
    ...(current.selectedWorktree && current.service('sessions')
      ? [
          {
            id: 'browser:devServer',
            group: 'Actions',
            label: `Run dev server in ${current.selectedWorktreeLabel ?? 'the worktree'}`,
            icon: 'terminal',
            run: () => void runDevServer(current, current.selectedWorktree ?? '')
          } satisfies Command
        ]
      : []),
    {
      id: 'browser:new',
      group: 'Actions',
      label: 'New browser tab',
      icon: 'globe',
      shortcut: '⌘T',
      run: () => (openUrl('about:blank'), setTimeout(() => runBrowserAction('focusAddress'), 50))
    }
  ],
  shortcuts: SHORTCUTS,
  Settings: BrowserSettings,
  services: {
    browser: { open: openUrl, handles: () => browserSettings.get().openLinks }
  }
}

export default plugin
