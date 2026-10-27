import { useEffect, useState } from 'react'
import type { Place } from '../ipc/api'
import { restartServer, specsFor, useLsp, type ServerState } from '../lib/lsp'
import { CONFIG_FILE, type ServerSpec } from '../lib/lsp/servers'
import type { ShellView } from '../shell/Shell'
import { Head } from './common'

const STATE_LABEL: Record<ServerState, string> = { starting: 'starting', running: 'running', missing: 'not installed', failed: 'failed', stopped: 'idle' }
const SEVERITY_CLASS: Record<number, string> = { 1: 'err', 2: 'warn' }
const CONFIG_EXAMPLE = `{
  "lua": {
    "command": ["lua-language-server"],
    "files": ["*.lua"]
  }
}`

/** What the language servers found in this place's open files; a click opens the line */
export function Problems({ view, place }: { view: ShellView; place: Place }) {
  const root = place.path
  const problems = useLsp()
    .problems.filter((p) => p.path.startsWith(`${root}/`))
    .sort((a, b) => a.severity - b.severity || a.path.localeCompare(b.path) || a.line - b.line)
  return (
    <>
      <Head title="Problems" place={place} />
      <div className="pscroll">
        {problems.length === 0 && <div className="empty">No problems in open files</div>}
        {problems.map((p, i) => {
          const file = p.path.slice(root.length + 1)
          return (
            <div key={i} className="hrow open" onClick={() => view.openFile(root, file, p.line)}>
              <span className={`lsp-sev ${SEVERITY_CLASS[p.severity] ?? ''}`} />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="t lsp-msg">{p.message}</div>
                <div className="m trunc">
                  {file}:{p.line} · {p.source}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </>
  )
}

/** The servers this place can use, each one's state, and how to add another */
export function Servers({ view, place }: { view: ShellView; place: Place }) {
  const { api } = view
  const root = place.path
  const [specs, setSpecs] = useState<ServerSpec[]>([])
  const { servers } = useLsp()
  useEffect(() => {
    let live = true
    void specsFor(api, root).then((list) => live && setSpecs(list))
    return () => void (live = false)
  }, [api, root, servers])
  return (
    <>
      <Head title="Language servers" place={place} />
      <div className="pscroll">
        <div className="sec">This repo</div>
        {specs.map((spec) => {
          const server = servers.find((s) => s.root === root && s.spec.name === spec.name)
          const state = server?.state ?? 'stopped'
          return (
            <div key={spec.name} className="hrow">
              <span className={`lsp-st ${state}`} />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="t trunc">
                  {spec.name}
                  <span className="dim"> · {STATE_LABEL[state]}</span>
                </div>
                <div className="m lsp-msg">{server?.detail || `${spec.files.join(', ')}, starts with the first one opened`}</div>
              </div>
              {server && state !== 'starting' && (
                <button className="btn sm ghost" onClick={() => void restartServer(api, server.key)}>
                  Restart
                </button>
              )}
            </div>
          )
        })}
        <div className="sec">Any other server</div>
        <div className="lsp-hint">
          Anything that speaks LSP over stdio, per repo in <b>{CONFIG_FILE}</b>. A name above replaces that server.
          <pre>{CONFIG_EXAMPLE}</pre>
        </div>
      </div>
    </>
  )
}
