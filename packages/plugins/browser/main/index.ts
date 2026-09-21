import { webContents } from 'electron'
import type { MainPlugin } from '@treeix/sdk/main'
import { watchGuest } from './guests'

const plugin: MainPlugin = {
  activate: (context) => {
    // Only pages embedded by the window asking may be wired, so one window can't reach another's pages
    context.handle('attach', (event, guestId: number) => {
      const guest = webContents.fromId(guestId)
      if (guest && guest.hostWebContents === event.sender) watchGuest(guest, context)
    })
  }
}

export default plugin
