import { useEffect, useState } from 'react'
import { Icon } from './Icon'
import { errorMessage, IconButton } from './ui'

type McpStatus = Awaited<ReturnType<typeof window.api.mcpInstallStatus>>

/** Whether Treeix's MCP server is set up in Claude Code and Codex, and the install that refreshes it */
function useMcpInstall(): { status: McpStatus; pending: McpStatus; install: () => Promise<string> } {
  const [status, setStatus] = useState<McpStatus>([])
  const refresh = (): void => void window.api.mcpInstallStatus().then(setStatus, () => setStatus([]))
  useEffect(refresh, [])
  const install = async (): Promise<string> => {
    const { installed, failed } = await window.api.installMcp()
    refresh()
    return failed.length ? `Could not set up the Treeix MCP in ${failed.join(' and ')}` : `Treeix MCP set up in ${installed.join(' and ')}`
  }
  return { status, pending: status.filter((agent) => agent.state !== 'installed'), install }
}

const describe = (pending: McpStatus): string => pending.map((agent) => `${agent.agent}${agent.state === 'outdated' ? ' (outdated)' : ''}`).join(' and ')

/** Sets up Treeix's MCP server in Claude Code and Codex for sessions started outside Treeix; its own get it anyway. Gone once set up, Settings keeps it */
export function McpInstallButton({ flash }: { flash: (message: string) => void }): React.JSX.Element | null {
  const { pending, install } = useMcpInstall()
  if (pending.length === 0) return null
  return (
    <IconButton label={`Set up the Treeix MCP in ${describe(pending)}`} onClick={() => void install().then(flash)}>
      <Icon name="plug" />
    </IconButton>
  )
}

export function McpSetup(): React.JSX.Element {
  const { status, pending, install } = useMcpInstall()
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const run = (): void => {
    setBusy(true)
    install()
      .then(setMessage, (reason: unknown) => setMessage(errorMessage(reason)))
      .finally(() => setBusy(false))
  }
  const state =
    status.length === 0
      ? 'Neither Claude Code nor Codex found'
      : pending.length
        ? `Not set up in ${describe(pending)}`
        : `Set up in ${status.map((agent) => agent.agent).join(' and ')}`
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-muted-foreground">{message || state}</span>
      <button onClick={run} disabled={busy || status.length === 0} className="h-7 shrink-0 rounded-md px-3 text-xs ring-1 ring-border hover:bg-accent disabled:opacity-50">
        {busy ? 'Setting up…' : pending.length ? 'Set up' : 'Set up again'}
      </button>
    </div>
  )
}
