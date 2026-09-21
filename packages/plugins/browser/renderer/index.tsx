import { useEffect } from 'react'
import { createBridge, type HostApi, PageLayout, type RendererPlugin, type ShortcutInfo, useHost } from '@treeix/sdk'
import { BrowserView, runBrowserAction } from './BrowserView'
import { DesignPopover } from './DesignPopover'
import { addVital } from './entries'
import './entries'
import { onPageMessage, PageLayer } from './pages'
import { BrowserSettings } from './SettingsPage'
import { browserSettings } from './settings'
import { getBrowser, openTab, selectTab, updateBrowser } from './tabs'
import { browserAction, type BrowserAction, type KeyInput } from '../shared/keys'
import type { Vital } from '../shared/types'

const VITAL_NAMES: Vital['name'][] = ['LCP', 'INP', 'CLS', 'Long task']

const TAB_ID = 'browser'
const bridge = createBridge('browser')
let host: HostApi | null = null

const isBrowserFocused = (): boolean => document.activeElement?.closest('[data-browser]') != null

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
    ['⌘⇧C', 'Design mode, comment on an element']
  ] satisfies [string, string][]
).map(([keys, label]) => ({ keys, label, section: 'Browser' }))

/** Opens a page and brings the browser forward: the panel when it's on screen, else the tab */
function openUrl(url: string): void {
  updateBrowser((state) => openTab(state, url))
  if (host && !host.isPanelVisible(TAB_ID)) host.setActiveTab(TAB_ID)
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
        addVital(tab.guestId, { kind: 'vital', id: `${name}-${vital.time ?? 0}`, name, value: vital.value, element: String(vital.element ?? ''), time: Number(vital.time ?? 0) })
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
    <PageLayer>
      <DesignPopover />
    </PageLayer>
  )
}

function BrowserPage(): React.JSX.Element {
  return <PageLayout id={TAB_ID} main={<BrowserView place="tab" />} />
}

const plugin: RendererPlugin = {
  tabs: [{ id: TAB_ID, label: 'Browser', icon: 'globe', order: 15, render: BrowserPage }],
  panels: [{ id: TAB_ID, label: 'Browser', icon: 'globe', render: () => <BrowserView place="panel" /> }],
  Root,
  onKeyDown: (event) => {
    if (!isBrowserFocused()) return false
    const action = browserAction({ code: event.code, meta: event.metaKey, shift: event.shiftKey, alt: event.altKey, control: event.ctrlKey })
    if (!action || action === 'closeTab') return false
    runBrowserAction(action)
    return true
  },
  onCloseShortcut: () => {
    if (!isBrowserFocused()) return false
    runBrowserAction('closeTab')
    return true
  },
  commands: () => [{ id: 'browser:new', group: 'Actions', label: 'New browser tab', icon: 'globe', shortcut: '⌘T', run: () => (openUrl('about:blank'), setTimeout(() => runBrowserAction('focusAddress'), 50)) }],
  shortcuts: SHORTCUTS,
  Settings: BrowserSettings,
  services: {
    browser: { open: openUrl, handles: () => browserSettings.get().openLinks }
  }
}

export default plugin
