import { useEffect, useState } from 'react'
import type { McpAgent, McpInstallState, McpStatus } from '../../ipc/api'
import { Icon } from '../../lib/icons'
import { Modal } from '../../dialogs/index'
import type { ShellView } from '../../shell/Shell'
import { FIcon } from '../agents/icons'

const NAME: Record<McpAgent, string> = { claude: 'Claude Code', codex: 'Codex' }
const STATE: Record<McpInstallState, [label: string, tone: string]> = { installed: ['Set up', 'green'], outdated: ['Outdated', 'amber'], missing: ['Not set up', ''] }
const names = (agents: McpAgent[]) => agents.map((a) => NAME[a]).join(' and ')

/** Registers the Treeix MCP server with Claude Code and Codex; the token stays in the backend */
export function McpSetup({ view, onClose }: { view: ShellView; onClose: () => void }) {
  const { api } = view
  const [status, setStatus] = useState<McpStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    void api.mcpStatus().then(setStatus, (e: unknown) => setResult({ ok: false, text: e instanceof Error ? e.message : String(e) }))
  }, [api, reload])

  const install = () => {
    setBusy(true)
    setResult(null)
    void api
      .mcpInstall()
      .then(
        ({ installed, failed }) =>
          setResult(
            failed.length
              ? { ok: false, text: `Could not set up the Treeix MCP in ${failed.map(([a, e]) => `${NAME[a]}: ${e}`).join('; ')}` }
              : { ok: true, text: `Treeix MCP set up in ${names(installed)}. New agent sessions pick it up.` }
          ),
        (e: unknown) => setResult({ ok: false, text: e instanceof Error ? e.message : String(e) })
      )
      .finally(() => {
        setBusy(false)
        setReload((n) => n + 1)
      })
  }

  const done = !!status?.installs.length && status.installs.every((i) => i.state === 'installed')
  return (
    <Modal className="mcp" busy={busy} onClose={onClose}>
      <h3>
        <FIcon name="plug" />
        Set up Treeix MCP
      </h3>
      <p className="dim">Agents can open files, panes and worktrees in Treeix.</p>
      {status && !status.running && (
        <div className="banner amber">
          <Icon name="alert" />
          <span className="grow">The MCP server is not running. Agents reach it only while Treeix is open with MCP on.</span>
        </div>
      )}
      {!status ? (
        <div className="empty">Checking Claude Code and Codex...</div>
      ) : (
        <>
          <div className="mcpag">
            {status.installs.map(({ agent, state }) => (
              <div key={agent} className="mcprow">
                <span className={`ki ${agent}`}>
                  <Icon name={agent} />
                </span>
                <span className="grow">{NAME[agent]}</span>
                <span className={`tag ${STATE[state][1]}`}>{STATE[state][0]}</span>
              </div>
            ))}
          </div>
          {status.tools.length > 0 && (
            <>
              <div className="mlabel">Tools agents get</div>
              <div className="mcptools">
                {status.tools.map((t) => (
                  <div key={t.name}>
                    <span className="mono">{t.name}</span>
                    <span className="dim">{t.description}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
      {result && <div className={`nwchk ${result.ok ? 'go' : 'err'}`}>{result.text}</div>}
      <div className="mft">
        <span className="dim mono trunc">{status?.url ?? ''}</span>
        <button className="btn" onClick={onClose}>
          {done ? 'Close' : 'Cancel'}
        </button>
        <button className="btn pri" disabled={!status || busy} onClick={install}>
          {busy ? 'Setting up...' : done ? 'Set up again' : 'Set up'}
        </button>
      </div>
    </Modal>
  )
}
