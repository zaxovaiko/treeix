import { useEffect, useState } from 'react'
import { Row } from '@treeix/app/settingsUi'
import type { CredentialsStatus } from '../shared'
import type { AtlassianBridge } from './atlassianBridge'

/** Email and API token for what acli can't do; typed here, kept encrypted by the main process, shared by every Atlassian plugin */
export function ApiToken({ bridge, purpose }: { bridge: AtlassianBridge; purpose: string }): React.JSX.Element {
  const [status, setStatus] = useState<CredentialsStatus | null>(null)
  const [email, setEmail] = useState('')
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const load = (): void =>
    void bridge.credentials().then((next) => {
      setStatus(next)
      setEmail(next.email ?? '')
    })
  useEffect(load, [])
  const save = (credentials: { email: string; token: string } | null): void => {
    setError(null)
    bridge.saveCredentials(credentials).then(
      () => (setToken(''), load()),
      (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))
    )
  }
  return (
    <Row
      label="Atlassian API token"
      description={`${status?.hasToken ? 'A token is saved.' : `${purpose} need an API token (id.atlassian.com → Security → API tokens).`} Stored encrypted with your macOS keychain, shared by Jira and Confluence.${error ? ` ${error}` : ''}`}
    >
      <div className="flex shrink-0 flex-col gap-1.5">
        <input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Atlassian email" className="h-8 w-64 rounded-lg bg-muted px-2.5 text-[12px] ring-1 ring-border outline-none" />
        <div className="flex gap-1.5">
          <input
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder={status?.hasToken ? '•••••••• saved' : 'API token'}
            className="h-8 min-w-0 flex-1 rounded-lg bg-muted px-2.5 text-[12px] ring-1 ring-border outline-none"
          />
          {token.trim() && email.trim() ? (
            <button onClick={() => save({ email: email.trim(), token: token.trim() })} className="h-8 rounded-lg bg-primary px-3 text-xs font-medium text-white">
              Save
            </button>
          ) : (
            status?.hasToken && (
              <button onClick={() => save(null)} className="h-8 rounded-lg px-3 text-xs text-red-400 ring-1 ring-border hover:bg-accent">
                Remove
              </button>
            )
          )}
        </div>
      </div>
    </Row>
  )
}
