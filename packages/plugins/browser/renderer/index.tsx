import { useEffect, useLayoutEffect } from 'react'
import { type Command, createBridge, createStore, type HostApi, PageLayout, type RendererPlugin, type ShortcutInfo, useHost } from '@treeix/sdk'
import { BrowserView, runBrowserAction } from './BrowserView'
import { DesignPopover } from './DesignPopover'
import { addVital } from './entries'
import { onPageMessage, PageLayer } from './pages'
import { BrowserSettings } from './SettingsPage'
import { browserSettings } from './settings'
import { toggleStrip } from './Strip'
import { closeTab, findTab, getBrowser, openTab, openTabIn, selectTab, setBrowserWorkspace, updateBrowser, useBrowser } from './tabs'
import { browserAction, type BrowserAction, type KeyInput } from '../shared/keys'
import type { Vital } from '../shared/types'
import { primaryKey, secondaryKey } from '@treeix/shared/shortcut'
import { IS_MAC } from '@treeix/shared/platform'

const VITAL_NAMES: Vital['name'][] = ['LCP', 'INP', 'CLS', 'Long task']

const TAB_ID = 'browser'
const bridge = createBridge('browser')
let host: HostApi | null = null

const isBrowserFocused = (): boolean => document.activeElement?.closest('[data-browser]') != null
// Closing a tab removes the focused page or button, so focus falls to the body; the Browser page keeps its keys then
const ownsKeys = (current: HostApi): boolean => isBrowserFocused() || (current.activeTab === TAB_ID && document.activeElement === document.body)
const isConsoleKey = (event: KeyboardEvent): boolean => event.code === 'KeyJ' && primaryKey(event) && !event.shiftKey && !event.altKey && !secondaryKey(event)

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

/** Dev servers started from the palette open their first port in the browser */
function useDevServerTabs(): void {
  const service = useHost().service('sessions')
  // Again when the terminal plugin is turned on later; the host object itself changes on every render
  useEffect(() => {
    if (!service) return
    return service.subscribe(() => {
      for (const port of service.getPorts()) if (pendingDevServers.delete(port.sessionId)) openUrl(port.url)
    })
  }, [service])
}

function Root(): React.JSX.Element {
  const current = useHost()
  host = current
  useDevServerTabs()
  const { agentTools } = browserSettings.use()
  useEffect(() => void bridge.invoke('agentTools', agentTools), [agentTools])
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
          new KeyboardEvent('keydown', {
            code,
            key: String(key),
            metaKey: IS_MAC ? meta : control,
            shiftKey: shift,
            altKey: alt,
            ctrlKey: IS_MAC ? control : meta,
            bubbles: true,
            cancelable: true
          })
        )
      }),
    []
  )
  return (
    <PageLayer>
      <DesignPopover />
    </PageLayer>
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
    const action = browserAction({ code: event.code, meta: primaryKey(event), shift: event.shiftKey, alt: event.altKey, control: secondaryKey(event) })
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
