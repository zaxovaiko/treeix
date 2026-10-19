import { useEffect, useState } from 'react'
import { type RendererPlugin, useHost } from '@treeix/sdk'
import { errorMessage } from '@treeix/app/ui'
import { clock, type Status } from '../shared/types'
import { MeetingsTab } from './MeetingsTab'
import { MeetingsSettings } from './Settings'
import { bridge, meetingsSettings, revision, status, TAB_ID } from './state'

function Sync(): null {
  const settings = meetingsSettings.useValue()
  useEffect(() => void bridge.invoke('configure', settings), [settings])
  useEffect(() => {
    void bridge.invoke<Status>('status').then(status.set)
    const offStatus = bridge.on('status', (next) => status.set(next as Status))
    const offChanged = bridge.on('changed', () => revision.set(revision.get() + 1))
    return () => {
      offStatus()
      offChanged()
    }
  }, [])
  return null
}

/** Shown while recording: how long, and a way to stop; while a call looks on but nothing records: a way to start */
function Recording(): React.JSX.Element | null {
  const host = useHost()
  const current = status.useValue()
  const recording = current?.recording
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!recording) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [recording])
  if (!recording && current?.unrecorded)
    return (
      <button
        title={`${current.unrecorded}. Click to record`}
        onClick={() => void bridge.invoke('start').catch((reason: unknown) => host.flash(errorMessage(reason)))}
        className="flex h-6 items-center gap-1.5 rounded-md bg-amber-400/12 px-2 text-[11px] text-amber-400 hover:bg-amber-400/20 [-webkit-app-region:no-drag]"
      >
        <span className="size-1.5 rounded-full ring-1 ring-amber-400" />
        Not recording
      </button>
    )
  if (!recording) return null
  return (
    <button
      title={`Recording ${recording.title}. Click to stop`}
      onClick={() => void bridge.invoke('stop')}
      className="flex h-6 items-center gap-1.5 rounded-md bg-red-400/12 px-2 text-[11px] text-red-400 tabular-nums hover:bg-red-400/20 [-webkit-app-region:no-drag]"
    >
      <span className="size-1.5 animate-pulse rounded-full bg-red-400" />
      Recording {clock(Math.max(0, now - recording.since))}
    </button>
  )
}

const plugin: RendererPlugin = {
  Root: Sync,
  tabs: [{ id: TAB_ID, label: 'Meetings', icon: 'mic', order: 45, render: MeetingsTab }],
  titleBar: [{ order: 5, render: Recording }],
  Settings: MeetingsSettings,
  commands: (host) => [
    {
      id: 'meetings.start',
      group: 'Actions',
      label: 'Start recording a meeting',
      icon: 'mic',
      run: () => void bridge.invoke('start').catch((reason: unknown) => host.flash(errorMessage(reason)))
    },
    { id: 'meetings.stop', group: 'Actions', label: 'Stop recording the meeting', icon: 'mic', run: () => void bridge.invoke('stop') },
    { id: 'meetings.settings', group: 'Actions', label: 'Meetings settings', icon: 'settings', run: () => host.openSettings('plugin:meetings') }
  ]
}

export default plugin
