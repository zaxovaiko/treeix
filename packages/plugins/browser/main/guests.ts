import type { WebContents } from 'electron'
import { saveAttachment } from '@treeix/host/attachments'
import type { MainContext } from '@treeix/sdk/main'
import type { Attachment } from '@treeix/shared/comments'
import { ENTRY_LIMIT, applyNetworkEvent, consoleFromApi, consoleFromException, keepLast } from './entries'
import { browserAction, forwardsToApp } from '../shared/keys'
import type { ConsoleEntry, EntryBatch, NetworkEntry } from '../shared/types'

const watched = new WeakSet<WebContents>()
const BATCH_MS = 250
const BODY_LIMIT = 32 * 1024
const MARGIN = 16

/** The element with a margin, clamped to the visible page, saved where agents can read it */
export async function captureElement(guest: WebContents, rect: { x: number; y: number; width: number; height: number }, viewport: { width: number; height: number }): Promise<Attachment | null> {
  const x = Math.max(0, Math.floor(rect.x - MARGIN))
  const y = Math.max(0, Math.floor(rect.y - MARGIN))
  const width = Math.min(viewport.width - x, Math.ceil(rect.width + MARGIN * 2))
  const height = Math.min(viewport.height - y, Math.ceil(rect.height + MARGIN * 2))
  if (width <= 0 || height <= 0) return null
  const image = await guest.capturePage({ x, y, width, height })
  if (image.isEmpty()) return null
  const path = await saveAttachment('element.png', image.toPNG())
  return { path, name: 'element.png', thumbnail: image.resize({ width: Math.min(240, width) }).toDataURL() }
}

/** Wires a page once, however often its renderer reports it ready */
export function watchGuest(guest: WebContents, context: MainContext): void {
  if (watched.has(guest)) return
  watched.add(guest)
  const host = guest.hostWebContents
  guest.setWindowOpenHandler(({ url, disposition }) => {
    // Chromium blocks web pages from opening file: and other local schemes; a tab or window here must not get around it
    if (!/^https?:/i.test(url) && url !== 'about:blank') return { action: 'deny' }
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
  capture(guest, context)
}

function capture(guest: WebContents, context: MainContext): void {
  const host = guest.hostWebContents
  if (!host) return
  const requests = new Map<string, NetworkEntry>()
  let pending: EntryBatch = { guestId: guest.id, reset: false, console: [], network: [] }
  let timer: NodeJS.Timeout | null = null
  let origin = ''
  const flush = (): void => {
    timer = null
    if (!host.isDestroyed()) context.send(host, 'entries', pending)
    pending = { guestId: guest.id, reset: false, console: [], network: [] }
  }
  const queue = (change: (batch: EntryBatch) => EntryBatch): void => {
    pending = change(pending)
    timer ??= setTimeout(flush, BATCH_MS)
  }
  const onMessage = (_: unknown, method: string, params: unknown): void => {
    const logged: ConsoleEntry | null = method === 'Runtime.consoleAPICalled' ? consoleFromApi(params) : method === 'Runtime.exceptionThrown' ? consoleFromException(params) : null
    if (logged) return queue((batch) => ({ ...batch, console: keepLast(batch.console, logged) }))
    if (!method.startsWith('Network.')) return
    const request = applyNetworkEvent(requests, method, params)
    if (request) queue((batch) => ({ ...batch, network: keepLast(batch.network.filter((entry) => entry.id !== request.id), request) }))
    if (requests.size > ENTRY_LIMIT) requests.delete(requests.keys().next().value as string)
  }
  try {
    guest.debugger.attach('1.3')
  } catch {
    return
  }
  guest.debugger.on('message', onMessage)
  for (const domain of ['Runtime', 'Log', 'Network']) void guest.debugger.sendCommand(`${domain}.enable`).catch(() => undefined)
  // Another site starts a fresh list; staying on one origin keeps it, like DevTools with preserve log off per site
  guest.on('did-navigate', (_, url) => {
    const next = new URL(url).origin
    if (next === origin) return
    origin = next
    requests.clear()
    queue(() => ({ guestId: guest.id, reset: true, console: [], network: [] }))
  })
  guest.debugger.on('detach', () =>
    queue((batch) => ({
      ...batch,
      console: keepLast(batch.console, { kind: 'console', id: `detach${Date.now()}`, level: 'warning', text: 'Capture stopped; it resumes on the next page load', source: '', stack: '', time: Date.now() })
    }))
  )
  guest.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !guest.debugger.isAttached()) {
      try {
        guest.debugger.attach('1.3')
        for (const domain of ['Runtime', 'Log', 'Network']) void guest.debugger.sendCommand(`${domain}.enable`).catch(() => undefined)
      } catch {
        // DevTools' own protocol client can hold the page; capture resumes on a later load
      }
    }
  })
}

export async function responseBody(guest: WebContents, requestId: string): Promise<string | null> {
  try {
    const result = (await guest.debugger.sendCommand('Network.getResponseBody', { requestId })) as { body?: unknown; base64Encoded?: unknown }
    if (typeof result.body !== 'string') return null
    const body = result.base64Encoded === true ? `(binary, ${Math.round((result.body.length * 3) / 4)} bytes)` : result.body
    return body.length > BODY_LIMIT ? `${body.slice(0, BODY_LIMIT)}\n(cut at 32 KB)` : body
  } catch {
    return null
  }
}
