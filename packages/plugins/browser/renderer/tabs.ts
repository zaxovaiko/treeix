import { useSyncExternalStore } from 'react'

export type BrowserTab = {
  id: string
  url: string
  title: string
  favicon: string | null
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** The page's webContents id once it attached; main keys its per-page work by it */
  guestId: number | null
  crashed: boolean
  /** The page's HTTP status; its own error page shows, so 4xx and 5xx only mark the address bar */
  status: number | null
  /** A load that never reached a server, e.g. nothing listening on the port; Chromium's error page is replaced by ours */
  error: { code: number; description: string; url: string } | null
  /** False until the first navigation commits, so a new tab shows a loader rather than a blank page */
  committed: boolean
}

export type BrowserState = { tabs: BrowserTab[]; activeId: string | null; /** Newest first */ closed: string[] }

const CLOSED_LIMIT = 20

const newTab = (url: string, id: string): BrowserTab => ({ id, url, title: '', favicon: null, loading: false, canGoBack: false, canGoForward: false, guestId: null, crashed: false, status: null, error: null, committed: false })

export function openTab(state: BrowserState, url: string, id: string = crypto.randomUUID()): BrowserState {
  const at = state.tabs.findIndex((tab) => tab.id === state.activeId)
  const tabs = [...state.tabs]
  tabs.splice(at === -1 ? tabs.length : at + 1, 0, newTab(url, id))
  return { ...state, tabs, activeId: id }
}

export function closeTab(state: BrowserState, id: string): BrowserState {
  const at = state.tabs.findIndex((tab) => tab.id === id)
  if (at === -1) return state
  const tabs = state.tabs.filter((tab) => tab.id !== id)
  const activeId = state.activeId === id ? (tabs[at] ?? tabs[at - 1])?.id ?? null : state.activeId
  return { tabs, activeId, closed: [state.tabs[at].url, ...state.closed].slice(0, CLOSED_LIMIT) }
}

export function reopenTab(state: BrowserState): BrowserState {
  const [url, ...closed] = state.closed
  return url ? { ...openTab(state, url), closed } : state
}

export const selectTab = (state: BrowserState, id: string): BrowserState => (state.tabs.some((tab) => tab.id === id) ? { ...state, activeId: id } : state)

export const patchTab = (state: BrowserState, id: string, patch: Partial<BrowserTab>): BrowserState => ({
  ...state,
  tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab))
})

// The open URLs survive a relaunch; titles and history come back from the pages themselves
const KEY = 'browser.tabs'
const storage = typeof localStorage === 'undefined' ? null : localStorage

function load(): BrowserState {
  try {
    const saved: unknown = JSON.parse(storage?.getItem(KEY) ?? 'null')
    if (typeof saved !== 'object' || saved === null) return { tabs: [], activeId: null, closed: [] }
    const { urls, active } = saved as { urls?: unknown; active?: unknown }
    const list = Array.isArray(urls) ? urls.filter((url): url is string => typeof url === 'string') : []
    const tabs = list.map((url) => newTab(url, crypto.randomUUID()))
    const index = typeof active === 'number' ? active : 0
    return { tabs, activeId: tabs[index]?.id ?? tabs[0]?.id ?? null, closed: [] }
  } catch {
    return { tabs: [], activeId: null, closed: [] }
  }
}

let state = load()
const listeners = new Set<() => void>()

export function updateBrowser(change: (current: BrowserState) => BrowserState): void {
  const next = change(state)
  if (next === state) return
  state = next
  storage?.setItem(KEY, JSON.stringify({ urls: state.tabs.map((tab) => tab.url), active: state.tabs.findIndex((tab) => tab.id === state.activeId) }))
  listeners.forEach((listener) => listener())
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const getBrowser = (): BrowserState => state
export const useBrowser = (): BrowserState => useSyncExternalStore(subscribe, () => state)
export const activeTab = (): BrowserTab | undefined => state.tabs.find((tab) => tab.id === state.activeId)
