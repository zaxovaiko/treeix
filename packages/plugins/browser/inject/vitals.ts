import { ipcRenderer } from 'electron'

type VitalMessage = { name: 'LCP' | 'INP' | 'CLS' | 'Long task'; value: number; element: string; time: number }

const describe = (node: Node | null | undefined): string => {
  if (!(node instanceof Element)) return ''
  const id = node.id ? `#${node.id}` : ''
  const classes = [...node.classList].slice(0, 2).map((name) => `.${name}`).join('')
  return `${node.tagName.toLowerCase()}${id}${classes}`
}

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
    const last = entries.at(-1) as (PerformanceEntry & { element?: Element | null }) | undefined
    if (last) send({ name: 'LCP', value: last.startTime, element: describe(last.element), time: Date.now() })
  })
  let shift = 0
  let shifted: Node | null = null
  observe('layout-shift', (entries) => {
    for (const entry of entries as (PerformanceEntry & { value: number; hadRecentInput: boolean; sources?: { node?: Node | null }[] })[]) {
      if (entry.hadRecentInput) continue
      shift += entry.value
      shifted = entry.sources?.[0]?.node ?? shifted
    }
    send({ name: 'CLS', value: shift, element: describe(shifted), time: Date.now() })
  })
  // ponytail: INP as the slowest interaction of the page load; the real metric takes a high percentile over the visit
  let slowest = 0
  observe(
    'event',
    (entries) => {
      for (const entry of entries as (PerformanceEntry & { target?: Node | null })[]) {
        if (entry.duration <= slowest) continue
        slowest = entry.duration
        send({ name: 'INP', value: entry.duration, element: describe(entry.target), time: Date.now() })
      }
    },
    { durationThreshold: 40 }
  )
  observe('longtask', (entries) => {
    for (const entry of entries) send({ name: 'Long task', value: entry.duration, element: entry.name, time: Date.now() })
  })
}
