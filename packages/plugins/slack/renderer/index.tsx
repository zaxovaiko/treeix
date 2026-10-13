import { useEffect, useState } from 'react'
import { createBridge, createStore, definePluginSettings, type RendererPlugin } from '@treeix/sdk'
import { timeAgo } from '@treeix/app/time'
import { Card, Row, SecretRow, Segmented, Switch } from '@treeix/app/settingsUi'
import { INTERVALS, type Interval, parseSettings, type Status } from '../shared/types'

const bridge = createBridge('slack')
const slackSettings = definePluginSettings('slack', parseSettings)
const status = createStore<Status | null>(null)
const button = 'h-7 rounded-md border border-border px-2.5 text-xs hover:bg-accent disabled:opacity-50'

function Sync(): null {
  const settings = slackSettings.use()
  useEffect(() => void bridge.invoke('configure', settings), [settings])
  useEffect(() => {
    void bridge.invoke<Status>('status').then(status.set)
    return bridge.on('status', (next) => status.set(next as Status))
  }, [])
  return null
}

function SlackSettings(): React.JSX.Element {
  const { intervalMin, includeOwn } = slackSettings.use()
  const current = status.use()
  const [tokens, setTokens] = useState({ app: false, user: false })
  const refresh = (): void => void bridge.invoke<typeof tokens>('tokens').then(setTokens)
  useEffect(refresh, [])
  const token = (kind: 'app' | 'user', value: string | null): Promise<void> => bridge.invoke<void>('setToken', kind, value).then(refresh)
  return (
    <>
      <Card title="Connection">
        <SecretRow
          label="App token"
          description="Create a Slack app with Socket Mode on, subscribe it to message.channels, message.groups, message.im and message.mpim on behalf of users, then make an app-level token with connections:write."
          placeholder="xapp-…"
          saved={tokens.app ? 'Saved' : null}
          onSave={(value) => token('app', value)}
          onRemove={() => void token('app', null)}
        />
        <SecretRow
          label="User token"
          description="The app's User OAuth Token after installing it, with users:read, channels:read, groups:read, im:read and mpim:read, so names and links can be filled in."
          placeholder="xoxp-…"
          saved={tokens.user ? 'Saved' : null}
          onSave={(value) => token('user', value)}
          onRemove={() => void token('user', null)}
        />
        <Row
          label="Status"
          description={
            current?.error ??
            `${current?.pending ?? 0} messages wait for the next batch${current?.lastBatch ? `; last sent ${timeAgo(new Date(current.lastBatch).toISOString())} ago` : ''}. Workflows start on the slack.messages event.`
          }
        >
          <span className="flex items-center gap-2 text-xs">
            <span className={current?.connected ? 'text-emerald-400' : 'text-muted-foreground'}>{current?.connected ? 'Connected' : 'Not connected'}</span>
            <button className={button} disabled={!current?.pending} onClick={() => void bridge.invoke('batch')}>
              Send now
            </button>
          </span>
        </Row>
      </Card>
      <Card title="Batches">
        <Row label="Every" description="How often collected messages go to workflows, in minutes.">
          <Segmented<`${Interval}`>
            value={`${intervalMin}`}
            options={INTERVALS.map((minutes) => [`${minutes}`, `${minutes}`])}
            onChange={(next) => slackSettings.update({ intervalMin: INTERVALS.find((minutes) => `${minutes}` === next) ?? 15 })}
          />
        </Row>
        <Row label="Include my own messages" description="So a workflow sees what you said you would do; they show as from Me.">
          <Switch checked={includeOwn} label="Include my own messages" onChange={() => slackSettings.update({ includeOwn: !includeOwn })} />
        </Row>
      </Card>
    </>
  )
}

const plugin: RendererPlugin = { Root: Sync, Settings: SlackSettings }

export default plugin
