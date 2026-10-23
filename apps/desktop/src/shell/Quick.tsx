import { useEffect, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { Api } from '../ipc/api'
import { Icon } from '../lib/icons'
import { TerminalPane } from '../panes/terminal'
import type { Renderer } from '../panes/terminal/renderer'
import { paneGrid } from '../panes/terminal/xterm'
import { IN_TAURI, setZoom, UI_CHANGED } from '../lib/native'
import { followedMode, useAppliedSettings } from '../pages/settings'
import { applyTheme, type Mode } from '../styles/theme'
import { parseUi, type UiState } from './state'
import { acceleratorLabel } from './shortcuts'

type Look = Pick<UiState, 'theme' | 'ui' | 'renderer' | 'zoom'>
type Opened = { id: string; cwd: string; home: string; shortcut: string | null }

const GONE = new Set(['exited', 'restored', 'crashed'])

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

/** The quick terminal window: one terminal under a header with its folder and how to hide it */
export function Quick({ api }: { api: Api }) {
  const [session, setSession] = useState<Opened | null>(null)
  const [renderer, setRenderer] = useState<Renderer>('auto')
  const [mode, setMode] = useState<Mode>('dark')
  useAppliedSettings(api, mode, setMode)

  useEffect(() => {
    let cancelled = false
    let current: string | null = null
    const look = ({ theme, ui, renderer, zoom }: Look) => {
      applyTheme(theme, ui)
      void setZoom(zoom).catch((e: unknown) => console.warn('zoom:', e))
      setMode(theme)
      setRenderer(renderer)
    }
    const open = () =>
      void quickSession(api, look).then((opened) => {
        current = opened.id
        if (!cancelled) setSession(opened)
      })
    open()
    const off = api.onEvent((e) => {
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

  return (
    <div className="quick">
      {session && (
        <>
          <div className="qh">
            <Icon name="terminal" />
            <b>Quick terminal</b>
            <span className="mono">{session.cwd.startsWith(session.home) ? `~${session.cwd.slice(session.home.length)}` : session.cwd}</span>
            <span className="grow" />
            <button className="btn sm" onClick={() => void getCurrentWindow().hide()}>
              {session.shortcut && <kbd>{acceleratorLabel(session.shortcut)}</kbd>} Hide
            </button>
          </div>
          <div className="pterm">
            <TerminalPane api={api} sessionId={session.id} visible focused onFocus={() => {}} renderer={renderer} />
          </div>
        </>
      )}
    </div>
  )
}
