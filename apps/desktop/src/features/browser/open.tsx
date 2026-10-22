import { useEffect, useEffectEvent, useSyncExternalStore } from 'react'
import type { Api, BrowserEntry, BrowserEvent, BrowserState } from '../../ipc/api'
import { Icon } from '../../lib/icons'
import type { Command } from '../../lib/paletteSearch'
import type { ShellView } from '../../shell/Shell'

// Phase 7 browser pane leaves (owner B7). A browser is a pane leaf `browser:<pane id>`; its webview lives in the app
// process, so it is not a session and closes with the pane

const PREFIX = 'browser:'
const ENTRY_LIMIT = 500

export const browserLeaf = (pane: string): string => `${PREFIX}${pane}`
export const isBrowserLeaf = (leaf: string): boolean => leaf.startsWith(PREFIX)
export const leafBrowser = (leaf: string): string => leaf.slice(PREFIX.length)

/** What the window knows of each pane's page: the last state and its console and network rows */
export interface BrowserPage {
  state: BrowserState | null
  entries: BrowserEntry[]
}

const pages = new Map<string, BrowserPage>()
const listeners = new Set<() => void>()
let watching = false

const set = (pane: string, page: BrowserPage | null) => {
  if (page) pages.set(pane, page)
  else pages.delete(pane)
  listeners.forEach((cb) => cb())
}

/** Rows replace the ones with the same id (a request that finished), the rest append, oldest dropped past the limit */
export function mergeEntries(list: BrowserEntry[], incoming: BrowserEntry[], reset: boolean): BrowserEntry[] {
  const next = reset ? [] : [...list]
  for (const entry of incoming) {
    const at = next.findIndex((e) => e.id === entry.id)
    if (at < 0) next.push(entry)
    else next[at] = entry
  }
  return next.slice(-ENTRY_LIMIT)
}

export function rememberBrowser(state: BrowserState): void {
  set(state.pane, { entries: [], ...pages.get(state.pane), state })
}

function apply(e: BrowserEvent): void {
  if (e.type === 'closed') return set(e.pane, null)
  if (e.type === 'entries') {
    const page = pages.get(e.pane) ?? { state: null, entries: [] }
    return set(e.pane, { ...page, entries: mergeEntries(page.entries, e.entries, e.reset) })
  }
  rememberBrowser(e.state)
}

/** Starts listening to `onBrowser` once per window */
export function watchBrowser(api: Pick<Api, 'onBrowser'>): void {
  if (watching) return
  watching = true
  api.onBrowser(apply)
}

const subscribe = (cb: () => void) => {
  listeners.add(cb)
  return () => void listeners.delete(cb)
}

export const useBrowserPage = (pane: string): BrowserPage | undefined => useSyncExternalStore(subscribe, () => pages.get(pane))

type View = Pick<ShellView, 'api' | 'dispatch' | 'activeTab' | 'placeOfTab'>

const split = (view: View, pane: string) => {
  const place = view.activeTab ? view.placeOfTab(view.activeTab).key : undefined
  view.dispatch({ type: 'split', session: browserLeaf(pane), dir: 'row', place })
}

/** Opens `url` (empty: the start page) in a new browser pane split right of the focused pane, or in a new tab when none is open */
export async function openBrowser(view: View, url: string): Promise<void> {
  watchBrowser(view.api)
  const pane = crypto.randomUUID().slice(0, 8)
  rememberBrowser(await view.api.browserOpen(pane, url))
  split(view, pane)
}

export function closeBrowser(view: Pick<ShellView, 'api' | 'dispatch'>, leaf: string): void {
  view.dispatch({ type: 'remove', session: leaf })
  void view.api.browserClose(leafBrowser(leaf)).catch(() => undefined)
}

/** Adds the leaf of a pane an agent opened (browser_navigate without a tab). Mounted once by the shell */
export function useBrowserAgentPanes(view: View): void {
  const opened = useEffectEvent((e: BrowserEvent) => {
    if (e.type === 'opened') split(view, e.state.pane)
  })
  useEffect(() => {
    watchBrowser(view.api)
    return view.api.onBrowser(opened)
  }, [view.api])
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/** The pane header in a split: page title or host */
export function BrowserHead({ leaf }: { leaf: string }) {
  const state = useBrowserPage(leafBrowser(leaf))?.state
  return (
    <>
      <Icon name="globe" />
      <span className="trunc grow">{state?.title || (state && hostOf(state.url)) || 'Browser'}</span>
    </>
  )
}

/** "New browser pane"; only asked while the feature is on */
export function browserCommands(view: ShellView): Command[] {
  return [{ id: 'browser-new', group: 'Actions', label: 'New browser pane', icon: 'globe', run: () => void openBrowser(view, '') }]
}
