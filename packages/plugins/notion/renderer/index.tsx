import { useEffect, useState } from 'react'
import { createBridge, type RendererPlugin } from '@treeix/sdk'
import { Card, Row } from '@treeix/app/settingsUi'

const bridge = createBridge('notion')

type Connection = { connected: boolean; message: string }

function NotionSettings(): React.JSX.Element {
  const [connection, setConnection] = useState<Connection | null>(null)
  const check = (): void => void bridge.invoke<Connection>('connection').then(setConnection)
  useEffect(check, [])
  return (
    <Card title="Connection">
      <Row
        label="Notion CLI"
        description="Pages are added through the Notion CLI and its login. Install it with curl -fsSL https://ntn.dev | bash, then run ntn login in a terminal."
      >
        <span className="flex items-center gap-2 text-xs">
          <span className={connection?.connected ? 'text-emerald-400' : 'text-muted-foreground'}>{connection?.message ?? 'Checking…'}</span>
          <button className="h-7 shrink-0 rounded-md border border-border px-2.5 hover:bg-accent" onClick={check}>
            Check again
          </button>
        </span>
      </Row>
    </Card>
  )
}

const plugin: RendererPlugin = { Settings: NotionSettings }

export default plugin
