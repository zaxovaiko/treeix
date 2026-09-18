import type { MainPlugin } from '@treeix/sdk/main'
import { restoreSleep, setKeepAwake } from './keepAwake'

const plugin: MainPlugin = {
  activate: (context) => {
    context.handle('set', (_, active: boolean, lidClosed: boolean) => setKeepAwake(active === true, lidClosed === true))
    context.onDispose(restoreSleep)
  }
}

export default plugin
