import { useEffect, useEffectEvent, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import type { Api, SessionEvent } from '../ipc/api'
import type { SessionInfo } from '../ipc/bindings'
import { TerminalPane } from '../panes/terminal'
import type { Renderer } from '../panes/terminal/renderer'
import { IS_MAC, paneGrid } from '../panes/terminal/xterm'
import { IN_TAURI, onMenuItem, runInMain, setQuickLook, setZoom, UI_CHANGED } from '../lib/native'
import { Icon } from '../lib/icons'
import { resolveShortcut } from '../lib/hotkeys'
import { settingsNow } from '../features/agents/settings'
import { followedMode, useAppliedSettings } from '../pages/settings'
import { applyTheme, type Mode } from '../styles/theme'
import { leaves, neighbor, paneRects, parseUi, removeLeaf, replaceLeaf, setRatio, splitHandles, type SplitDir, type SplitNode, type UiState } from './state'
import { isCommandId, shortcutsPaused, withHint, type CommandId } from './shortcuts'
import { DOT_LABEL, KIND_ICON, Ki, statusDot, tilde } from './model'
import { box, dragHandle, handleBox } from './Panes'

type Look = Pick<UiState, 'theme' | 'ui' | 'renderer' | 'zoom' | 'quickAnimate' | 'quickOpacity' | 'quickBlur'>
type Layout = { root: SplitNode; focus: string }

const GONE = new Set(['exited', 'restored', 'crashed'])
/** Events that change which sessions run or how their rows read */
const SESSION_EVENTS = new Set(['created', 'removed', 'exit', 'status', 'title', 'kind', 'cwd'])
const PERSIST_MS = 300
const pane = (session: string): SplitNode => ({ type: 'pane', session })
const isAgent = (s: SessionInfo) => s.kind === 'claude' || s.kind === 'codex'

/** The saved panes whose sessions still run; a gone shell leaves the daemon too, a gone agent belongs to the main window */
function livePanes(api: Api, root: SplitNode | null, list: SessionInfo[]): SplitNode | null {
  for (const id of root ? leaves(root) : []) {
    const info = list.find((s) => s.id === id)
    if (info && !GONE.has(info.status)) continue
    if (info?.kind === 'shell') void api.remove(id)
    root = root && removeLeaf(root, id)
  }
  return root
}

const paneBox = (session: string): DOMRect => document.querySelector(`.term[data-session-id="${CSS.escape(session)}"]`)?.closest('.pane')?.getBoundingClientRect() ?? new DOMRect(0, 0, innerWidth, innerHeight)

/**
 * The quick terminal window: its own shells in splits, recorded under `quick` in the UI blob, the running agents beside
 * them to open in a split
 */
export function Quick({ api }: { api: Api }) {
  const [renderer, setRenderer] = useState<Renderer>('auto')
  const [mode, setMode] = useState<Mode>('dark')
  const [home, setHome] = useState('')
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [layout, setLayout] = useState<Layout | null>(null)
  useAppliedSettings(api, mode, setMode)

  const infoOf = (id: string) => sessions.find((s) => s.id === id)
  const agents = sessions.filter((s) => isAgent(s) && !GONE.has(s.status)).sort((a, b) => a.createdAt - b.createdAt)
  const shown = layout ? leaves(layout.root) : []

  const newShell = async (cwd: string, { width, height } = new DOMRect(0, 0, innerWidth, innerHeight)) => {
    const info = await api.create({ kind: 'shell', cwd, ...paneGrid(width, height) })
    setSessions((all) => [...all, info])
    return info
  }

  /** Beside `from`: `session`, or a new shell in its folder */
  const split = (dir: SplitDir, from = layout?.focus, session?: string) => {
    if (!from) return
    const at = paneBox(from)
    const half = dir === 'row' ? new DOMRect(0, 0, at.width / 2, at.height) : new DOMRect(0, 0, at.width, at.height / 2)
    const opened = session ? Promise.resolve(session) : newShell(infoOf(from)?.cwd ?? home, half).then((info) => info.id)
    void opened.then((id) => setLayout((l) => l && { root: replaceLeaf(l.root, from, { type: 'split', dir, ratio: 0.5, a: pane(from), b: pane(id) }), focus: id }))
  }

  /** The pane goes; the last one gives way to a new shell */
  const drop = (id: string) => {
    if (!layout || !shown.includes(id)) return
    const root = removeLeaf(layout.root, id)
    if (root) return setLayout({ root, focus: leaves(root).includes(layout.focus) ? layout.focus : leaves(root)[0] })
    void newShell(home).then((info) => setLayout({ root: pane(info.id), focus: info.id }))
  }
  /** A shell is this window's and ends with its pane; an agent keeps running in the main window */
  const close = (id: string) => {
    drop(id)
    if (infoOf(id)?.kind === 'shell') void api.remove(id)
  }
  const focus = (id: string) => setLayout((l) => l && { ...l, focus: id })

  const onEvent = useEffectEvent((e: SessionEvent) => {
    if (SESSION_EVENTS.has(e.type)) void api.sessions().then(setSessions)
    if (e.type === 'removed') drop(e.session)
    // A shell that exits closes its pane; the removal drops it
    if (e.type === 'exit' && shown.includes(e.session) && infoOf(e.session)?.kind === 'shell') void api.remove(e.session)
  })

  const run = (id: CommandId): boolean => {
    if (!layout) return false
    if (id === 'split-right' || id === 'split-down') split(id === 'split-right' ? 'row' : 'col')
    else if (id === 'close-pane') close(layout.focus)
    else if (id.startsWith('focus-')) {
      const dir = id.slice(6)
      const next = dir === 'left' || dir === 'right' || dir === 'up' || dir === 'down' ? neighbor(layout.root, layout.focus, dir) : null
      if (next) focus(next)
    } else return false
    return true
  }
  const onKey = useEffectEvent((e: KeyboardEvent) => {
    if (shortcutsPaused()) return
    const id = resolveShortcut(e, settingsNow()?.keys ?? {})
    if (!id || !run(id)) return
    e.preventDefault()
    e.stopPropagation()
  })
  // Menu bar chords come here while this window is in front; the panes select all, the main window runs the rest
  const onMenu = useEffectEvent((id: string) => {
    if (shortcutsPaused() || id === 'select-all' || (isCommandId(id) && run(id))) return
    void runInMain(id, !id.startsWith('zoom-')).catch((e: unknown) => console.warn('menu:', e))
  })

  useEffect(() => {
    let cancelled = false
    const look = ({ theme, ui, renderer, zoom, quickAnimate, quickOpacity, quickBlur }: Look) => {
      applyTheme(theme, ui)
      // Only the Mac window is transparent; elsewhere a see-through page would show the webview's own fill
      document.documentElement.style.setProperty('--quick-alpha', `${IS_MAC ? Math.round(Math.min(1, Math.max(0.3, quickOpacity)) * 100) : 100}%`)
      void setQuickLook(quickAnimate, quickBlur).catch((e: unknown) => console.warn('quick look:', e))
      void setZoom(zoom).catch((e: unknown) => console.warn('zoom:', e))
      setMode(theme)
      setRenderer(renderer)
    }
    void Promise.all([api.getUi(), api.sessions(), api.homeDir()]).then(async ([json, list, dir]) => {
      const saved = parseUi(json)
      look({ ...saved, theme: followedMode(saved.theme) })
      setHome(dir)
      setSessions(list)
      const root = livePanes(api, saved.quick, list) ?? pane((await newShell(dir)).id)
      if (!cancelled) setLayout({ root, focus: leaves(root)[0] })
    })
    const off = api.onEvent(onEvent)
    const stopMenu = onMenuItem((id) => onMenu(id))
    const key = (e: KeyboardEvent) => onKey(e)
    window.addEventListener('keydown', key, true)
    // The main window owns the look; follow it live
    const unlisten = IN_TAURI ? listen<Look>(UI_CHANGED, (e) => look(e.payload)) : null
    return () => {
      cancelled = true
      off()
      stopMenu()
      window.removeEventListener('keydown', key, true)
      void unlisten?.then((stop) => stop())
    }
  }, [api])

  const root = layout?.root
  useEffect(() => {
    if (!root) return
    const timer = setTimeout(() => void api.getUi().then((json) => api.putUi(JSON.stringify({ ...parseUi(json), quick: root }))), PERSIST_MS)
    return () => clearTimeout(timer)
  }, [api, root])

  if (!layout) return <div className="quick" />
  const rects = paneRects(layout.root)
  const multi = rects.size > 1

  return (
    <div className="quick">
      <div className="qbody">
        {agents.length > 0 && (
          <nav className="qside" aria-label="Agents">
            {agents.map((a) => (
              <button key={a.id} className={shown.includes(a.id) ? 'on' : ''} onClick={() => (shown.includes(a.id) ? focus(a.id) : split('row', layout.focus, a.id))} title={`${tilde(a.cwd, home)}: open in a split`}>
                <Ki kind={a.kind} dot={statusDot(a.status)} sm />
                <span className="trunc">{a.title}</span>
              </button>
            ))}
          </nav>
        )}
        <div className="qpanes">
          <div className="panes">
            {[...rects].sort(([a], [b]) => a.localeCompare(b)).map(([id, rect]) => {
              const info = infoOf(id)
              const dot = info ? statusDot(info.status) : 'idle'
              const isFocus = id === layout.focus
              return (
                <div key={id} className={`pane ${multi ? (isFocus ? 'focus' : 'dimmed') : ''}`} style={box(rect)}>
                  {multi && (
                    <div className="phd" onMouseDown={() => focus(id)}>
                      <Icon name={KIND_ICON[info?.kind ?? 'shell']} />
                      <span className="trunc grow">{info?.title ?? 'zsh'}</span>
                      {dot !== 'idle' && <span className={`st-${dot} trunc`}>{DOT_LABEL[dot].toLowerCase()}</span>}
                      <button className="icon sm" onClick={() => split('row', id)} title={withHint('Split right', 'split-right')}>
                        <Icon name="split" />
                      </button>
                      <button className="icon sm" onClick={() => split('col', id)} title={withHint('Split down', 'split-down')}>
                        <Icon name="splitDown" />
                      </button>
                      <button className="icon sm" onClick={() => close(id)} title={withHint(info && isAgent(info) ? 'Close pane, the agent keeps running' : 'Close pane', 'close-pane')}>
                        <Icon name="x" />
                      </button>
                    </div>
                  )}
                  <div className="pterm">
                    <TerminalPane api={api} sessionId={id} visible focused={isFocus} onFocus={() => focus(id)} renderer={renderer} />
                  </div>
                </div>
              )
            })}
            {splitHandles(layout.root).map((handle) => (
              <div key={handle.path} className={`psz ${handle.dir}`} style={handleBox(handle)} onPointerDown={dragHandle(handle, (ratio) => setLayout((l) => l && { ...l, root: setRatio(l.root, handle.path, Math.min(0.9, Math.max(0.1, ratio))) }))} />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
