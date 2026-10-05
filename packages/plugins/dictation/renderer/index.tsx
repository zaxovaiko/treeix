import { useEffect } from 'react'
import type { RendererPlugin } from '@treeix/sdk'
import type { Dictation, Status } from '../shared/types'
import { DictationSettings } from './Settings'
import { bridge, dictationSettings, history, status } from './state'

// The main module trusts what its own renderer sends and so does this side
function Sync(): null {
  const settings = dictationSettings.use()
  useEffect(() => void bridge.invoke('configure', settings), [settings])
  useEffect(() => {
    void bridge.invoke<Status>('status').then(status.set)
    void bridge.invoke<Dictation[]>('history').then(history.set)
    const offStatus = bridge.on('status', (next) => status.set(next as Status))
    const offHistory = bridge.on('history', (next) => history.set(next as Dictation[]))
    return () => {
      offStatus()
      offHistory()
    }
  }, [])
  return null
}

const plugin: RendererPlugin = {
  Root: Sync,
  Settings: DictationSettings,
  commands: (host) => [
    { id: 'dictation.settings', group: 'Actions', label: 'Dictation settings', icon: 'settings', run: () => host.openSettings('plugin:dictation') },
    {
      id: 'dictation.copyLast',
      group: 'Actions',
      label: 'Copy the last dictation',
      icon: 'copy',
      run: () => {
        const last = history.get()[0]
        if (!last) return host.flash('Nothing dictated yet')
        void navigator.clipboard.writeText(last.text)
        host.flash('Copied the last dictation')
      }
    }
  ]
}

export default plugin
