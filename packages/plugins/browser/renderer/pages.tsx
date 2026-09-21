import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { WebviewTag } from 'electron'
import { createBridge } from '@treeix/sdk'
import { type BrowserTab, patchTab, updateBrowser, useBrowser } from './tabs'

const bridge = createBridge('browser')

// Slots are where a page may show: the Browser tab and the Browser panel. The newest mounted one wins
const slots: HTMLDivElement[] = []
const slotListeners = new Set<() => void>()
const notifySlots = (): void => slotListeners.forEach((listener) => listener())
const subscribeSlots = (listener: () => void): (() => void) => {
  slotListeners.add(listener)
  return () => slotListeners.delete(listener)
}

export function useSlot(): { ref: (element: HTMLDivElement | null) => void; shown: boolean } {
  const own = useRef<HTMLDivElement | null>(null)
  const shown = useSyncExternalStore(subscribeSlots, () => own.current !== null && slots.at(-1) === own.current)
  const ref = (element: HTMLDivElement | null): void => {
    if (own.current === element) return
    if (own.current) slots.splice(slots.indexOf(own.current), 1)
    own.current = element
    if (element) slots.push(element)
    notifySlots()
  }
  return { ref, shown }
}

export const slotRect = (): DOMRect | null => slots.at(-1)?.getBoundingClientRect() ?? null

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
  useEffect(() => {
    // ponytail: polls the slot's rect every frame, since a ResizeObserver misses moves; an observer on the dock if this shows up in a profile
    let frame = 0
    const tick = (): void => {
      const next = slotRect()
      setRect((current) => (sameRect(current, next) ? current : next))
      frame = requestAnimationFrame(tick)
    }
    tick()
    return () => cancelAnimationFrame(frame)
  }, [])
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
    const patch = (change: Partial<BrowserTab>): void => updateBrowser((state) => patchTab(state, tab.id, change))
    const history = (): Partial<BrowserTab> => ({ canGoBack: view.canGoBack(), canGoForward: view.canGoForward() })
    const handlers: [string, (event: Event & Record<string, unknown>) => void][] = [
      ['did-start-loading', () => patch({ loading: true, crashed: false })],
      ['did-stop-loading', () => patch({ loading: false, ...history() })],
      ['did-navigate', (event) => patch({ url: String(event.url), ...history() })],
      ['did-navigate-in-page', (event) => event.isMainFrame !== false && patch({ url: String(event.url), ...history() })],
      ['page-title-updated', (event) => patch({ title: String(event.title) })],
      ['page-favicon-updated', (event) => patch({ favicon: Array.isArray(event.favicons) ? String(event.favicons[0] ?? '') || null : null })],
      ['render-process-gone', () => patch({ crashed: true, loading: false })],
      ['ipc-message', (event) => messageListeners.forEach((listener) => listener(tab.id, String(event.channel), Array.isArray(event.args) ? event.args : []))],
      [
        'dom-ready',
        () => {
          const guestId = view.getWebContentsId()
          patch({ guestId })
          void bridge.invoke('attach', guestId)
        }
      ]
    ]
    for (const [name, handler] of handlers) view.addEventListener(name, handler as EventListener)
    return () => {
      for (const [name, handler] of handlers) view.removeEventListener(name, handler as EventListener)
      views.delete(tab.id)
    }
  }, [tab.id])
  return (
    <webview
      ref={ref}
      src={src}
      // A page's popups become tabs in main; the attribute only lets window.open reach that handler
      allowpopups
      style={{ position: 'absolute', inset: 0, visibility: active ? 'visible' : 'hidden' }}
    />
  )
}
