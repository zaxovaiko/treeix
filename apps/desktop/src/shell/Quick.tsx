import { useEffect, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import type { Api } from '../ipc/api'
import { TerminalPane } from '../panes/terminal'
import type { Renderer } from '../panes/terminal/renderer'
import { paneGrid } from '../panes/terminal/xterm'
import { IN_TAURI, setZoom, UI_CHANGED } from '../lib/native'
import { followedMode, useAppliedSettings } from '../pages/settings'
import { applyTheme, type Mode } from '../styles/theme'
import { parseUi, type UiState } from './state'

type Look = Pick<UiState, 'theme' | 'ui' | 'renderer' | 'zoom'>

const GONE = new Set(['exited', 'restored', 'crashed'])

/** Its shell, reused while it lives; a new one in ~ otherwise, recorded under `quick` in the UI blob */
async function quickSession(api: Api, onLook: (look: Look) => void): Promise<string> {
  const [json, list, home] = await Promise.all([api.getUi(), api.sessions(), api.homeDir()])
  const saved = parseUi(json)
  onLook({ ...saved, theme: followedMode(saved.theme) })
  const alive = list.find((s) => s.id === saved.quick && !GONE.has(s.status))
  if (alive) return alive.id
  const info = await api.create({ kind: 'shell', cwd: home, ...paneGrid(innerWidth, innerHeight) })
  const latest = parseUi(await api.getUi())
  await api.putUi(JSON.stringify({ ...latest, quick: info.id }))
  return info.id
}

/** The quick terminal window: one terminal under a thin drag strip */
export function Quick({ api }: { api: Api }) {
  const [session, setSession] = useState<string | null>(null)
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
      void quickSession(api, look).then((id) => {
        current = id
        if (!cancelled) setSession(id)
      })
    open()
    const off = api.onEvent((e) => {
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
      <div className="drag" data-tauri-drag-region />
      {session && (
        <div className="pterm">
          <TerminalPane api={api} sessionId={session} visible focused onFocus={() => {}} renderer={renderer} />
        </div>
      )}
    </div>
  )
}
