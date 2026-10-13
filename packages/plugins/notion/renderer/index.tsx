import { useEffect, useState } from 'react'
import { createBridge, type RendererPlugin } from '@treeix/sdk'
import { Card, SecretRow } from '@treeix/app/settingsUi'

const bridge = createBridge('notion')

type Connection = { saved: boolean; connected: boolean; message: string }

function NotionSettings(): React.JSX.Element {
  const [connection, setConnection] = useState<Connection | null>(null)
  const check = (): void => void bridge.invoke<Connection>('connection').then(setConnection)
  useEffect(check, [])
  const token = (value: string | null): Promise<void> => bridge.invoke<void>('setToken', value).then(check)
  return (
    <Card title="Connection">
      <SecretRow
        label="Personal access token"
        description={
          connection?.saved && !connection.connected
            ? connection.message
            : 'Make one at developers.notion.com with Notion API access. Pages are added as you, to any database you can open.'
        }
        placeholder="ntn_…"
        saved={connection?.saved ? (connection.connected ? connection.message : 'Saved') : null}
        onSave={(value) => token(value)}
        onRemove={() => void token(null)}
      />
    </Card>
  )
}

const plugin: RendererPlugin = { Settings: NotionSettings }

export default plugin
