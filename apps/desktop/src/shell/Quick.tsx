import { useEffect, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { Api } from '../ipc/api'
import type { SessionInfo } from '../ipc/bindings'
import { TerminalPane } from '../panes/terminal'
import type { Renderer } from '../panes/terminal/renderer'
import { IS_MAC, paneGrid } from '../panes/terminal/xterm'
import { IN_TAURI, setQuickLook, setZoom, UI_CHANGED } from '../lib/native'
import { followedMode, useAppliedSettings } from '../pages/settings'
import { applyTheme, type Mode } from '../styles/theme'
import { parseUi, type UiState } from './state'
import { acceleratorLabel } from './shortcuts'
import { Ki, statusDot, tilde } from './model'

type Look = Pick<UiState, 'theme' | 'ui' | 'renderer' | 'zoom' | 'quickAnimate' | 'quickOpacity' | 'quickBlur'>
type Opened = { id: string; cwd: string; home: string; shortcut: string | null }

const GONE = new Set(['exited', 'restored', 'crashed'])
/** Events that change which agents run or how their rows read */
const AGENT_EVENTS = new Set(['created', 'removed', 'exit', 'status', 'title', 'kind', 'cwd'])

async function liveAgents(api: Api): Promise<SessionInfo[]> {
  const list = await api.sessions()
  return list.filter((s) => (s.kind === 'claude' || s.kind === 'codex') && !GONE.has(s.status)).sort((a, b) => a.createdAt - b.createdAt)
}

/** Its shell, reused while it lives; a new one in ~ otherwise, recorded under `quick` in the UI blob */
async function quickSession(api: Api, onLook: (look: Look) => void): Promise<Opened> {
  const [json, list, home] = await Promise.all([api.getUi(), api.sessions(), api.homeDir()])
  const saved = parseUi(json)
  onLook({ ...saved, theme: followedMode(saved.theme) })
  const alive = list.find((s) => s.id === saved.quick && !GONE.has(s.status))
  const opened = (s: { id: string; cwd: string }) => ({ id: s.id, cwd: s.cwd, home, shortcut: saved.quickShortcut })
  if (alive) return opened(alive)
  const info = await api.create({ kind: 'shell', cwd: home, ...paneGrid(innerWidth, innerHeight) })
  const latest = parseUi(await api.getUi())
  await api.putUi(JSON.stringify({ ...latest, quick: info.id }))
  return opened(info)
}

/** The quick terminal window: its own shell, and the running agents beside it to switch to, under a header with the folder and how to hide it */
export function Quick({ api }: { api: Api }) {
  const [session, setSession] = useState<Opened | null>(null)
  const [renderer, setRenderer] = useState<Renderer>('auto')
  const [mode, setMode] = useState<Mode>('dark')
  const [agents, setAgents] = useState<SessionInfo[]>([])
  /** The agent shown instead of the shell; null: the shell */
  const [picked, setPicked] = useState<string | null>(null)
  useAppliedSettings(api, mode, setMode)

  useEffect(() => {
    let cancelled = false
    let current: string | null = null
    const look = ({ theme, ui, renderer, zoom, quickAnimate, quickOpacity, quickBlur }: Look) => {
      applyTheme(theme, ui)
      // Only the Mac window is transparent; elsewhere a see-through page would show the webview's own fill
      document.documentElement.style.setProperty('--quick-alpha', `${IS_MAC ? Math.round(Math.min(1, Math.max(0.3, quickOpacity)) * 100) : 100}%`)
      void setQuickLook(quickAnimate, quickBlur).catch((e: unknown) => console.warn('quick look:', e))
      void setZoom(zoom).catch((e: unknown) => console.warn('zoom:', e))
      setMode(theme)
      setRenderer(renderer)
    }
    const open = () =>
      void quickSession(api, look).then((opened) => {
        current = opened.id
        if (!cancelled) setSession(opened)
      })
    const refresh = () => void liveAgents(api).then((list) => !cancelled && setAgents(list))
    open()
    refresh()
    const off = api.onEvent((e) => {
      if (AGENT_EVENTS.has(e.type)) refresh()
      if (e.type === 'cwd' && e.session === current) setSession((s) => s && { ...s, cwd: e.cwd })
      if (e.type !== 'exit' || e.session !== current) return
      void api.remove(e.session)
      open()
    })
    // The main window owns the look; follow it live
    const unlisten = IN_TAURI ? listen<Look>(UI_CHANGED, (e) => look(e.payload)) : null
    return () => {
      cancelled = true
      off()
      void unlisten?.then((stop) => stop())
    }
  }, [api])

  const agent = agents.find((a) => a.id === picked)
  const shown = agent?.id ?? session?.id

  return (
    <div className="quick">
      {session && (
        <>
          <div className="qh">
            <span className="mono trunc">{tilde(agent?.cwd ?? session.cwd, session.home)}</span>
            <span className="grow" />
            <button onClick={() => void getCurrentWindow().hide()} title="Hide" aria-label="Hide">
              {session.shortcut ? <kbd>{acceleratorLabel(session.shortcut)}</kbd> : 'Hide'}
            </button>
          </div>
          <div className="qbody">
            {agents.length > 0 && (
              <nav className="qside" aria-label="Sessions">
                <button className={agent ? '' : 'on'} onClick={() => setPicked(null)}>
                  <Ki kind="shell" sm />
                  <span className="trunc">Shell</span>
                </button>
                {agents.map((a) => (
                  <button key={a.id} className={a.id === shown ? 'on' : ''} onClick={() => setPicked(a.id)} title={tilde(a.cwd, session.home)}>
                    <Ki kind={a.kind} dot={statusDot(a.status)} sm />
                    <span className="trunc">{a.title}</span>
                  </button>
                ))}
              </nav>
            )}
            <div className="pterm">
              <TerminalPane key={shown} api={api} sessionId={shown ?? session.id} visible focused onFocus={() => {}} renderer={renderer} />
            </div>
          </div>
        </>
      )}
    </div>
  )
}
