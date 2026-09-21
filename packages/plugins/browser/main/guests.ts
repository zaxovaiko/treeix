import type { WebContents } from 'electron'
import type { MainContext } from '@treeix/sdk/main'

const watched = new WeakSet<WebContents>()

/** Wires a page once, however often its renderer reports it ready */
export function watchGuest(guest: WebContents, context: MainContext): void {
  if (watched.has(guest)) return
  watched.add(guest)
  const host = guest.hostWebContents
  guest.setWindowOpenHandler(({ url, disposition }) => {
    // window.open with features, like OAuth popups, needs a real window with an opener
    if (disposition === 'new-window') return { action: 'allow' }
    if (host) context.send(host, 'open', url)
    return { action: 'deny' }
  })
}
