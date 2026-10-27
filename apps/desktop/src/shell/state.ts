import type { Place, PlaceKind, SessionInfo } from '../ipc/api'
import type { Renderer } from '../panes/terminal/renderer'

export type SplitDir = 'row' | 'col'
export type SplitNode = { type: 'pane'; session: string } | { type: 'split'; dir: SplitDir; ratio: number; a: SplitNode; b: SplitNode }

export interface Tab {
  id: string
  root: SplitNode
  title?: string
  /** Session of the focused pane */
  focus: string
  /** Group a split tab stays in; single-pane tabs follow their session's cwd */
  place?: string
}

/** Side panels on the right, opened from the activity bar */
export type PanelId = 'explorer' | 'changes' | 'prs' | 'history' | 'tickets' | 'problems' | 'servers'

export interface RecentPlace {
  path: string
  name: string
  kind: PlaceKind
}

/** Everything persisted in the daemon's UI blob */
export interface UiState {
  tabs: Tab[]
  active: string | null
  /** Top-level sidebar groups (repo roots, folders, ~) in display order */
  groupOrder: string[]
  collapsed: string[]
  sidebar: boolean
  sidebarWidth: number
  /** Open side panel; null when closed */
  panel: PanelId | null
  panelWidth: number
  orientation: 'vertical' | 'horizontal'
  ui: 'compact' | 'islands'
  theme: 'dark' | 'light'
  recent: RecentPlace[]
  /** The quick terminal window's panes; written by that window only */
  quick: SplitNode | null
  renderer: Renderer
  /** Global accelerator for the quick terminal, e.g. `Control+Backquote`; null: none */
  quickShortcut: string | null
  /** The chord shows and hides the main window instead of the quick terminal */
  quickWholeApp: boolean
  /** The quick terminal slides down when shown; off, it just appears */
  quickAnimate: boolean
  /** Opacity of the quick terminal window, 0.3 to 1 */
  quickOpacity: number
  /** Opacity of the main window's background, 0.3 to 1; the text stays solid. macOS only */
  windowOpacity: number
  /** What shows through the see-through main window and quick terminal is blurred */
  windowBlur: boolean
  /** Page zoom of both windows, 1 = 100% */
  zoom: number
  /** Group colors picked by hand, by place key */
  colors: Record<string, string>
}

export const SIDEBAR = { min: 180, max: 520, initial: 276 }
export const PANEL = { min: 260, max: 640, initial: 344 }
export const ZOOM = { min: 0.5, max: 2, step: 0.1 }

/** `by` steps from `zoom`, kept in range and on the 10% grid */
export const zoomed = (zoom: number, by: number) => Math.round(Math.min(ZOOM.max, Math.max(ZOOM.min, zoom + by * ZOOM.step)) * 10) / 10

export const initialUi: UiState = {
  tabs: [],
  active: null,
  groupOrder: [],
  collapsed: [],
  sidebar: true,
  sidebarWidth: SIDEBAR.initial,
  panel: null,
  panelWidth: PANEL.initial,
  orientation: 'vertical',
  ui: 'compact',
  theme: 'dark',
  recent: [],
  quick: null,
  renderer: 'auto',
  quickShortcut: null,
  quickWholeApp: false,
  quickAnimate: true,
  quickOpacity: 1,
  windowOpacity: 1,
  windowBlur: true,
  zoom: 1,
  colors: {},
}

export const leaves = (node: SplitNode): string[] => (node.type === 'pane' ? [node.session] : [...leaves(node.a), ...leaves(node.b)])

export const removeLeaf = (node: SplitNode, session: string): SplitNode | null => {
  if (node.type === 'pane') return node.session === session ? null : node
  const a = removeLeaf(node.a, session)
  const b = removeLeaf(node.b, session)
  return a && b ? { ...node, a, b } : (a ?? b)
}

export const replaceLeaf = (node: SplitNode, session: string, next: SplitNode): SplitNode => {
  if (node.type === 'pane') return node.session === session ? next : node
  return { ...node, a: replaceLeaf(node.a, session, next), b: replaceLeaf(node.b, session, next) }
}

/** `path` is a string of a/b steps from the root to a split node */
export const setRatio = (node: SplitNode, path: string, ratio: number): SplitNode => {
  if (node.type === 'pane') return node
  if (!path) return { ...node, ratio }
  return path[0] === 'a' ? { ...node, a: setRatio(node.a, path.slice(1), ratio) } : { ...node, b: setRatio(node.b, path.slice(1), ratio) }
}

/** Drops a session from every tab; tabs left empty go away */
function withoutSession(state: UiState, session: string): UiState {
  const tabs = state.tabs.flatMap((tab) => {
    if (!leaves(tab.root).includes(session)) return [tab]
    const root = removeLeaf(tab.root, session)
    if (!root) return []
    const left = leaves(root)
    return [{ ...tab, root, focus: left.includes(tab.focus) ? tab.focus : left[0], place: left.length > 1 ? tab.place : undefined }]
  })
  const activeIndex = state.tabs.findIndex((tab) => tab.id === state.active)
  const active = tabs.some((tab) => tab.id === state.active) ? state.active : (tabs[Math.min(activeIndex, tabs.length - 1)]?.id ?? null)
  return { ...state, tabs, active }
}

let lastId = 0
export const newTabId = () => `t${Date.now().toString(36)}${(lastId++).toString(36)}`

export type Action =
  | { type: 'load'; ui: UiState }
  /** `background`: the tab is added without switching to it */
  | { type: 'open'; session: string; tabId: string; background?: boolean }
  | { type: 'split'; session: string; dir: SplitDir; place?: string }
  | { type: 'remove'; session: string }
  | { type: 'focus'; session: string }
  | { type: 'activate'; tabId: string }
  | { type: 'ratio'; tabId: string; path: string; ratio: number }
  | { type: 'toggleCollapsed'; key: string }
  /** null: back to the default color */
  | { type: 'color'; key: string; color: string | null }
  | { type: 'groups'; keys: string[] }
  | { type: 'recent'; places: Place[] }
  | { type: 'set'; patch: Partial<Pick<UiState, 'sidebar' | 'sidebarWidth' | 'panel' | 'panelWidth' | 'orientation' | 'ui' | 'theme' | 'renderer' | 'quickShortcut' | 'quickWholeApp' | 'quickAnimate' | 'quickOpacity' | 'windowOpacity' | 'windowBlur' | 'quick' | 'zoom'>> }

export function reducer(state: UiState, action: Action): UiState {
  switch (action.type) {
    case 'load':
      return action.ui
    case 'open': {
      const rest = withoutSession(state, action.session)
      const tab: Tab = { id: action.tabId, root: { type: 'pane', session: action.session }, focus: action.session }
      return { ...rest, tabs: [...rest.tabs, tab], active: action.background && rest.active ? rest.active : tab.id }
    }
    case 'split': {
      const rest = withoutSession(state, action.session)
      const tab = rest.tabs.find((t) => t.id === rest.active)
      if (!tab) return reducer(rest, { type: 'open', session: action.session, tabId: newTabId() })
      const next: SplitNode = { type: 'split', dir: action.dir, ratio: 0.5, a: { type: 'pane', session: tab.focus }, b: { type: 'pane', session: action.session } }
      const updated = { ...tab, root: replaceLeaf(tab.root, tab.focus, next), focus: action.session, place: tab.place ?? action.place }
      return { ...rest, tabs: rest.tabs.map((t) => (t.id === tab.id ? updated : t)) }
    }
    case 'remove':
      return withoutSession(state, action.session)
    case 'focus': {
      const tab = state.tabs.find((t) => leaves(t.root).includes(action.session))
      if (!tab) return state
      return { ...state, active: tab.id, tabs: state.tabs.map((t) => (t === tab ? { ...t, focus: action.session } : t)) }
    }
    case 'activate':
      return state.tabs.some((t) => t.id === action.tabId) ? { ...state, active: action.tabId } : state
    case 'ratio': {
      const ratio = Math.min(0.9, Math.max(0.1, action.ratio))
      return { ...state, tabs: state.tabs.map((t) => (t.id === action.tabId ? { ...t, root: setRatio(t.root, action.path, ratio) } : t)) }
    }
    case 'color': {
      const colors = Object.fromEntries(Object.entries(state.colors).filter(([key]) => key !== action.key))
      return { ...state, colors: action.color ? { ...colors, [action.key]: action.color } : colors }
    }
    case 'toggleCollapsed': {
      const has = state.collapsed.includes(action.key)
      return { ...state, collapsed: has ? state.collapsed.filter((k) => k !== action.key) : [...state.collapsed, action.key] }
    }
    case 'groups': {
      const added = action.keys.filter((k) => !state.groupOrder.includes(k))
      return added.length ? { ...state, groupOrder: [...state.groupOrder, ...added] } : state
    }
    case 'recent': {
      const seen = action.places.filter((p) => p.kind !== 'scratch' && !p.missing).map((p): RecentPlace => ({ path: p.path, name: placeLabel(p), kind: p.kind }))
      const recent = [...seen, ...state.recent].filter((p, i, all) => all.findIndex((q) => q.path === p.path) === i).slice(0, 6)
      return recent.every((p, i) => state.recent[i]?.path === p.path) && recent.length === state.recent.length ? state : { ...state, recent }
    }
    case 'set':
      return { ...state, ...action.patch }
  }
}

/** Parses the persisted blob, tolerating older or foreign shapes */
export function parseUi(json: string | null): UiState {
  if (!json) return initialUi
  try {
    const raw: unknown = JSON.parse(json)
    if (typeof raw !== 'object' || raw === null) return initialUi
    const ui = { ...initialUi, ...(raw as Partial<UiState>) }
    // Before splits the quick window kept one shell's id
    const quick: unknown = ui.quick
    return typeof quick === 'string' ? { ...ui, quick: { type: 'pane', session: quick } } : ui
  } catch {
    return initialUi
  }
}

/**
 * Reconciles the saved layout with the daemon's sessions: panes whose session is gone drop out, live sessions
 * without a tab get their own. The quick terminal's shells belong to its own window, until an agent runs in one
 */
/** `kept`: leaves that aren't sessions but still exist, like open chats */
export function restore(saved: UiState, sessions: SessionInfo[], kept: string[] = []): UiState {
  const live = new Set([...sessions.map((s) => s.id), ...kept])
  let state = saved
  for (const session of new Set(saved.tabs.flatMap((t) => leaves(t.root)))) {
    if (!live.has(session)) state = withoutSession(state, session)
  }
  const shown = new Set(state.tabs.flatMap((t) => leaves(t.root)))
  const quick = new Set(saved.quick ? leaves(saved.quick) : [])
  const orphans = sessions.filter((s) => !shown.has(s.id) && (!quick.has(s.id) || s.kind === 'claude' || s.kind === 'codex')).sort((a, b) => a.createdAt - b.createdAt)
  const tabs = [...state.tabs, ...orphans.map((s, i): Tab => ({ id: `t${s.id}-${i}`, root: { type: 'pane', session: s.id }, focus: s.id }))]
  const active = tabs.some((t) => t.id === state.active) ? state.active : (tabs[0]?.id ?? null)
  return { ...state, tabs, active }
}

/** Group a tab belongs to: a single pane follows its session's place, a split stays where it was made */
export function tabPlace(tab: Tab, placeOf: (session: string) => Place | undefined): string | undefined {
  const first = leaves(tab.root)[0]
  if (tab.root.type === 'split' && tab.place) return tab.place
  return placeOf(first)?.key
}

/** Sidebar top level: repos (root + worktrees) share one group, other places stand alone */
export const groupKey = (place: Place) => place.repoRoot ?? place.key

export const placeLabel = (place: Place) =>
  place.kind === 'scratch' ? '~' : place.repoName && place.kind !== 'folder' ? `${place.repoName}/${place.kind === 'detached' ? (place.head ?? place.name) : place.name}` : place.name

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

const UNIT: Rect = { x: 0, y: 0, w: 1, h: 1 }

function divide(rect: Rect, dir: SplitDir, ratio: number): [Rect, Rect] {
  if (dir === 'row') {
    const w = rect.w * ratio
    return [{ ...rect, w }, { ...rect, x: rect.x + w, w: rect.w - w }]
  }
  const h = rect.h * ratio
  return [{ ...rect, h }, { ...rect, y: rect.y + h, h: rect.h - h }]
}

/** Pane rectangles in a unit square: panes render flat, so a split never remounts a terminal */
export function paneRects(node: SplitNode, rect = UNIT, out = new Map<string, Rect>()): Map<string, Rect> {
  if (node.type === 'pane') return out.set(node.session, rect)
  const [a, b] = divide(rect, node.dir, node.ratio)
  paneRects(node.a, a, out)
  paneRects(node.b, b, out)
  return out
}

export interface Handle {
  path: string
  dir: SplitDir
  ratio: number
  /** The whole split's rectangle; the handle sits at `ratio` across it */
  rect: Rect
}

export function splitHandles(node: SplitNode, rect = UNIT, path = '', out: Handle[] = []): Handle[] {
  if (node.type === 'pane') return out
  out.push({ path, dir: node.dir, ratio: node.ratio, rect })
  const [a, b] = divide(rect, node.dir, node.ratio)
  splitHandles(node.a, a, `${path}a`, out)
  splitHandles(node.b, b, `${path}b`, out)
  return out
}

export interface PlaceTabs {
  place: Place
  tabs: Tab[]
}

export interface Group {
  key: string
  places: PlaceTabs[]
}

const KIND_RANK: Record<PlaceKind, number> = { root: 0, git: 0, worktree: 1, detached: 2, folder: 3, scratch: 4 }

/** Tabs by top-level group (a repo, a folder, ~), then by place; groups keep their saved order, new ones go last */
export function groupTabs(tabs: Tab[], placeOfTab: (tab: Tab) => Place, order: string[]): Group[] {
  const groups = new Map<string, Group>()
  for (const tab of tabs) {
    const place = placeOfTab(tab)
    const key = groupKey(place)
    const group = groups.get(key) ?? { key, places: [] }
    groups.set(key, group)
    const entry = group.places.find((p) => p.place.key === place.key)
    if (entry) entry.tabs.push(tab)
    else group.places.push({ place, tabs: [tab] })
  }
  const rank = (key: string) => (order.includes(key) ? order.indexOf(key) : Infinity)
  const sorted = [...groups.values()].sort((a, b) => rank(a.key) - rank(b.key))
  for (const group of sorted) group.places.sort((a, b) => KIND_RANK[a.place.kind] - KIND_RANK[b.place.kind] || a.place.name.localeCompare(b.place.name))
  return sorted
}

export type Direction = 'left' | 'right' | 'up' | 'down'

/** The pane next to `from` in `dir`, preferring the one that overlaps it most */
export function neighbor(root: SplitNode, from: string, dir: Direction): string | null {
  const rects = paneRects(root)
  const a = rects.get(from)
  if (!a) return null
  const eps = 1e-6
  const overlap = (lo1: number, hi1: number, lo2: number, hi2: number) => Math.min(hi1, hi2) - Math.max(lo1, lo2)
  let best: string | null = null
  let bestScore = -Infinity
  for (const [session, b] of rects) {
    if (session === from) continue
    const touches =
      dir === 'left' ? Math.abs(b.x + b.w - a.x) < eps : dir === 'right' ? Math.abs(a.x + a.w - b.x) < eps : dir === 'up' ? Math.abs(b.y + b.h - a.y) < eps : Math.abs(a.y + a.h - b.y) < eps
    if (!touches) continue
    const score = dir === 'left' || dir === 'right' ? overlap(a.y, a.y + a.h, b.y, b.y + b.h) : overlap(a.x, a.x + a.w, b.x, b.x + b.w)
    if (score > eps && score > bestScore) {
      best = session
      bestScore = score
    }
  }
  return best
}
