import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createBridge, definePluginSettings, type RendererPlugin, useHost } from '@treeix/sdk'
import { Icon } from '@treeix/app/Icon'
import { Row, Switch } from '@treeix/app/settingsUi'

/** Agents idle this long before sleep is allowed again */
const IDLE_MS = 2 * 60_000

const bridge = createBridge('keep-awake')

const awakeSettings = definePluginSettings('keep-awake', (stored) => ({
  /** Also keep running with the lid closed, which needs the administrator password */
  keepAwakeLidClosed: stored.keepAwakeLidClosed === true
}))

/** Whether the Mac is currently kept awake, for the title bar */
const status = definePluginSettings('keep-awake-status', () => ({ awake: false }))

// Keep the Mac awake while any agent works; stay awake through short pauses so the password prompt doesn't repeat
// Waiting for your answer doesn't count: the Mac shouldn't stay up in a bag for a question nobody sees
function KeepAwake(): null {
  const sessions = useHost().service('sessions')
  const agentsWorking = useSyncExternalStore(
    sessions?.subscribe ?? (() => () => undefined),
    () => sessions?.getSessions().some((session) => session.kind !== 'shell' && session.status === 'running') ?? false
  )
  const { keepAwakeLidClosed } = awakeSettings.use()
  const [keepAwake, setKeepAwake] = useState(false)
  const declined = useRef(false)

  useEffect(() => {
    if (agentsWorking) {
      if (!keepAwake && !declined.current) setKeepAwake(true)
      return
    }
    declined.current = false
    const timer = setTimeout(() => setKeepAwake(false), IDLE_MS)
    return () => clearTimeout(timer)
  }, [agentsWorking])

  useEffect(() => {
    status.update({ awake: keepAwake && keepAwakeLidClosed })
    bridge.invoke<boolean>('set', keepAwake, keepAwakeLidClosed).then((ok) => {
      if (ok || !keepAwake) return
      // Cancelled prompt: don't ask again until agents stop and start again
      declined.current = true
      setKeepAwake(false)
    })
  }, [keepAwake, keepAwakeLidClosed])

  return null
}

function Indicator(): React.JSX.Element | null {
  const { awake } = status.use()
  if (!awake) return null
  return (
    <span title="Agents are working: the Mac stays awake with the lid closed" className="flex items-center gap-1 px-1.5 text-[11px] text-amber-400">
      <Icon name="power" className="size-3.5" />
    </span>
  )
}

function KeepAwakeSettings(): React.JSX.Element {
  const { keepAwakeLidClosed } = awakeSettings.use()
  return (
    <Row
      label="Keep running with the lid closed"
      description="Asks for your password when agents start and again after they've been idle for 2 minutes. Watch for heat if the Mac is in a bag."
    >
      <Switch checked={keepAwakeLidClosed} label="Keep running with the lid closed" onChange={() => awakeSettings.update({ keepAwakeLidClosed: !keepAwakeLidClosed })} />
    </Row>
  )
}

const plugin: RendererPlugin = {
  Root: KeepAwake,
  titleBar: [{ order: 0, render: Indicator }],
  Settings: KeepAwakeSettings
}

export default plugin
