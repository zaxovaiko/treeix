import { ipcRenderer } from 'electron'

type VitalMessage = { name: 'LCP' | 'INP' | 'CLS' | 'Long task'; value: number; element: string; detail: string; start: number; time: number }

const describe = (node: Node | null | undefined): string => {
  if (!(node instanceof Element)) return ''
  const id = node.id ? `#${node.id}` : ''
  const classes = [...node.classList].slice(0, 2).map((name) => `.${name}`).join('')
  return `${node.tagName.toLowerCase()}${id}${classes}`
}

const fileOf = (url: string): string => url.split(/[?#]/)[0].split('/').filter(Boolean).at(-1) ?? url

const send = (vital: VitalMessage): void => ipcRenderer.sendToHost('vital', vital)

const observe = (type: string, callback: (entries: PerformanceEntry[]) => void, options: Record<string, unknown> = {}): void => {
  try {
    new PerformanceObserver((list) => callback(list.getEntries())).observe({ type, buffered: true, ...options })
  } catch {
    // An entry type this Chromium doesn't record
  }
}

export function watchVitals(): void {
  observe('largest-contentful-paint', (entries) => {
    const last = entries.at(-1) as (PerformanceEntry & { element?: Element | null; url?: string; size?: number }) | undefined
    if (!last) return
    const detail = [last.url ? fileOf(last.url) : 'text', last.size ? `${Math.round(last.size).toLocaleString()} px²` : ''].filter(Boolean).join(' · ')
    send({ name: 'LCP', value: last.startTime, element: describe(last.element), detail, start: last.startTime, time: Date.now() })
  })
  let shift = 0
  let shifted: Node | null = null
  let shifts = 0
  let lastShift = 0
  observe('layout-shift', (entries) => {
    for (const entry of entries as (PerformanceEntry & { value: number; hadRecentInput: boolean; sources?: { node?: Node | null }[] })[]) {
      if (entry.hadRecentInput) continue
      shift += entry.value
      shifts++
      lastShift = entry.startTime
      shifted = entry.sources?.[0]?.node ?? shifted
    }
    send({ name: 'CLS', value: shift, element: describe(shifted), detail: `${shifts} shift${shifts === 1 ? '' : 's'}`, start: lastShift, time: Date.now() })
  })
  // ponytail: INP as the slowest interaction of the page load; the real metric takes a high percentile over the visit
  let slowest = 0
  observe(
    'event',
    (entries) => {
      for (const entry of entries as (PerformanceEntry & { target?: Node | null })[]) {
        if (entry.duration <= slowest) continue
        slowest = entry.duration
        send({ name: 'INP', value: entry.duration, element: describe(entry.target), detail: entry.name, start: entry.startTime, time: Date.now() })
      }
    },
    { durationThreshold: 40 }
  )
  observe('longtask', (entries) => {
    for (const entry of entries as (PerformanceEntry & { attribution?: { containerType?: string; containerSrc?: string; containerName?: string }[] })[]) {
      // `self` is this page's own main thread; an iframe or other frame names its source
      const container = entry.attribution?.[0]
      const frame = container?.containerSrc ? fileOf(container.containerSrc) : container?.containerName || ''
      const element = entry.name === 'self' ? 'main thread' : `${entry.name}${frame ? ` ${frame}` : ''}`
      send({ name: 'Long task', value: entry.duration, element, detail: container?.containerType && container.containerType !== 'window' ? container.containerType : '', start: entry.startTime, time: Date.now() })
    }
  })
}
