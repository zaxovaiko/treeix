import { useEffect, useRef, useState, type RefObject } from 'react'
import type { Api, BrowserEntry, BrowserProfile, SessionPort } from '../../ipc/api'
import { Icon } from '../../lib/icons'
import { IN_TAURI } from '../../lib/native'
import { Group, Row, Seg, Select, Switch } from '../../pages/settings/controls'
import type { SectionProps } from '../../pages/settings/sections'
import type { ShellView } from '../../shell/Shell'
import { leaves } from '../../shell/state'
import { leafBrowser, rememberBrowser, useBrowserPage, watchBrowser } from './open'
import '../../styles/browser.css'

// Phase 7 browser pane (owner B7), loaded with the first browser pane. The page is a native child webview (src-tauri
// browser module) laid over the pane's slot; this draws the bar, the start and error pages and the dev strip around it

const GLYPHS = {
  reload: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7L12 6.3M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  plug: '<path d="M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-10 0zM12 16v5"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
} as const

const Glyph = ({ name }: { name: keyof typeof GLYPHS }) => <svg viewBox="0 0 24 24" aria-hidden dangerouslySetInnerHTML={{ __html: GLYPHS[name] }} />

/** Whatever floats over panes; the native webview would draw above it, so it hides while one overlaps */
const COVERS = '.scrim, .modal, .palette, .pop, .fpop, .lbox, .hud, [role=dialog], [role=menu]'

const overlaps = (a: DOMRect, b: DOMRect) => b.width > 0 && b.height > 0 && b.left < a.right && b.right > a.left && b.top < a.bottom && b.bottom > a.top
const covered = (slot: DOMRect) => [...document.querySelectorAll(COVERS)].some((el) => overlaps(slot, el.getBoundingClientRect()))

/** Keeps the pane's webview on the slot's rect: follows resize, scroll, splits and tabs; hidden when covered or not shown */
function useWebviewSlot(api: Pick<Api, 'browserPlace'>, pane: string, slot: RefObject<HTMLDivElement | null>, shown: boolean) {
  useEffect(() => {
    const place = (bounds: { x: number; y: number; width: number; height: number } | null) => void api.browserPlace(pane, bounds).catch(() => undefined)
    if (!shown) return place(null)
    let last = ''
    let frame = 0
    // ponytail: a rAF poll of the slot's rect, cheap next to a webview; observers per cause (resize, scroll, overlays) if it shows in profiles
    const tick = () => {
      frame = requestAnimationFrame(tick)
      const el = slot.current
      const r = el?.getBoundingClientRect()
      const visible = el && r && r.width > 0 && r.height > 0 && el.checkVisibility() && !covered(r)
      const bounds = visible ? { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } : null
      const key = JSON.stringify(bounds)
      if (key !== last) {
        last = key
        place(bounds)
      }
    }
    tick()
    return () => {
      cancelAnimationFrame(frame)
      place(null)
    }
  }, [api, pane, shown])
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** Live localhost ports while the start page shows, and the place's dev server command */
function StartPage({ view, folder, onOpen }: { view: ShellView; folder: string; onOpen: (input: string) => void }) {
  const [ports, setPorts] = useState<SessionPort[]>([])
  const [dev, setDev] = useState<string | null>(null)
  useEffect(() => {
    const load = () => void view.api.sessionPorts().then(setPorts, () => undefined)
    load()
    const timer = setInterval(load, 3000)
    return () => clearInterval(timer)
  }, [view.api])
  useEffect(() => void view.api.browserDevCommand(folder).then(setDev, () => setDev(null)), [view.api, folder])

  const runDev = async (command: string) => {
    const info = await view.api.create({ kind: 'shell', cwd: folder, cols: 80, rows: 24 })
    await view.api.write(info.id, `${command}\r`)
    view.dispatch({ type: 'split', session: info.id, dir: 'col' })
  }

  const unique = [...new Map(ports.map((p) => [p.port, p])).values()].sort((a, b) => a.port - b.port)
  return (
    <div className="bstart">
      <Icon name="globe" />
      <b>Open a page</b>
      <span className="dim">Type a URL or a search above{unique.length ? ', or pick a local server' : ''}</span>
      {(unique.length > 0 || dev) && (
        <div className="bchips">
          {unique.map((p) => (
            <button key={p.port} className="btn sm" title={p.command ?? undefined} onClick={() => onOpen(`localhost:${p.port}`)}>
              <Glyph name="plug" />
              localhost:{p.port}
            </button>
          ))}
          {dev && (
            <button className="btn sm" title={`Run ${dev} in ${folder}`} onClick={() => void runDev(dev)}>
              <Icon name="terminal" />
              {dev}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

type DevTab = 'console' | 'network'

const failedRequest = (e: Extract<BrowserEntry, { kind: 'network' }>) => e.failed !== null || (e.status ?? 0) >= 400

/** Console and network rows of the page; errors go to the tab's agent */
function DevStrip({ view, leaf, pane, entries, onClose }: { view: ShellView; leaf: string; pane: string; entries: BrowserEntry[]; onClose: () => void }) {
  const [tab, setTab] = useState<DevTab>('console')
  const body = useRef<HTMLDivElement>(null)
  const rows = entries.filter((e) => (tab === 'console' ? e.kind === 'console' : e.kind === 'network'))
  const errors = entries.some((e) => e.kind === 'console' && e.level === 'error')
  const owner = view.ui.tabs.find((t) => leaves(t.root).includes(leaf))
  const agent = owner && leaves(owner.root).find((id) => view.sessions[id]?.kind === 'claude' || view.sessions[id]?.kind === 'codex')

  useEffect(() => {
    const el = body.current
    if (el) el.scrollTop = el.scrollHeight
  }, [rows.length, tab])

  return (
    <div className="bdev">
      <div className="bdtabs">
        <div className="bdt">
          <button className={tab === 'console' ? 'on' : ''} onClick={() => setTab('console')}>
            Console{errors && <i aria-label="has errors" />}
          </button>
          <button className={tab === 'network' ? 'on' : ''} onClick={() => setTab('network')}>
            Network
          </button>
        </div>
        {IN_TAURI && (
          <button className="icon sm" title="Web inspector" onClick={() => void view.api.browserDevtools(pane)}>
            <Icon name="gear" />
          </button>
        )}
        <button className="icon sm" title="Close" onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      <div className="bdbody" ref={body}>
        {rows.length === 0 && <div className="empty">{tab === 'console' ? 'No console messages' : 'No requests'}</div>}
        {rows.map((e) =>
          e.kind === 'console' ? (
            <div key={e.id} className={`brow ${e.level === 'error' ? 'err' : e.level === 'warning' ? 'warn' : ''}`}>
              <span className="grow mono">{e.text}</span>
              {e.source && <span className="dim mono">{e.source}</span>}
              {e.level === 'error' && agent && (
                <button className="btn sm" onClick={() => void view.api.write(agent, `The browser page logged an error${e.source ? ` at ${e.source}` : ''}: ${e.text}`)}>
                  <Icon name={view.sessions[agent]?.kind === 'codex' ? 'codex' : 'claude'} />
                  Send to agent
                </button>
              )}
            </div>
          ) : (
            <div key={e.id} className={`brow ${failedRequest(e) ? 'err' : ''}`}>
              <span className="mono">{e.method}</span>
              <span className="grow mono">{e.url}</span>
              <span className="num">{e.failed ?? e.status ?? '...'}</span>
              <span className="num">{e.durationMs === null ? '' : `${Math.round(e.durationMs)} ms`}</span>
            </div>
          )
        )}
      </div>
    </div>
  )
}

/** The bar (back, forward, reload, address, dev strip, open outside), the webview's slot (`browserPlace`) and the dev strip */
export function BrowserPane({ view, leaf, focused }: { view: ShellView; leaf: string; focused: boolean }) {
  const pane = leafBrowser(leaf)
  const page = useBrowserPage(pane)
  const state = page?.state ?? null
  const [draft, setDraft] = useState<string | null>(null)
  const [dev, setDev] = useState(false)
  const slot = useRef<HTMLDivElement>(null)
  const address = useRef<HTMLInputElement>(null)
  const owner = view.ui.tabs.find((t) => leaves(t.root).includes(leaf))
  const folder = owner ? view.placeOfTab(owner).path : view.home

  useEffect(() => {
    watchBrowser(view.api)
    // Picks up the pane after a reload of the window; a new pane was opened by `openBrowser` already
    void view.api.browserOpen(pane, '').then(rememberBrowser, () => undefined)
  }, [view.api, pane])

  const blank = !state?.url
  useWebviewSlot(view.api, pane, slot, IN_TAURI && !blank && !state?.error)

  useEffect(() => {
    if (focused && blank) address.current?.focus()
  }, [focused, blank])

  const go = (input: string) => {
    const text = input.trim()
    setDraft(null)
    address.current?.blur()
    if (text) void view.api.browserNavigate(pane, text).catch(() => undefined)
  }

  return (
    <div className="browser">
      <div className="bbar">
        <button className="icon sm" title="Back" disabled={!state?.canGoBack} onClick={() => void view.api.browserGo(pane, 'back')}>
          <Icon name="left" />
        </button>
        <button className="icon sm" title="Forward" disabled={!state?.canGoForward} onClick={() => void view.api.browserGo(pane, 'forward')}>
          <Icon name="right" />
        </button>
        {state?.loading ? (
          <button className="icon sm" title="Stop" onClick={() => void view.api.browserGo(pane, 'stop')}>
            <Icon name="x" />
          </button>
        ) : (
          <button className="icon sm" title="Reload" disabled={blank} onClick={() => void view.api.browserGo(pane, 'reload')}>
            <Glyph name="reload" />
          </button>
        )}
        <input
          ref={address}
          className="burl"
          placeholder="Search or type a URL"
          spellCheck={false}
          value={draft ?? state?.url ?? ''}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.target.select()}
          onBlur={() => setDraft(null)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') go(e.currentTarget.value)
            if (e.key === 'Escape') {
              setDraft(null)
              e.currentTarget.blur()
            }
          }}
        />
        <button className={`icon sm ${dev ? 'on' : ''}`} title="Console and network" aria-pressed={dev} onClick={() => setDev(!dev)}>
          <Glyph name="layers" />
        </button>
        <button className="icon sm" title="Open in your browser" disabled={blank} onClick={() => state && void view.api.openUrl(state.url)}>
          <Glyph name="link" />
        </button>
      </div>
      <div className="bview" ref={slot}>
        {blank ? (
          <StartPage view={view} folder={folder} onOpen={go} />
        ) : state?.error ? (
          <div className="bmsg">
            <Glyph name="plug" />
            <b>{state.error}</b>
            <span className="dim">Start the dev server in a shell, then reload</span>
          </div>
        ) : (
          !IN_TAURI && (
            <div className="bmsg">
              <Icon name="globe" />
              <b>{state?.title || hostOf(state?.url ?? '')}</b>
              <span className="dim">The page shows here in the app</span>
            </div>
          )
        )}
      </div>
      {dev && <DevStrip view={view} leaf={leaf} pane={pane} entries={page?.entries ?? []} onClose={() => setDev(false)} />}
    </div>
  )
}

const ENGINES = [
  ['https://www.google.com/search?q=%s', 'Google'],
  ['https://duckduckgo.com/?q=%s', 'DuckDuckGo'],
  ['https://www.bing.com/search?q=%s', 'Bing'],
] as const

const profileLabel = (p: BrowserProfile) => `${p.browser}: ${p.name}${p.blocked ? ' (needs Full Disk Access)' : ''}`

/** Settings > Browser: links, search engine, agent tools, cookie import, clear data */
export function BrowserSection({ view, settings, update }: SectionProps) {
  const b = settings.browser
  const [profiles, setProfiles] = useState<BrowserProfile[]>([])
  const [profile, setProfile] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [cleared, setCleared] = useState(false)

  useEffect(() => {
    void view.api.browserCookieProfiles().then((list) => {
      setProfiles(list)
      setProfile((current) => current || (list.find((p) => !p.blocked) ?? list[0])?.key || '')
    }, () => undefined)
  }, [view.api])

  const chosen = profiles.find((p) => p.key === profile)
  const engines: readonly (readonly [string, string])[] = ENGINES.some(([url]) => url === b.searchUrl) ? ENGINES : [...ENGINES, [b.searchUrl, 'Custom']]

  const importCookies = async () => {
    setBusy(true)
    setNote(null)
    try {
      const result = await view.api.browserImportCookies(profile)
      setNote(result.error ?? `Imported ${result.imported} cookies${result.skipped ? `, skipped ${result.skipped}` : ''}`)
    } catch (e: unknown) {
      setNote(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Group title="Pages">
        <Row label="Open links in a browser pane" desc="Links clicked in terminals and chats open beside them instead of in your browser">
          <Switch label="Open links in a browser pane" on={b.openLinks} onChange={(openLinks) => update({ browser: { openLinks } })} />
        </Row>
        <Row label="Search engine" desc="What the address bar searches when you type words">
          <Seg value={b.searchUrl} options={engines} onChange={(searchUrl) => update({ browser: { searchUrl } })} />
        </Row>
      </Group>
      <Group title="Agents">
        <Row label="Browser tools for agents" desc="Claude and Codex can open pages, read them, click, type and take screenshots" keywords="mcp">
          <Switch label="Browser tools for agents" on={b.agents} onChange={(agents) => update({ browser: { agents } })} />
        </Row>
      </Group>
      <Group title="Data">
        <Row label="Import cookies" desc={note ?? 'Sign in once: copies the cookies of a browser profile into browser panes'} keywords="login session chrome arc firefox safari">
          {profiles.length > 0 ? (
            <>
              <Select value={profile} options={profiles.map((p) => [p.key, profileLabel(p)] as const)} onChange={setProfile} />
              <button className="btn sm" disabled={busy || !chosen || chosen.blocked} onClick={() => void importCookies()}>
                {busy ? 'Importing...' : 'Import'}
              </button>
            </>
          ) : (
            <span className="dim">No browser profiles found</span>
          )}
        </Row>
        <Row label="Clear browsing data" desc="Cookies, storage and cache of every browser pane">
          <button
            className="btn sm"
            disabled={cleared}
            onClick={() => void view.api.browserClearData().then(() => setCleared(true), (e: unknown) => setNote(String(e)))}
          >
            {cleared ? 'Cleared' : 'Clear'}
          </button>
        </Row>
      </Group>
    </>
  )
}
