import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createBridge, definePluginSettings, type RendererPlugin, useHost } from '@treeix/sdk'
import { isAgent } from '@treeix/app/agents'
import { Icon } from '@treeix/app/Icon'
import { Row, Switch } from '@treeix/app/settingsUi'

/** Agents idle this long before sleep is allowed again */
const IDLE_MS = 2 * 60_000

const bridge = createBridge('keep-awake')

const awakeSettings = definePluginSettings('keep-awake', (stored) => ({
  /** Off from the title bar: agents working no longer keep the Mac up */
  keepAwakeEnabled: stored.keepAwakeEnabled !== false,
  /** Also keep running with the lid closed, which needs the administrator password */
  keepAwakeLidClosed: stored.keepAwakeLidClosed === true
}))

/** Whether the Mac is currently kept awake, and with the lid closed, for the title bar */
const status = definePluginSettings('keep-awake-status', () => ({ awake: false, lidClosed: false }))

// Keep the Mac awake while any agent works; stay awake through short pauses so the password prompt doesn't repeat
// Waiting for your answer doesn't count: the Mac shouldn't stay up in a bag for a question nobody sees
function KeepAwake(): null {
  const sessions = useHost().service('sessions')
  const agentsWorking = useSyncExternalStore(
    sessions?.subscribe ?? (() => () => undefined),
    () => sessions?.getSessions().some((session) => isAgent(session.kind) && session.status === 'running') ?? false
  )
  const { keepAwakeEnabled, keepAwakeLidClosed } = awakeSettings.use()
  const [keepAwake, setKeepAwake] = useState(false)
  const declined = useRef(false)

  useEffect(() => {
    if (!keepAwakeEnabled) return setKeepAwake(false)
    if (agentsWorking) {
      if (!keepAwake && !declined.current) setKeepAwake(true)
      return
    }
    declined.current = false
    const timer = setTimeout(() => setKeepAwake(false), IDLE_MS)
    return () => clearTimeout(timer)
  }, [agentsWorking, keepAwakeEnabled])

  useEffect(() => {
    status.update({ awake: keepAwake, lidClosed: keepAwake && keepAwakeLidClosed })
    bridge.invoke<boolean>('set', keepAwake, keepAwakeLidClosed).then((ok) => {
      if (ok || !keepAwake) return
      // Cancelled prompt: don't ask again until agents stop and start again
      declined.current = true
      setKeepAwake(false)
    })
  }, [keepAwake, keepAwakeLidClosed])

  return null
}

/** Always there while the plugin is on, so it's clear the Mac will stay up once an agent starts */
function Indicator(): React.JSX.Element {
  const { awake, lidClosed } = status.use()
  const { keepAwakeEnabled } = awakeSettings.use()
  const state = !keepAwakeEnabled
    ? 'Keep awake is off: the Mac may sleep while agents work'
    : lidClosed
      ? 'Agents are working: the Mac stays awake with the lid closed'
      : awake
        ? 'Agents are working: the Mac stays awake'
        : 'Keep awake is on: the Mac stays awake while an agent works'
  const title = `${state}. Click to turn it ${keepAwakeEnabled ? 'off' : 'on'}`
  return (
    <button
      title={title}
      aria-label={title}
      aria-pressed={keepAwakeEnabled}
      onClick={() => awakeSettings.update({ keepAwakeEnabled: !keepAwakeEnabled })}
      className={`relative flex h-6 items-center rounded-md px-1.5 hover:bg-accent [-webkit-app-region:no-drag] ${
        !keepAwakeEnabled ? 'text-muted-foreground/40' : lidClosed ? 'bg-amber-400/12 text-amber-400' : awake ? 'bg-emerald-400/12 text-emerald-400' : 'bg-foreground/8 text-foreground'
      }`}
    >
      <Icon name="coffee" className="size-3.5" />
      {!keepAwakeEnabled && <span className="absolute top-1/2 left-1/2 h-px w-4 -translate-x-1/2 -translate-y-1/2 -rotate-45 bg-current" />}
    </button>
  )
}

function KeepAwakeSettings(): React.JSX.Element {
  const { keepAwakeLidClosed } = awakeSettings.use()
  return (
    <Row
      label="Keep running with the lid closed"
      description="Asks for your password the first time agents start. Lid-close sleep then stays off until you turn this off or quit Treeix. Watch for heat if the Mac is in a bag."
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
