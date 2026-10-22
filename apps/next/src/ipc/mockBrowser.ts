import type { Api, BrowserEntry, BrowserEvent, BrowserState } from './api'

// Phase 7 browser pane demo (owner B7). The mock has no webview: the pane draws a placeholder where it would sit.
// localhost:5173 is the seeded `bun dev` session's dev server (mockAgents' ports); other localhost ports fail

type BrowserApi = Pick<
  Api,
  | 'browserOpen' | 'browserPlace' | 'browserClose' | 'browserNavigate' | 'browserGo' | 'browserDevtools'
  | 'browserCookieProfiles' | 'browserImportCookies' | 'browserClearData' | 'browserDevCommand' | 'onBrowser'
>

const AT = Date.UTC(2026, 9, 22, 11, 58)

const ENTRIES: BrowserEntry[] = [
  { kind: 'network', id: 'n1', method: 'GET', url: 'http://localhost:5173/', status: 200, failed: null, startedAt: AT, durationMs: 12 },
  { kind: 'network', id: 'n2', method: 'GET', url: 'http://localhost:5173/src/main.tsx', status: 200, failed: null, startedAt: AT + 20, durationMs: 31 },
  { kind: 'console', id: 'c1', level: 'debug', text: '[vite] connected.', source: 'client:912', time: AT + 140 },
  { kind: 'network', id: 'n3', method: 'GET', url: 'http://localhost:5173/api/odds?market=1x2', status: 500, failed: null, startedAt: AT + 410, durationMs: 88 },
  { kind: 'console', id: 'c2', level: 'error', text: 'Uncaught TypeError: Cannot read properties of undefined (reading \'price\')', source: 'OddsTable.tsx:42', time: AT + 520 },
  { kind: 'console', id: 'c3', level: 'warning', text: 'Each child in a list should have a unique "key" prop.', source: 'Markets.tsx:18', time: AT + 530 },
]

const DEV_COMMANDS: Record<string, string> = {
  '/Users/me/projects/treeix': 'bun dev',
  '/Users/me/projects/betfeel/api': 'pnpm dev',
}

/** What the address bar turns typed text into */
export function browserUrl(input: string, searchUrl = 'https://www.google.com/search?q=%s'): string {
  const text = input.trim()
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(text)) return `http://${text}`
  if (/^[^\s/]+\.[a-z]{2,}(:\d+)?(\/\S*)?$/i.test(text)) return `https://${text}`
  return searchUrl.replace('%s', encodeURIComponent(text))
}

export function browserMock(): BrowserApi {
  const panes = new Map<string, { state: BrowserState; history: string[]; at: number }>()
  const listeners = new Set<(e: BrowserEvent) => void>()
  const fire = (e: BrowserEvent) => listeners.forEach((cb) => cb(e))
  const get = (pane: string) => {
    const found = panes.get(pane)
    if (!found) throw new Error(`no browser pane ${pane}`)
    return found
  }
  const load = (pane: string, url: string) => {
    const p = get(pane)
    const host = new URL(url).host
    const down = /^(localhost|127\.0\.0\.1)/.test(host) && host !== 'localhost:5173'
    p.state = {
      ...p.state,
      url,
      title: down ? host : host === 'localhost:5173' ? 'Treeix' : host,
      loading: false,
      canGoBack: p.at > 0,
      canGoForward: p.at < p.history.length - 1,
      error: down ? `Nothing is answering on ${host}` : null,
    }
    fire({ type: 'changed', state: p.state })
    fire({ type: 'entries', pane, reset: true, entries: host === 'localhost:5173' ? ENTRIES : [] })
  }

  return {
    async browserOpen(pane, url) {
      if (!panes.has(pane)) {
        panes.set(pane, { state: { pane, url: '', title: '', loading: false, canGoBack: false, canGoForward: false, error: null }, history: url ? [url] : [], at: 0 })
        if (url) load(pane, browserUrl(url))
      }
      return get(pane).state
    },
    browserPlace: async () => {},
    async browserClose(pane) {
      if (panes.delete(pane)) fire({ type: 'closed', pane })
    },
    async browserNavigate(pane, input) {
      const p = get(pane)
      const url = browserUrl(input)
      p.history = [...p.history.slice(0, p.history.length ? p.at + 1 : 0), url]
      p.at = p.history.length - 1
      load(pane, url)
    },
    async browserGo(pane, nav) {
      const p = get(pane)
      if (nav === 'stop' || !p.history.length) return
      if (nav === 'back') p.at = Math.max(0, p.at - 1)
      if (nav === 'forward') p.at = Math.min(p.history.length - 1, p.at + 1)
      load(pane, p.history[p.at] ?? p.state.url)
    },
    browserDevtools: async () => {},
    browserCookieProfiles: async () => [
      { key: 'chrome:Default', browser: 'Chrome', name: 'Personal', blocked: false },
      { key: 'chrome:Profile 1', browser: 'Chrome', name: 'Work', blocked: false },
      { key: 'arc:Default', browser: 'Arc', name: 'Default', blocked: false },
      { key: 'safari', browser: 'Safari', name: 'Safari', blocked: true },
    ],
    async browserImportCookies(profile) {
      if (profile === 'safari') return { imported: 0, skipped: 0, error: 'Treeix needs Full Disk Access to read Safari cookies' }
      return { imported: 412, skipped: 9, error: null }
    },
    browserClearData: async () => {},
    browserDevCommand: async (folder) => DEV_COMMANDS[folder] ?? null,
    onBrowser(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
}
