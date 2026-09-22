export type ConsoleEntry = { kind: 'console'; id: string; level: 'error' | 'warning' | 'info' | 'log' | 'debug'; text: string; source: string; stack: string; time: number }
export type NetworkEntry = {
  kind: 'network'
  id: string
  method: string
  url: string
  resourceType: string
  status: number | null
  failed: string | null
  mimeType: string
  startedAt: number
  durationMs: number | null
  requestHeaders: Record<string, string>
  responseHeaders: Record<string, string>
  postData: string | null
}
/** `detail` says more than the element (the image, the event, the script); `start` is ms after the page began loading */
export type Vital = { kind: 'vital'; id: string; name: 'LCP' | 'INP' | 'CLS' | 'Long task'; value: number; element: string; detail: string; start: number; time: number }
export type ElementSelection = { selector: string; tag: string; text: string; html: string; rect: { x: number; y: number; width: number; height: number }; viewport: { width: number; height: number }; url: string }
export type EntryBatch = { guestId: number; reset: boolean; console: ConsoleEntry[]; network: NetworkEntry[] }
export type BrowserProfile = { key: string; browser: string; name: string; blocked: boolean }
export type ImportResult = { imported: number; skipped: number; error: string | null }
export type ImportInfo = { browser: string; profile: string; at: number } | null
