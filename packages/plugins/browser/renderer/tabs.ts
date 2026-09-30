import { useSyncExternalStore } from 'react'
import { isString, list } from '@treeix/shared/json'

export type BrowserTab = {
  id: string
  url: string
  title: string
  /** Set by renaming the tab; shown over the page's title */
  name?: string
  /** The tab group's name; a group's tabs sit next to each other */
  group?: string
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

export type BrowserState = { tabs: BrowserTab[]; activeId: string | null; /** Newest first */ closed: string[]; /** Groups showing only their chip */ collapsed?: string[] }

const CLOSED_LIMIT = 20

const newTab = (url: string, id: string): BrowserTab => ({ id, url, title: '', favicon: null, loading: false, canGoBack: false, canGoForward: false, guestId: null, crashed: false, status: null, error: null, committed: false })

export function openTab(state: BrowserState, url: string, id: string = crypto.randomUUID()): BrowserState {
  const at = state.tabs.findIndex((tab) => tab.id === state.activeId)
  const tabs = [...state.tabs]
  // Opened from a grouped tab it joins the group, so the group stays in one piece
  tabs.splice(at === -1 ? tabs.length : at + 1, 0, { ...newTab(url, id), group: tabs[at]?.group })
  return { ...state, tabs, activeId: id }
}

export function closeTab(state: BrowserState, id: string): BrowserState {
  const at = state.tabs.findIndex((tab) => tab.id === id)
  if (at === -1) return state
  const tabs = state.tabs.filter((tab) => tab.id !== id)
  const activeId = state.activeId === id ? (tabs[at] ?? tabs[at - 1])?.id ?? null : state.activeId
  return { ...state, tabs, activeId, closed: [state.tabs[at].url, ...state.closed].slice(0, CLOSED_LIMIT) }
}

export function reopenTab(state: BrowserState): BrowserState {
  const [url, ...closed] = state.closed
  return url ? { ...openTab(state, url), closed } : state
}

export const selectTab = (state: BrowserState, id: string): BrowserState => (state.tabs.some((tab) => tab.id === id) ? { ...state, activeId: id } : state)

/** Puts tab `id` where tab `targetId` is, taking the target's group so a group never splits */
export function moveTab(state: BrowserState, id: string, targetId: string): BrowserState {
  const from = state.tabs.findIndex((tab) => tab.id === id)
  const to = state.tabs.findIndex((tab) => tab.id === targetId)
  if (from === -1 || to === -1 || from === to) return state
  const tabs = [...state.tabs]
  const [moved] = tabs.splice(from, 1)
  tabs.splice(to, 0, { ...moved, group: state.tabs[to].group })
  return { ...state, tabs }
}

/** Moves a tab into `group` after the group's last tab, or out of any group with undefined, to the end; a new group starts where the tab is */
export function groupTab(state: BrowserState, id: string, group: string | undefined): BrowserState {
  const at = state.tabs.findIndex((candidate) => candidate.id === id)
  const tab = state.tabs[at]
  if (!tab || tab.group === group) return state
  const tabs = state.tabs.filter((candidate) => candidate.id !== id)
  const last = group === undefined ? tabs.length - 1 : tabs.findLastIndex((candidate) => candidate.group === group)
  tabs.splice(last === -1 ? at : last + 1, 0, { ...tab, group })
  return { ...state, tabs }
}

export const renameGroup = (state: BrowserState, from: string, to: string): BrowserState => ({
  ...state,
  tabs: state.tabs.map((tab) => (tab.group === from ? { ...tab, group: to } : tab)),
  collapsed: state.collapsed?.map((name) => (name === from ? to : name))
})

export const toggleGroup = (state: BrowserState, group: string): BrowserState => {
  const collapsed = state.collapsed ?? []
  return { ...state, collapsed: collapsed.includes(group) ? collapsed.filter((name) => name !== group) : [...collapsed, group] }
}

export const groupNames = (state: BrowserState): string[] => [...new Set(state.tabs.flatMap((tab) => (tab.group ? [tab.group] : [])))]

export const tabLabel = (tab: BrowserTab): string => tab.name ?? (tab.url === 'about:blank' ? 'New tab' : tab.title || tab.url.replace(/^https?:\/\//, ''))

export const patchTab = (state: BrowserState, id: string, patch: Partial<BrowserTab>): BrowserState => ({
  ...state,
  tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab))
})

// The open URLs survive a relaunch, per workspace; titles and history come back from the pages themselves
const KEY = 'browser.tabs'
const storage = typeof localStorage === 'undefined' ? null : localStorage
const EMPTY: BrowserState = { tabs: [], activeId: null, closed: [] }
/** Tabs saved before they were kept per workspace; the first workspace shown takes them */
const LEGACY = ''

type SavedTabs = { urls: string[]; names: (string | null)[]; groups: (string | null)[]; collapsed: string[]; active: number }

function fromSaved(saved: unknown): BrowserState {
  if (typeof saved !== 'object' || saved === null) return EMPTY
  const { urls, active, names, groups, collapsed } = saved as { urls?: unknown; active?: unknown; names?: unknown; groups?: unknown; collapsed?: unknown }
  const savedUrls = list(urls, isString)
  const textAt = (values: unknown, index: number): string | undefined => (Array.isArray(values) && typeof values[index] === 'string' ? values[index] : undefined)
  const tabs = savedUrls.map((url, index) => ({ ...newTab(url, crypto.randomUUID()), name: textAt(names, index), group: textAt(groups, index) }))
  const index = typeof active === 'number' ? active : 0
  const collapsedGroups = list(collapsed, isString)
  return { tabs, activeId: tabs[index]?.id ?? tabs[0]?.id ?? null, closed: [], collapsed: collapsedGroups }
}

const toSaved = (state: BrowserState): SavedTabs => ({
  urls: state.tabs.map((tab) => tab.url),
  names: state.tabs.map((tab) => tab.name ?? null),
  groups: state.tabs.map((tab) => tab.group ?? null),
  collapsed: state.collapsed ?? [],
  active: state.tabs.findIndex((tab) => tab.id === state.activeId)
})

function load(): Record<string, BrowserState> {
  try {
    const saved: unknown = JSON.parse(storage?.getItem(KEY) ?? 'null')
    if (typeof saved !== 'object' || saved === null) return {}
    if ('urls' in saved) return { [LEGACY]: fromSaved(saved) }
    return Object.fromEntries(Object.entries(saved).map(([workspace, tabs]) => [workspace, fromSaved(tabs)]))
  } catch {
    return {}
  }
}

let states = load()
let workspace = LEGACY
let state = states[workspace] ?? EMPTY
let everyTab: BrowserTab[] = Object.values(states).flatMap((candidate) => candidate.tabs)
const listeners = new Set<() => void>()

function commit(next: Record<string, BrowserState>): void {
  states = next
  state = states[workspace] ?? EMPTY
  everyTab = Object.values(states).flatMap((candidate) => candidate.tabs)
  storage?.setItem(KEY, JSON.stringify(Object.fromEntries(Object.entries(states).map(([id, tabs]) => [id, toSaved(tabs)]))))
  listeners.forEach((listener) => listener())
}

/** Shows the workspace's own tabs; the other workspaces' pages stay loaded behind them */
export function setBrowserWorkspace(id: string): void {
  if (id === workspace) return
  workspace = id
  const { [LEGACY]: legacy, ...rest } = states
  commit(legacy && !rest[id] ? { ...rest, [id]: legacy } : states)
}

export function updateBrowser(change: (current: BrowserState) => BrowserState): void {
  const next = change(state)
  if (next !== state) commit({ ...states, [workspace]: next })
}

/** Changes a tab in whichever workspace it is, for page events that arrive while another workspace is shown */
export function patchPage(id: string, patch: Partial<BrowserTab>): void {
  const owner = Object.keys(states).find((key) => states[key].tabs.some((tab) => tab.id === id))
  if (owner !== undefined) commit({ ...states, [owner]: patchTab(states[owner], id, patch) })
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const getBrowser = (): BrowserState => state
export const useBrowser = (): BrowserState => useSyncExternalStore(subscribe, () => state)
/** Tabs of every workspace, so switching workspace keeps their pages loaded */
export const useEveryTab = (): BrowserTab[] => useSyncExternalStore(subscribe, () => everyTab)
export const findTab = (id: string): BrowserTab | undefined => everyTab.find((tab) => tab.id === id)
export const activeTab = (): BrowserTab | undefined => state.tabs.find((tab) => tab.id === state.activeId)
