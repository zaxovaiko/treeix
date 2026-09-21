import { webContents } from 'electron'
import type { MainPlugin } from '@treeix/sdk/main'
import { responseBody, watchGuest } from './guests'

const plugin: MainPlugin = {
  activate: (context) => {
    // Only pages embedded by the window asking may be wired, so one window can't reach another's pages
    context.handle('attach', (event, guestId: number) => {
      const guest = webContents.fromId(guestId)
      if (guest && guest.hostWebContents === event.sender) watchGuest(guest, context)
    })
    context.handle('responseBody', (event, guestId: number, requestId: string) => {
      const guest = webContents.fromId(guestId)
      return guest && guest.hostWebContents === event.sender ? responseBody(guest, requestId) : null
    })
  }
}

export default plugin
