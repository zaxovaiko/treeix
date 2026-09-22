import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { WebviewTag } from 'electron'
import { createBridge } from '@treeix/sdk'
import { clearVitals, dropEntries } from './entries'
import { recordTitle, recordVisit } from './recent'
import { type BrowserTab, patchTab, updateBrowser, useBrowser } from './tabs'
import type { ElementSelection } from '../shared/types'
import { pickWinner } from './slot-winner'

const bridge = createBridge('browser')

// Slots are where a page may show: the Browser tab and the Browser panel. The newest mounted slot
// that is actually visible wins (a collapsed or hidden dock mounts at zero size and must not win)
const slots: HTMLDivElement[] = []
const slotListeners = new Set<() => void>()
const notifySlots = (): void => slotListeners.forEach((listener) => listener())
const subscribeSlots = (listener: () => void): (() => void) => {
  slotListeners.add(listener)
  return () => slotListeners.delete(listener)
}

let winner: HTMLDivElement | null = null

export function useSlot(): { ref: (element: HTMLDivElement | null) => void; shown: boolean; elsewhere: boolean } {
  const own = useRef<HTMLDivElement | null>(null)
  const shown = useSyncExternalStore(subscribeSlots, () => own.current !== null && winner === own.current)
  // Only another slot on screen counts; with none, this one simply has no page yet
  const elsewhere = useSyncExternalStore(subscribeSlots, () => winner !== null && winner !== own.current)
  // Stable, so React calls it only on mount and unmount and the newest mounted slot stays last
  const ref = useCallback((element: HTMLDivElement | null): void => {
    if (own.current === element) return
    if (own.current) {
      slots.splice(slots.indexOf(own.current), 1)
      if (winner === own.current) winner = null
    }
    own.current = element
    if (element) slots.push(element)
    notifySlots()
  }, [])
  return { ref, shown, elsewhere }
}

export const slotRect = (): DOMRect | null => winner?.getBoundingClientRect() ?? null

const views = new Map<string, WebviewTag>()
export const pageOf = (tabId: string): WebviewTag | undefined => views.get(tabId)

const messageListeners = new Set<(tabId: string, channel: string, args: unknown[]) => void>()
export function onPageMessage(listener: (tabId: string, channel: string, args: unknown[]) => void): () => void {
  messageListeners.add(listener)
  return () => messageListeners.delete(listener)
}

const sameRect = (a: DOMRect | null, b: DOMRect | null): boolean =>
  a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height)

/** Every open page, laid over the shown slot; pages never move in the DOM, so switching tab and panel doesn't reload them */
export function PageLayer({ children }: { children?: React.ReactNode }): React.JSX.Element {
  const { tabs, activeId } = useBrowser()
  const [rect, setRect] = useState<DOMRect | null>(null)
  const hasSlot = useSyncExternalStore(subscribeSlots, () => slots.length > 0)
  useEffect(() => {
    if (!hasSlot) {
      setRect(null)
      return
    }
    // ponytail: polls the slot's rect every frame, since a ResizeObserver misses moves; an observer on the dock if this shows up in a profile
    let frame = 0
    const tick = (): void => {
      const nextWinner = pickWinner(slots)
      if (nextWinner !== winner) {
        winner = nextWinner
        notifySlots()
      }
      const next = slotRect()
      setRect((current) => (sameRect(current, next) ? current : next))
      frame = requestAnimationFrame(tick)
    }
    tick()
    return () => cancelAnimationFrame(frame)
  }, [hasSlot])
  const box = rect ?? new DOMRect(0, 0, 0, 0)
  return (
    <div
      data-browser
      style={{ position: 'fixed', left: box.x, top: box.y, width: box.width, height: box.height, visibility: rect ? 'visible' : 'hidden', zIndex: 10 }}
    >
      {tabs.map((tab) => (
        <Page key={tab.id} tab={tab} active={tab.id === activeId} />
      ))}
      {children}
    </div>
  )
}

function Page({ tab, active }: { tab: BrowserTab; active: boolean }): React.JSX.Element {
  const ref = useRef<WebviewTag | null>(null)
  // The first URL only; later navigation goes through the page itself so history stays intact
  const [src] = useState(tab.url)
  useEffect(() => {
    const view = ref.current
    if (!view) return
    views.set(tab.id, view)
    let guestId: number | null = null
    const patch = (change: Partial<BrowserTab>): void => updateBrowser((state) => patchTab(state, tab.id, change))
    const history = (): Partial<BrowserTab> => ({ canGoBack: view.canGoBack(), canGoForward: view.canGoForward() })
    const handlers: [string, (event: Event & Record<string, unknown>) => void][] = [
      ['did-start-loading', () => patch({ loading: true, crashed: false })],
      [
        'did-fail-load',
        (event) => {
          // -3 is a load cut short by another one, like a redirect or a click during loading
          if (event.isMainFrame === false || event.errorCode === -3) return
          // The failed address stays in the bar, so a first load that never connected still says what it tried
          patch({ url: String(event.validatedURL), loading: false, error: { code: Number(event.errorCode), description: String(event.errorDescription), url: String(event.validatedURL) } })
        }
      ],
      ['did-stop-loading', () => patch({ loading: false, ...history() })],
      [
        'did-navigate',
        (event) => {
          const code = Number(event.httpResponseCode)
          patch({ url: String(event.url), status: code > 0 ? code : null, error: null, committed: true, ...history() })
          recordVisit(String(event.url))
          try {
            clearVitals(view.getWebContentsId())
          } catch {
            // Not attached yet: the page's first navigation, before dom-ready
          }
        }
      ],
      ['did-navigate-in-page', (event) => event.isMainFrame !== false && patch({ url: String(event.url), ...history() })],
      [
        'page-title-updated',
        (event) => {
          patch({ title: String(event.title) })
          recordTitle(view.getURL(), String(event.title))
        }
      ],
      ['page-favicon-updated', (event) => patch({ favicon: Array.isArray(event.favicons) ? String(event.favicons[0] ?? '') || null : null })],
      ['render-process-gone', () => patch({ crashed: true, loading: false })],
      ['ipc-message', (event) => messageListeners.forEach((listener) => listener(tab.id, String(event.channel), Array.isArray(event.args) ? event.args : []))],
      [
        'dom-ready',
        () => {
          guestId = view.getWebContentsId()
          patch({ guestId })
          void bridge.invoke('attach', guestId)
          view.send('design', design.on)
        }
      ]
    ]
    for (const [name, handler] of handlers) view.addEventListener(name, handler as EventListener)
    return () => {
      for (const [name, handler] of handlers) view.removeEventListener(name, handler as EventListener)
      views.delete(tab.id)
      // Unmounting means the tab closed, so its console and network lists go with it
      if (guestId !== null) dropEntries(guestId)
    }
  }, [tab.id])
  return (
    <webview
      ref={ref}
      src={src}
      // A page's popups become tabs in main; the attribute only lets window.open reach that handler
      allowpopups
      // A blank tab stays hidden so the view's empty state shows through
      // So does one still connecting or failed, for the view's loader and error page
      style={{ position: 'absolute', inset: 0, visibility: active && tab.url !== 'about:blank' && tab.committed && !tab.error ? 'visible' : 'hidden' }}
    />
  )
}

type Design = { on: boolean; selection: { tabId: string; value: ElementSelection } | null }
let design: Design = { on: false, selection: null }
const designListeners = new Set<() => void>()
const setDesignState = (next: Design): void => {
  design = next
  designListeners.forEach((listener) => listener())
}
export const useDesign = (): Design =>
  useSyncExternalStore(
    (listener) => {
      designListeners.add(listener)
      return () => designListeners.delete(listener)
    },
    () => design
  )
export const getDesign = (): Design => design

/** Design mode applies to every open page, so switching tabs keeps it */
export function setDesign(on: boolean): void {
  views.forEach((view) => view.send('design', on))
  setDesignState({ on, selection: on ? design.selection : null })
}

function isSelection(value: unknown): value is ElementSelection {
  const candidate = value as Partial<ElementSelection> | null
  return !!candidate && typeof candidate.selector === 'string' && typeof candidate.html === 'string' && typeof candidate.url === 'string' && typeof candidate.rect?.x === 'number' && typeof candidate.viewport?.width === 'number'
}

onPageMessage((tabId, channel, args) => {
  if (channel === 'design-exit') setDesign(false)
  if (channel === 'selection' && isSelection(args[0])) setDesignState({ ...design, selection: { tabId, value: args[0] } })
})

export const clearSelection = (): void => setDesignState({ ...design, selection: null })
