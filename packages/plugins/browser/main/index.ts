import { webContents } from 'electron'
import type { MainPlugin } from '@treeix/sdk/main'
import { captureElement, responseBody, watchGuest } from './guests'

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
    context.handle('capture', (event, guestId: number, rect: { x: number; y: number; width: number; height: number }, viewport: { width: number; height: number }) => {
      const guest = webContents.fromId(guestId)
      return guest && guest.hostWebContents === event.sender ? captureElement(guest, rect, viewport) : null
    })
    // A dock id shows DevTools in the renderer's dock webview; without one they open in their own window, or close
    context.handle('devtools', (event, guestId: number, dockId: number | null) => {
      const guest = webContents.fromId(guestId)
      if (!guest || guest.hostWebContents !== event.sender) return
      if (dockId === null) {
        if (guest.isDevToolsOpened()) guest.closeDevTools()
        else guest.openDevTools({ mode: 'detach' })
        return
      }
      const dock = webContents.fromId(dockId)
      if (!dock || dock.hostWebContents !== event.sender) return
      if (guest.isDevToolsOpened()) guest.closeDevTools()
      guest.setDevToolsWebContents(dock)
      guest.openDevTools()
    })
    context.handle('closeDevtools', (event, guestId: number) => {
      const guest = webContents.fromId(guestId)
      if (guest && guest.hostWebContents === event.sender && guest.isDevToolsOpened()) guest.closeDevTools()
    })
  }
}

export default plugin
