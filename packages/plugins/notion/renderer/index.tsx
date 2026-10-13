import { useEffect, useState } from 'react'
import { createBridge, type RendererPlugin } from '@treeix/sdk'
import { Card, SecretRow } from '@treeix/app/settingsUi'

const bridge = createBridge('notion')

function NotionSettings(): React.JSX.Element {
  const [connection, setConnection] = useState<string | null>(null)
  useEffect(() => void bridge.invoke<string | null>('connection').then(setConnection), [])
  return (
    <Card title="Connection">
      <SecretRow
        label="Integration token"
        description="Make an internal integration at notion.so/profile/integrations, then add it to each database under ••• > Connections."
        placeholder="ntn_…"
        saved={connection}
        onSave={(token) => bridge.invoke<string>('connect', token).then(setConnection)}
        onRemove={() => void bridge.invoke('disconnect').then(() => setConnection(null))}
      />
    </Card>
  )
}

const plugin: RendererPlugin = { Settings: NotionSettings }

export default plugin
