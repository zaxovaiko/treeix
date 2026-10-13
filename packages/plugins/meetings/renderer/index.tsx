import { useEffect, useState } from 'react'
import type { RendererPlugin } from '@treeix/sdk'
import { errorMessage } from '@treeix/app/ui'
import type { Status } from '../shared/types'
import { MeetingsTab } from './MeetingsTab'
import { MeetingsSettings } from './Settings'
import { bridge, meetingsSettings, revision, status, TAB_ID } from './state'

function Sync(): null {
  const settings = meetingsSettings.use()
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

const clock = (ms: number): string => {
  const seconds = Math.floor(ms / 1000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** Shown only while recording: how long, and a way to stop */
function Recording(): React.JSX.Element | null {
  const recording = status.use()?.recording
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!recording) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [recording])
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
