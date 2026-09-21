import type { WebContents } from 'electron'
import type { MainContext } from '@treeix/sdk/main'
import { browserAction, forwardsToApp } from '../shared/keys'

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
  guest.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !host) return
    const key = { code: input.code, meta: input.meta, shift: input.shift, alt: input.alt, control: input.control }
    const action = browserAction(key)
    if (action) {
      event.preventDefault()
      context.send(host, 'action', guest.id, action)
    } else if (forwardsToApp(key)) {
      event.preventDefault()
      context.send(host, 'key', key, input.key)
    }
  })
}
