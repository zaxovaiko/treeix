import { createContext, type CSSProperties, type ReactNode, useContext, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { Icon } from '@treeix/app/Icon'
import { ResizeHandle } from '@treeix/app/ui'
import { HostContext } from './index'

/**
 * Focus zones, v3's keyboard model: the window is split into zones that F6 cycles through, the focused one framed.
 * Inside a zone j/k move a cursor and Esc steps back a level; the terminal keeps every bare key.
 */
export type ZoneId = 'rail' | 'list' | 'main' | 'inspector' | 'dock'
export const ZONE_ORDER: ZoneId[] = ['rail', 'list', 'main', 'inspector', 'dock']
export const ZONE_LABELS: Record<ZoneId, string> = { rail: 'Workspaces', list: 'List', main: 'Main', inspector: 'Inspector', dock: 'Bottom terminal' }

/** Keys and what they do, e.g. ['j k', 'move']; a space separates keys pressed one after another */
export type KeyHint = [keys: string, label: string]

/** A key binding listed in the shortcut sheet and Settings; `page` is the tab id it applies on, absent for everywhere */
export type ShortcutInfo = { keys: string; label: string; section: string; page?: string }

/** Panels a key toggles; list and inspector are remembered per page, the others for the whole window */
export type PanelName = 'list' | 'inspector' | 'rail' | 'title' | 'status'

type PagePanels = { list: boolean; inspector: boolean; listWidth: number | null; inspectorWidth: number | null }
type StoredPanels = { rail: boolean; title: boolean; status: boolean; pages: Record<string, PagePanels> }

export type ShellState = StoredPanels & {
  zone: ZoneId
  /** Name of the focused zone for the status bar, e.g. "Tasks" for a list of tasks */
  zoneLabel: string
  /** Key hints of the focused zone, shown in the status bar */
  hints: KeyHint[]
  /** Only the main zone is shown */
  zen: boolean
  /** G or ⌘G was pressed and the next key picks where to go */
  leader: boolean
  /** Settings is recording a shortcut; the shell's own chords stand aside so the keys get recorded */
  recording: boolean
}

const PANELS_KEY = 'shell.panels'
const DEFAULT_PAGE: PagePanels = { list: true, inspector: true, listWidth: null, inspectorWidth: null }

function loadPanels(): StoredPanels {
  const defaults: StoredPanels = { rail: true, title: true, status: false, pages: {} }
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(PANELS_KEY) ?? 'null')
    if (typeof stored !== 'object' || stored === null) return defaults
    const record = stored as Record<string, unknown>
    const flag = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback)
    const width = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
    const pages = typeof record.pages === 'object' && record.pages !== null ? Object.entries(record.pages as Record<string, unknown>) : []
    return {
      rail: flag(record.rail, defaults.rail),
      title: flag(record.title, defaults.title),
      status: flag(record.status, defaults.status),
      pages: Object.fromEntries(
        pages.flatMap(([page, value]) => {
          if (typeof value !== 'object' || value === null) return []
          const prefs = value as Record<string, unknown>
          return [[page, { list: flag(prefs.list, true), inspector: flag(prefs.inspector, true), listWidth: width(prefs.listWidth), inspectorWidth: width(prefs.inspectorWidth) }]]
        })
      )
    }
  } catch {
    return defaults
  }
}

let state: ShellState = { ...loadPanels(), zone: 'main', zoneLabel: ZONE_LABELS.main, hints: [], zen: false, leader: false, recording: false }
const listeners = new Set<() => void>()
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const getShell = (): ShellState => state

export function updateShell(patch: Partial<ShellState>): void {
  state = { ...state, ...patch }
  if ('rail' in patch || 'title' in patch || 'status' in patch || 'pages' in patch) {
    const { rail, title, status, pages } = state
    localStorage.setItem(PANELS_KEY, JSON.stringify({ rail, title, status, pages }))
  }
  listeners.forEach((listener) => listener())
}

export const useShell = (): ShellState => useSyncExternalStore(subscribe, getShell)

/** Panels a page starts with until toggled, e.g. a pull request's files without the inspector, which the diff needs the width of */
const pageDefaults = new Map<string, Partial<Pick<PagePanels, 'list' | 'inspector'>>>()
/** The view a page shows that remembers its panels apart, e.g. 'prs' showing 'prs:files'; the panel keys act on it */
const pageViews = new Map<string, string>()
const pagePanels = (page: string): PagePanels => state.pages[page] ?? { ...DEFAULT_PAGE, ...pageDefaults.get(page) }
const setPagePanels = (page: string, patch: Partial<PagePanels>): void => updateShell({ pages: { ...state.pages, [page]: { ...pagePanels(page), ...patch } } })

/** Shows a page's list or inspector if it is hidden; never hides it */
export function showPanel(panel: 'list' | 'inspector', page: string): void {
  if (!pagePanels(page)[panel]) setPagePanels(page, { [panel]: true })
}

/** The zone element itself; a page's main zone inside the shell's main zone wins over it */
function zoneElement(zone: ZoneId): HTMLElement | null {
  const all = [...document.querySelectorAll<HTMLElement>(`[data-zone="${zone}"]`)]
  return all.find((element) => !element.querySelector(`[data-zone="${zone}"]`)) ?? null
}

/** The element last focused inside each zone, so coming back lands where you left (the terminal you typed in) */
const lastFocused = new WeakMap<HTMLElement, HTMLElement>()

/** Where keyboard focus lands in a zone: where it was last, else the marked element, else a terminal, else the zone */
function moveFocusInto(element: HTMLElement): void {
  const remembered = lastFocused.get(element)
  const target =
    (remembered?.isConnected && element.contains(remembered) ? remembered : null) ??
    element.querySelector<HTMLElement>('[data-zone-focus]') ??
    element.querySelector<HTMLElement>('[data-session-id] textarea') ??
    element
  target.focus({ preventScroll: true })
}

/** Makes `zone` the focused one and moves keyboard focus into it once it is on screen; main when the page has no such zone */
export function focusZone(zone: ZoneId): void {
  if (state.zone !== zone) updateShell({ zone })
  requestAnimationFrame(() => {
    const element = zoneElement(zone)
    if (element) moveFocusInto(element)
    else if (zone !== 'main') focusZone('main')
  })
}

/** F6 and ⇧F6: the next or previous zone on screen */
export function cycleZone(step: 1 | -1): void {
  const shown = ZONE_ORDER.filter((zone) => zoneElement(zone))
  if (shown.length === 0) return
  const index = shown.indexOf(state.zone)
  focusZone(shown[(index + step + shown.length) % shown.length])
}

/** Esc outside inputs and terminals: detail back to the list, side zones back to main; false when there is nowhere to go */
export function zoneBack(): boolean {
  if (state.zone === 'list') return false
  if (state.zone !== 'main') return focusZone('main'), true
  if (!zoneElement('list')) return false
  focusZone('list')
  return true
}

/** Shows or hides a panel. A panel shown gets focus, a focused one hidden hands focus to main, so the same key undoes it */
export function togglePanel(panel: PanelName, page: string): void {
  if (state.zen) updateShell({ zen: false })
  let shown: boolean
  if (panel === 'list' || panel === 'inspector') {
    const view = pageViews.get(page) ?? page
    shown = !pagePanels(view)[panel]
    setPagePanels(view, { [panel]: shown })
  } else {
    shown = !state[panel]
    updateShell({ [panel]: shown })
  }
  if (panel === 'title' || panel === 'status') return
  if (shown) focusZone(panel)
  else if (state.zone === panel) focusZone('main')
}

/** ⌘⇧↵: only the main zone, or everything back as it was */
export function toggleZen(): void {
  updateShell({ zen: !state.zen })
  focusZone('main')
}

/** The page panels are remembered for: the active tab, or a document tab's parent */
const useActivePage = (): string => useContext(HostContext)?.activePage ?? ''

/** Which panels show on a page, with toggles for buttons like the list toggle at the left of a tab strip */
export function usePanels(page?: string): {
  list: boolean
  inspector: boolean
  rail: boolean
  title: boolean
  status: boolean
  zen: boolean
  toggle: (panel: PanelName) => void
  toggleZen: () => void
} {
  const activePage = useActivePage()
  const shell = useShell()
  const key = page ?? activePage
  const prefs = shell.pages[key] ?? { ...DEFAULT_PAGE, ...pageDefaults.get(key) }
  const visible = (on: boolean): boolean => on && !shell.zen
  return {
    list: visible(prefs.list),
    inspector: visible(prefs.inspector),
    rail: visible(shell.rail),
    title: visible(shell.title),
    status: visible(shell.status),
    zen: shell.zen,
    toggle: (panel) => togglePanel(panel, key),
    toggleZen
  }
}

/** The focused zone, and a way to move focus to another one */
export function useZone(): { zone: ZoneId; label: string; focusZone: (zone: ZoneId) => void } {
  const zone = useSyncExternalStore(subscribe, () => state.zone)
  const label = useSyncExternalStore(subscribe, () => state.zoneLabel)
  return { zone, label, focusZone }
}

/**
 * A focus zone: clicking or focusing inside it makes it the focused zone, F6 visits it, and while focused it gets
 * the inset frame and its `label` and `hints` show in the status bar. Mark the element that should take keyboard
 * focus when the zone is entered with `data-zone-focus`; later visits return to whatever was focused last.
 */
export function Zone({
  id,
  label,
  hints,
  className = '',
  style,
  children
}: {
  id: ZoneId
  label?: string
  hints?: KeyHint[]
  className?: string
  style?: CSSProperties
  children?: ReactNode
}): React.JSX.Element {
  const ref = useRef<HTMLElement>(null)
  const focused = useSyncExternalStore(subscribe, () => state.zone === id)
  const hintKey = JSON.stringify(hints ?? [])
  useEffect(() => {
    // The shell's main zone around a page's own main zone leaves the status bar to the inner one
    if (!focused || ref.current?.querySelector(`[data-zone="${id}"]`)) return
    updateShell({ zoneLabel: label ?? ZONE_LABELS[id], hints: hints ?? [] })
  }, [focused, label, hintKey])
  return (
    <section
      ref={ref}
      data-zone={id}
      data-focused={focused ? '' : undefined}
      // Focusable so a click on empty space inside moves keyboard focus here, away from a terminal elsewhere
      tabIndex={-1}
      onFocus={(event) => {
        const target = event.target
        if (target.closest('[data-zone]') !== event.currentTarget) return
        if (target !== event.currentTarget) lastFocused.set(event.currentTarget, target)
        if (state.zone !== id) updateShell({ zone: id })
      }}
      style={style}
      className={`flex min-h-0 min-w-0 flex-col ${className}`}
    >
      {children}
    </section>
  )
}

const LIST_LIMITS = { list: [180, 640], inspector: [220, 640] } as const

/** Side panels each page's layout offers, so a panel key on a page without that panel can say so instead of flipping hidden state */
const pageParts = new Map<string, { list: boolean; inspector: boolean }>()
export const pageHasPanel = (page: string, panel: 'list' | 'inspector'): boolean => pageParts.get(page)?.[panel] ?? false

/**
 * A page split into list, main and inspector zones, each optional. Visibility follows the per-page panel keys
 * (⌘⇧E list, ⌘⌥B inspector, ⌘⇧↵ zen) and dragged widths are remembered per page. `id` defaults to the active page;
 * pass one when a page has views that should remember panels apart, like a pull request's files.
 */
/**
 * Set by the host around a tab's content while the bottom panel sits beside the list: a PageLayout inside docks the panels
 * around its main zone and claims the slot, so the tab leaves out its own dock. Null inside a dock, so docks never nest
 */
export const DockSlot = createContext<(() => () => void) | null>(null)

export function PageLayout({
  id,
  list,
  main,
  inspector,
  listLabel,
  inspectorLabel,
  hints,
  listWidth = 280,
  inspectorWidth = 300,
  resizable = true,
  defaults
}: {
  id?: string
  /** Panels shown until the user toggles them on this page */
  defaults?: Partial<Pick<PagePanels, 'list' | 'inspector'>>
  list?: ReactNode
  main?: ReactNode
  inspector?: ReactNode
  /** Status bar names for the zones, e.g. "Tasks" */
  listLabel?: string
  inspectorLabel?: string
  hints?: Partial<Record<'list' | 'main' | 'inspector', KeyHint[]>>
  /** Starting widths in px, until the user drags them */
  listWidth?: number
  inspectorWidth?: number
  resizable?: boolean
}): React.JSX.Element {
  const activePage = useActivePage()
  const page = id ?? activePage
  const shell = useShell()
  if (defaults) pageDefaults.set(page, defaults)
  // Also under the active page, which is what the panel keys name
  for (const key of new Set([page, activePage])) pageParts.set(key, { list: list !== undefined, inspector: inspector !== undefined })
  useEffect(() => {
    if (page === activePage) return
    pageViews.set(activePage, page)
    return () => void (pageViews.get(activePage) === page && pageViews.delete(activePage))
  }, [page, activePage])
  const host = useContext(HostContext)
  const claimDock = useContext(DockSlot)
  useLayoutEffect(() => claimDock?.(), [claimDock])
  const prefs = pagePanels(page)
  const listSize = prefs.listWidth ?? listWidth
  const inspectorSize = prefs.inspectorWidth ?? inspectorWidth
  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      {list !== undefined && prefs.list && !shell.zen && (
        <Zone id="list" label={listLabel} hints={hints?.list} style={{ width: listSize }} className="shrink-0 border-r border-border bg-sidebar">
          {list}
          {resizable && <ResizeHandle width={listSize} min={LIST_LIMITS.list[0]} max={LIST_LIMITS.list[1]} onResize={(next) => setPagePanels(page, { listWidth: next })} />}
        </Zone>
      )}
      <Zone id="main" hints={hints?.main} className="flex-1 bg-background">
        {claimDock && host ? host.withDock(main) : main}
      </Zone>
      {inspector !== undefined && prefs.inspector && !shell.zen && (
        <Zone id="inspector" label={inspectorLabel} hints={hints?.inspector} style={{ width: inspectorSize }} className="shrink-0 border-l border-border bg-card">
          {inspector}
          {resizable && (
            <ResizeHandle edge="left" width={inspectorSize} min={LIST_LIMITS.inspector[0]} max={LIST_LIMITS.inspector[1]} onResize={(next) => setPagePanels(page, { inspectorWidth: next })} />
          )}
        </Zone>
      )}
    </div>
  )
}

/** Text fields, the code editor and the terminal's hidden textarea keep every bare key */
export function isTyping(event: KeyboardEvent): boolean {
  const origin = event.composedPath()[0]
  return origin instanceof HTMLInputElement || origin instanceof HTMLTextAreaElement || origin instanceof HTMLSelectElement || (origin instanceof HTMLElement && origin.isContentEditable)
}

/**
 * A bare key (⇧ allowed) a page's own shortcuts act on: focus is in its list, main or inspector zone, nothing is
 * typed into, and no leader, dialog or other handler took the key
 */
export function isPageKey(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || state.leader || isTyping(event)) return false
  if (state.zone !== 'list' && state.zone !== 'main' && state.zone !== 'inspector') return false
  const target = event.target instanceof Element ? event.target : null
  return !target || target === document.body || target.closest('[data-zone]') !== null
}

/** Marks a list row, and the one under the cursor */
export type ListRowProps = { 'data-list-row': ''; 'data-cursor'?: '' }

/**
 * Keyboard cursor for a list in a zone: j/k and arrows move it, Home/End (and ⇧G) jump, Enter opens the row, by default
 * by moving focus to main. The cursor is the selection, so a detail view following the selection follows the cursor;
 * Esc in main comes back to the list through the shell. Spread `rowProps(index)` on each row to mark and scroll to it.
 */
export function useListNav(options: {
  count: number
  /** The selected row, -1 when none */
  index: number
  onSelect: (index: number) => void
  onOpen?: (index: number) => void
  zone?: ZoneId
}): { rowProps: (index: number) => ListRowProps } {
  const latest = useRef(options)
  latest.current = options
  const zone = options.zone ?? 'list'
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const { count, index, onSelect, onOpen } = latest.current
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || state.zone !== zone || state.leader || count === 0 || isTyping(event)) return
      // Keys from a dialog or anywhere outside the zone are not for this list
      const target = event.target instanceof Element ? event.target : null
      if (target && target !== document.body && !zoneElement(zone)?.contains(target)) return
      if (event.key === 'Enter') {
        // A row focused by a click is a button too, but ⏎ opens the cursor row; other buttons keep their own ⏎
        if (index < 0 || (target?.closest('button, a, [role="button"]') && !target.hasAttribute('data-list-row'))) return
        event.preventDefault()
        return onOpen ? onOpen(index) : focusZone('main')
      }
      const step = event.key === 'j' || event.key === 'ArrowDown' ? 1 : event.key === 'k' || event.key === 'ArrowUp' ? -1 : 0
      const next = step ? Math.min(count - 1, Math.max(0, index < 0 ? 0 : index + step)) : event.key === 'Home' ? 0 : event.key === 'End' || event.key === 'G' ? count - 1 : null
      if (next === null) return
      event.preventDefault()
      if (next !== index) onSelect(next)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zone])
  useEffect(() => {
    zoneElement(zone)?.querySelector('[data-cursor]')?.scrollIntoView({ block: 'nearest' })
  }, [options.index])
  return { rowProps: (row) => (row === options.index ? { 'data-list-row': '', 'data-cursor': '' } : { 'data-list-row': '' }) }
}

/** A keycap; `on` is the highlighted look used while the leader key waits; a `hint` one shows only while a modifier is held (see useModifierHints) */
export function Kbd({ children, on = false, hint = false }: { children: ReactNode; on?: boolean; hint?: boolean }): React.JSX.Element {
  return (
    <kbd data-key-hint={hint ? '' : undefined} className={on ? 'kbd kbd-on' : 'kbd'}>
      {children}
    </kbd>
  )
}

/** "G T" is two keycaps pressed one after the other; "⌘⇧E" is one chord */
export function Keys({ combo, on = false, hint = false }: { combo: string; on?: boolean; hint?: boolean }): React.JSX.Element {
  return (
    <span data-key-hint={hint ? '' : undefined} className="inline-flex items-center gap-0.5">
      {combo.split(' ').map((key, index) => (
        <Kbd key={index} on={on}>
          {key}
        </Kbd>
      ))}
    </span>
  )
}

/** Hides or shows the page's list; sits at the left of the main header in both states so a hidden list comes back with one click */
export function ListToggle({ page }: { page?: string }): React.JSX.Element {
  const panels = usePanels(page)
  const label = `${panels.list ? 'Hide' : 'Show'} list (⌘⇧E)`
  return (
    <button title={label} aria-label={label} onClick={() => panels.toggle('list')} className="flex h-6 shrink-0 items-center gap-1 rounded-md px-1 text-muted-foreground hover:bg-accent hover:text-foreground [-webkit-app-region:no-drag]">
      <Icon name="panel" className="size-3.5" />
      <Kbd hint>⌘⇧E</Kbd>
    </button>
  )
}

const MODIFIER_KEYS = ['Meta', 'Alt', 'Control']
const HINT_DELAY_MS = 300

/** Sets `data-hints` on <html> while ⌘, ⌥ or ⌃ is held on its own, which reveals the inline keycaps marked `data-key-hint` */
export function useModifierHints(): void {
  useEffect(() => {
    const root = document.documentElement
    let timer = 0
    const hide = (): void => {
      clearTimeout(timer)
      timer = 0
      root.removeAttribute('data-hints')
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      // Any other key means a shortcut is under way, so a quick one never flashes the hints
      if (!MODIFIER_KEYS.includes(event.key)) return hide()
      if (!timer && !root.hasAttribute('data-hints')) timer = window.setTimeout(() => root.setAttribute('data-hints', ''), HINT_DELAY_MS)
    }
    const onKeyUp = (event: KeyboardEvent): void => {
      if (!event.metaKey && !event.altKey && !event.ctrlKey) hide()
    }
    const onVisibility = (): void => void (document.hidden && hide())
    // Capture, so terminals and editors that stop key events still count
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('blur', hide)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      hide()
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('blur', hide)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])
}

export function KeyHintLabel({ hint: [keys, label] }: { hint: KeyHint }): React.JSX.Element {
  return (
    <span className="flex items-center gap-1 whitespace-nowrap">
      <Keys combo={keys} />
      <span>{label}</span>
    </span>
  )
}

/** Things the shell asks pages to do, like the leader's G H; a page that can handles it */
export type ShellCommand = 'closedSessions'
const commandListeners = new Map<ShellCommand, Set<() => void>>()

export function onShellCommand(command: ShellCommand, listener: () => void): () => void {
  const set = commandListeners.get(command) ?? new Set()
  commandListeners.set(command, set)
  set.add(listener)
  return () => set.delete(listener)
}

/** False when nothing handles the command, e.g. the plugin that could is off */
export function runShellCommand(command: ShellCommand): boolean {
  const set = commandListeners.get(command)
  set?.forEach((listener) => listener())
  return (set?.size ?? 0) > 0
}
