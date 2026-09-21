import { useEffect } from 'react'
import { createBridge, type HostApi, PageLayout, type RendererPlugin, useHost } from '@treeix/sdk'
import { BrowserView } from './BrowserView'
import { PageLayer } from './pages'
import { browserSettings } from './settings'
import { openTab, updateBrowser } from './tabs'

const TAB_ID = 'browser'
const bridge = createBridge('browser')
let host: HostApi | null = null

/** Opens a page and brings the browser forward: the panel when it's on screen, else the tab */
function openUrl(url: string): void {
  updateBrowser((state) => openTab(state, url))
  if (host && !host.isPanelVisible(TAB_ID)) host.setActiveTab(TAB_ID)
}

function Root(): React.JSX.Element {
  const current = useHost()
  host = current
  useEffect(() => bridge.on('open', (url) => typeof url === 'string' && openUrl(url)), [])
  return <PageLayer />
}

function BrowserPage(): React.JSX.Element {
  return <PageLayout id={TAB_ID} main={<BrowserView place="tab" />} />
}

const plugin: RendererPlugin = {
  tabs: [{ id: TAB_ID, label: 'Browser', icon: 'globe', order: 15, render: BrowserPage }],
  panels: [{ id: TAB_ID, label: 'Browser', icon: 'globe', render: () => <BrowserView place="panel" /> }],
  Root,
  services: {
    browser: { open: openUrl, handles: () => browserSettings.get().openLinks }
  }
}

export default plugin
