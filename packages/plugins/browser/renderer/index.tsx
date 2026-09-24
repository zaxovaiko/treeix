import { useEffect, useRef, useState } from 'react'
import { type Command, createBridge, type HostApi, PageLayout, type SessionPort, type RendererPlugin, type ShortcutInfo, useHost } from '@treeix/sdk'
import { Icon } from '@treeix/app/Icon'
import { BrowserView, runBrowserAction } from './BrowserView'
import { DesignPopover } from './DesignPopover'
import { addVital } from './entries'
import { onPageMessage, PageLayer } from './pages'
import { BrowserSettings } from './SettingsPage'
import { browserSettings } from './settings'
import { portDetail } from './Suggestions'
import { toggleStrip } from './Strip'
import { getBrowser, openTab, selectTab, updateBrowser } from './tabs'
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
    ['⌘L', 'Address bar'],
    ['⌘T', 'New tab'],
    ['⌘W', 'Close tab'],
    ['⌘⇧T', 'Reopen closed tab'],
    ['⌘[ ⌘]', 'Back, forward'],
    ['⌘R', 'Reload'],
    ['⌥⌘I', 'Developer tools'],
    ['⌘⇧C', 'Design mode, comment on an element'],
    ['⌘J', 'Console, network and performance']
  ] satisfies [string, string][]
).map(([keys, label]) => ({ keys, label, section: 'Browser' }))

/** Opens a page and brings the browser forward: the panel when it's on screen, else the tab */
function openUrl(url: string): void {
  updateBrowser((state) => openTab(state, url))
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
    for (const { id } of notices) if (!timers.current.has(id)) timers.current.set(id, setTimeout(() => dismiss(id), NOTICE_MS))
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
        .map((port) => ({ id: nextNoticeId++, key: portKey(port), url: port.url, label: `localhost:${port.port}`, detail: portDetail(service.getSessions(), host?.repos ?? null, port) }))
      setNotices((list) => {
        // Stopped servers take their card with them
        const kept = list.filter((notice) => live.has(notice.key) && !added.some((item) => item.key === notice.key))
        return kept.length === list.length && !added.length ? list : [...kept, ...added].slice(-NOTICES_SHOWN)
      })
    })
  }, [service])
  if (!notices.length) return null
  return (
    <div className="fixed right-4 bottom-4 z-40 flex w-72 flex-col gap-2">
      {notices.map((notice) => (
        <div key={notice.id} role="status" className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2 shadow-lg">
          <span className="size-1.5 shrink-0 rounded-full bg-emerald-400" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs text-foreground">
              <span className="font-mono">{notice.label}</span> is up
            </div>
            {notice.detail && <div className="truncate text-[11px] text-muted-foreground">{notice.detail}</div>}
          </div>
          <button
            onClick={() => {
              openUrl(notice.url)
              dismiss(notice.id)
            }}
            className="h-6 shrink-0 rounded-md border border-border px-2 text-xs hover:bg-accent"
          >
            Open
          </button>
          <button aria-label="Dismiss" onClick={() => dismiss(notice.id)} className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground">
            <Icon name="close" className="size-3" />
          </button>
        </div>
      ))}
    </div>
  )
}

function Root(): React.JSX.Element {
  const current = useHost()
  host = current
  useEffect(() => bridge.on('open', (url) => typeof url === 'string' && openUrl(url)), [])
  useEffect(
    () =>
      onPageMessage((tabId, channel, args) => {
        const tab = getBrowser().tabs.find((candidate) => candidate.id === tabId)
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
        window.dispatchEvent(new KeyboardEvent('keydown', { code, key: String(key), metaKey: meta, shiftKey: shift, altKey: alt, ctrlKey: control, bubbles: true, cancelable: true }))
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

function BrowserPage(): React.JSX.Element {
  return <PageLayout id={TAB_ID} main={<BrowserView place="tab" />} />
}

const plugin: RendererPlugin = {
  tabs: [{ id: TAB_ID, label: 'Browser', icon: 'globe', order: 15, render: BrowserPage, panels: ['terminal'] }],
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
      ? [{ id: 'browser:devServer', group: 'Actions', label: `Run dev server in ${current.selectedWorktreeLabel ?? 'the worktree'}`, icon: 'terminal', run: () => void runDevServer(current, current.selectedWorktree ?? '') } satisfies Command]
      : []),
    { id: 'browser:new', group: 'Actions', label: 'New browser tab', icon: 'globe', shortcut: '⌘T', run: () => (openUrl('about:blank'), setTimeout(() => runBrowserAction('focusAddress'), 50)) }
  ],
  shortcuts: SHORTCUTS,
  Settings: BrowserSettings,
  services: {
    browser: { open: openUrl, handles: () => browserSettings.get().openLinks }
  }
}

export default plugin
