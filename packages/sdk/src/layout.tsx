import { createContext, type CSSProperties, type ReactNode, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Icon } from '@treeix/app/Icon'
import { ResizeHandle } from '@treeix/app/ui'
import { HostContext } from './index'
import { isJson, object } from '@treeix/shared/json'
import { actionKeys } from '@treeix/shared/keymap'
import { readStored } from '@treeix/app/storage'

/**
 * Focus zones, v3's keyboard model: the window is split into zones that F6 cycles through, the focused one framed.
 * Inside a zone j/k move a cursor and Esc steps back a level; the terminal keeps every bare key.
 */
export type ZoneId = 'list' | 'main' | 'inspector' | 'dock'
const ZONE_ORDER: ZoneId[] = ['list', 'main', 'inspector', 'dock']

/** Keys and what they do, e.g. ['j k', 'move']; a space separates keys pressed one after another */
export type KeyHint = [keys: string, label: string]

/** A key binding listed in the shortcut sheet and Settings; `page` is the tab id it applies on, absent for everywhere */
export type ShortcutInfo = { keys: string; label: string; section: string; page?: string }

/** Panels a key toggles; list and inspector are remembered per page, the others for the whole window */
export type PanelName = 'list' | 'inspector' | 'title'

type PagePanels = { list: boolean; inspector: boolean; listWidth: number | null; inspectorWidth: number | null }
type StoredPanels = { title: boolean; pages: Record<string, PagePanels> }

export type ShellState = StoredPanels & {
  zone: ZoneId
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
  const defaults: StoredPanels = { title: true, pages: {} }
  const record = readStored(PANELS_KEY)
  if (!isJson(record)) return defaults
  const flag = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback)
  const width = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
  return {
    title: flag(record.title, defaults.title),
    pages: Object.fromEntries(
      Object.entries(object(record.pages)).flatMap(([page, prefs]) =>
        isJson(prefs)
          ? [[page, { list: flag(prefs.list, true), inspector: flag(prefs.inspector, true), listWidth: width(prefs.listWidth), inspectorWidth: width(prefs.inspectorWidth) }]]
          : []
      )
    )
  }
}

let state: ShellState = { ...loadPanels(), zone: 'main', zen: false, leader: false, recording: false }
const listeners = new Set<() => void>()
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const getShell = (): ShellState => state

export function updateShell(patch: Partial<ShellState>): void {
  state = { ...state, ...patch }
  if ('title' in patch || 'pages' in patch) {
    const { title, pages } = state
    localStorage.setItem(PANELS_KEY, JSON.stringify({ title, pages }))
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

/** The zone to act on: the innermost one that has a layout box, so zones of a page kept mounted off screen are passed over */
export function chooseZone<T>(
  candidates: T[],
  shown: (candidate: T) => boolean,
  contains: (outer: T, inner: T) => boolean,
  prefer: (candidate: T) => boolean = () => false
): T | null {
  const visible = candidates.filter(shown)
  const innermost = visible.filter((candidate) => !visible.some((other) => other !== candidate && contains(candidate, other)))
  return innermost.find(prefer) ?? innermost[0] ?? null
}

/** The zone element itself; a page's main zone inside the shell's main zone wins over it */
function zoneElement(zone: ZoneId): HTMLElement | null {
  const all = [...document.querySelectorAll<HTMLElement>(`[data-zone="${zone}"]`)]
  // With a split open both sides have their zones on screen; the side holding the keyboard is the one to act on
  const pane = document.activeElement?.closest('[data-split-pane]') ?? null
  return chooseZone(
    all,
    (element) => element.checkVisibility(),
    (outer, inner) => outer.contains(inner),
    (element) => (element.closest('[data-split-pane]') ?? null) === pane
  )
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
  if (state.zone !== 'main') return (focusZone('main'), true)
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
  if (panel === 'title') return
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
  title: boolean
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
    title: visible(shell.title),
    zen: shell.zen,
    toggle: (panel) => togglePanel(panel, key),
    toggleZen
  }
}

/** The focused zone, and a way to move focus to another one */
export function useZone(): { zone: ZoneId; focusZone: (zone: ZoneId) => void } {
  const zone = useSyncExternalStore(subscribe, () => state.zone)
  return { zone, focusZone }
}

/**
 * A focus zone: clicking or focusing inside it makes it the focused zone, F6 visits it, and while focused it gets
 * the inset frame. Mark the element that should take keyboard
 * focus when the zone is entered with `data-zone-focus`; later visits return to whatever was focused last.
 */
export function Zone({ id, className = '', style, children }: { id: ZoneId; className?: string; style?: CSSProperties; children?: ReactNode }): React.JSX.Element {
  const ref = useRef<HTMLElement>(null)
  const focused = useSyncExternalStore(subscribe, () => state.zone === id)
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

/** A panel floating over the page, as the AI Hub's list and inspector do */
export const ISLAND = 'rounded-xl border border-border bg-popover shadow-xl shadow-black/40'

/** In a narrow page, like one opened beside another, main keeps this much: side panels shrink to SIDE_MIN, then the inspector and then the list hide */
const MAIN_MIN = 240
const SIDE_MIN = 150

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
  listWidth = 280,
  inspectorWidth = 300,
  resizable = true,
  defaults,
  islands,
  ownInspector = false
}: {
  id?: string
  /**
   * Floats the list over main as an island, Figma style, folding to a pill with this label. Main stays full width and
   * gets `--island-left`, the room the island or pill takes, to pad what must stay clear of it
   */
  islands?: string
  /** Main draws its own inspector, so the panel key toggles it; it reads the flag from usePanels */
  ownInspector?: boolean
  /** Panels shown until the user toggles them on this page */
  defaults?: Partial<Pick<PagePanels, 'list' | 'inspector'>>
  list?: ReactNode
  main?: ReactNode
  inspector?: ReactNode
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
  for (const key of new Set([page, activePage])) pageParts.set(key, { list: list !== undefined, inspector: inspector !== undefined || ownInspector })
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
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(Infinity)
  useLayoutEffect(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    if (ref.current) observer.observe(ref.current)
    return () => observer.disconnect()
  }, [])
  const showList = list !== undefined && prefs.list && !shell.zen && width >= MAIN_MIN + SIDE_MIN
  const showInspector = inspector !== undefined && prefs.inspector && !shell.zen && width >= MAIN_MIN + SIDE_MIN * (showList ? 2 : 1)
  const pill = useRef<HTMLButtonElement>(null)
  const [pillWidth, setPillWidth] = useState(0)
  useLayoutEffect(() => setPillWidth(pill.current?.offsetWidth ?? 0), [showList, islands])
  if (islands !== undefined)
    return (
      <div ref={ref} className="relative flex min-h-0 min-w-0 flex-1">
        {showList ? (
          <Zone id="list" style={{ width: listSize, minWidth: Math.min(SIDE_MIN, listSize) }} className={`absolute top-2 bottom-2 left-2 z-20 ${ISLAND}`}>
            {list}
            {resizable && <ResizeHandle onResize={(next) => setPagePanels(page, { listWidth: next })} />}
          </Zone>
        ) : (
          list !== undefined && (
            <button
              ref={pill}
              title={`Show the list (${actionKeys('panel.listAlt')})`}
              onClick={() => togglePanel('list', page)}
              className={`absolute top-2 left-2 z-20 flex h-10 items-center gap-2 px-3 text-xs hover:bg-accent ${ISLAND}`}
            >
              <Icon name="panel" className="size-3.5 shrink-0 text-muted-foreground" />
              {islands}
            </button>
          )
        )}
        <Zone
          id="main"
          style={{ minWidth: Math.min(MAIN_MIN, width), '--island-left': `${(showList ? listSize : pillWidth) + 8}px` } as CSSProperties}
          className="flex-1 bg-background"
        >
          {claimDock && host ? host.withDock(main) : main}
        </Zone>
      </div>
    )
  return (
    <div ref={ref} className="flex min-h-0 min-w-0 flex-1">
      {showList && (
        <Zone id="list" style={{ width: listSize, minWidth: Math.min(SIDE_MIN, listSize) }} className="border-r border-border bg-sidebar">
          {list}
          {resizable && <ResizeHandle onResize={(next) => setPagePanels(page, { listWidth: next })} />}
        </Zone>
      )}
      <Zone id="main" style={{ minWidth: Math.min(MAIN_MIN, width) }} className="flex-1 bg-background">
        {claimDock && host ? host.withDock(main) : main}
      </Zone>
      {showInspector && (
        <Zone id="inspector" style={{ width: inspectorSize, minWidth: Math.min(SIDE_MIN, inspectorSize) }} className="border-l border-border bg-card">
          {inspector}
          {resizable && <ResizeHandle edge="left" onResize={(next) => setPagePanels(page, { inspectorWidth: next })} />}
        </Zone>
      )}
    </div>
  )
}

/** Text fields, the code editor and the terminal's hidden textarea keep every bare key */
export function isTyping(event: KeyboardEvent): boolean {
  const origin = event.composedPath()[0]
  return (
    origin instanceof HTMLInputElement ||
    origin instanceof HTMLTextAreaElement ||
    origin instanceof HTMLSelectElement ||
    (origin instanceof HTMLElement && origin.isContentEditable)
  )
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

/** Window keys for a page; a page kept mounted off screen only gets them while they are its own. Returning true takes the key */
export function usePageKeys(page: string, onKey: (event: KeyboardEvent) => boolean): void {
  const latest = useRef(onKey)
  latest.current = onKey
  const mine = useRef(false)
  mine.current = useContext(HostContext)?.keyboardPage === page
  useEffect(() => {
    const listener = (event: KeyboardEvent): void => {
      if (mine.current && latest.current(event)) event.preventDefault()
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [])
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
  const keys = actionKeys('panel.list')
  const label = `${panels.list ? 'Hide' : 'Show'} list${keys ? ` (${keys})` : ''}`
  return (
    <button
      title={label}
      aria-label={label}
      onClick={() => panels.toggle('list')}
      className="flex h-6 shrink-0 items-center gap-1 rounded-md px-1 text-muted-foreground hover:bg-accent hover:text-foreground [-webkit-app-region:no-drag]"
    >
      <Icon name="panel" className="size-3.5" />
      {keys && <Kbd hint>{keys}</Kbd>}
    </button>
  )
}

const MODIFIER_KEYS = new Set(['Meta', 'Alt', 'Control'])
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
      if (!MODIFIER_KEYS.has(event.key)) return hide()
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
