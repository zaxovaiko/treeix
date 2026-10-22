import { useEffect, useState } from 'react'
import type { Api } from '../ipc/api'
import { TerminalPane } from '../panes/terminal'
import { applyTheme } from '../styles/theme'
import { parseUi } from './state'

const GONE = new Set(['exited', 'restored', 'crashed'])

/** Its shell, reused while it lives; a new one in ~ otherwise, recorded under `quick` in the UI blob */
async function quickSession(api: Api): Promise<string> {
  const [json, list, home] = await Promise.all([api.getUi(), api.sessions(), api.homeDir()])
  const saved = parseUi(json)
  applyTheme(saved.theme, saved.ui)
  const alive = list.find((s) => s.id === saved.quick && !GONE.has(s.status))
  if (alive) return alive.id
  const info = await api.create({ kind: 'shell', cwd: home, cols: 80, rows: 24 })
  const latest = parseUi(await api.getUi())
  await api.putUi(JSON.stringify({ ...latest, quick: info.id }))
  return info.id
}

/** The quick terminal window: one terminal under a thin drag strip */
export function Quick({ api }: { api: Api }) {
  const [session, setSession] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let current: string | null = null
    const open = () =>
      void quickSession(api).then((id) => {
        current = id
        if (!cancelled) setSession(id)
      })
    open()
    const off = api.onEvent((e) => {
      if (e.type !== 'exit' || e.session !== current) return
      void api.remove(e.session)
      open()
    })
    return () => {
      cancelled = true
      off()
    }
  }, [api])

  return (
    <div className="quick">
      <div className="drag" data-tauri-drag-region />
      {session && (
        <div className="pterm">
          <TerminalPane api={api} sessionId={session} visible focused onFocus={() => {}} />
        </div>
      )}
    </div>
  )
}
