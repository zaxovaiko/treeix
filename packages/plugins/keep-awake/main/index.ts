import type { MainPlugin } from '@treeix/sdk/main'
import { restoreSleep, setKeepAwake } from './keepAwake'

const plugin: MainPlugin = {
  activate: (context) => {
    // Agent sessions report from the window; Agents hub runs from main, so they keep the Mac up with no window open
    let sessions = false
    let runs = false
    let enabled = true
    let lidClosed = false
    const apply = (): Promise<boolean> => setKeepAwake(enabled && (sessions || runs), lidClosed)
    context.handle('set', (_, active: boolean, lid: boolean, on: boolean) => {
      sessions = active === true
      lidClosed = lid === true
      enabled = on !== false
      return apply()
    })
    context.onEvent(async (name, payload) => {
      if (name !== 'hub.busy') return false
      runs = payload.busy === true
      void apply()
      return false
    })
    context.onDispose(restoreSleep)
  }
}

export default plugin
