import { useEffect, useEffectEvent, useRef } from 'react'
import type { Terminal } from '@xterm/xterm'
import type { Api, Attachment } from '../../ipc/api'
import { ackBatcher, bytesFrom } from './stream'
import { type KeyAction, terminalKey } from './keys'
import { findRowFileLinks, findWebLinks } from './fileLinks'
import { IS_MAC, openXterm } from './xterm'

export interface TerminalPaneProps {
  api: Api
  sessionId: string
  /** On screen: attached, WebGL alive. Hidden panes detach and free their renderer */
  visible: boolean
  focused: boolean
  onFocus(): void
  /** Cmd-click on a printed file path; without it paths aren't links */
  onOpenFile?(targets: { path: string; line: number | null }[]): void
}

const RESIZE_DEBOUNCE_MS = 50

if (import.meta.env.DEV) void import('./bench')

export function TerminalPane({ api, sessionId, visible, focused, onFocus, onOpenFile }: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fileOpener = useEffectEvent(() => onOpenFile)

  useEffect(() => {
    const host = hostRef.current
    if (!visible || !host) return
    const view = showSession(host, api, sessionId, fileOpener)
    termRef.current = view.term
    return () => {
      termRef.current = null
      view.close()
    }
  }, [api, sessionId, visible])

  useEffect(() => {
    if (visible && focused) termRef.current?.focus()
  }, [visible, focused])

  return <div ref={hostRef} className="term" hidden={!visible} data-session-id={sessionId} onMouseDown={onFocus} />
}

/** A live xterm attached to the session; `close` detaches and frees everything, hidden sessions cost no JS */
function showSession(host: HTMLElement, api: Api, sessionId: string, fileOpener: () => TerminalPaneProps['onOpenFile']) {
  const view = openXterm(host)
  const { term, fit } = view
  const acks = ackBatcher((bytes) => void api.ack(sessionId, bytes))
  let closed = false
  let attachment: Attachment | null = null
  /** Data that arrived before the snapshot; null once the snapshot is written */
  let early: [Uint8Array, number][] | null = []
  let snapshotEnd = 0

  const render = (bytes: Uint8Array, seq: number): void => {
    term.write(bytesFrom(bytes, seq, snapshotEnd), () => acks.rendered(bytes.length))
  }
  api
    .attach(sessionId, (bytes, seq) => {
      if (early) early.push([bytes, seq])
      else render(bytes, seq)
    })
    .then((attached) => {
      if (closed) return void attached.detach()
      attachment = attached
      snapshotEnd = attached.seq
      term.write(attached.snapshot)
      for (const [bytes, seq] of early ?? []) render(bytes, seq)
      early = null
      if (attached.info.cols !== term.cols || attached.info.rows !== term.rows) void api.resize(sessionId, term.cols, term.rows)
    })
    .catch((error: unknown) => closed || term.write(`\r\n\x1b[31m[Could not attach: ${String(error)}]\x1b[0m\r\n`))

  const send = (data: string | Uint8Array): void => void api.write(sessionId, data)
  // Listeners and link providers go with term.dispose()
  term.onData(send)
  term.onBinary((data) => send(Uint8Array.from(data, (char) => char.charCodeAt(0))))
  term.onResize(({ cols, rows }) => void api.resize(sessionId, cols, rows))

  const perform = (action: KeyAction, event: KeyboardEvent): void => {
    if (action.type === 'send') {
      event.preventDefault()
      send(action.data)
    } else if (action.type === 'copy' && term.hasSelection()) {
      event.preventDefault()
      void navigator.clipboard.writeText(term.getSelection())
    } else if (action.type === 'paste') {
      event.preventDefault()
      // term.paste adds the bracketed-paste markers when the program asked for them
      void navigator.clipboard.readText().then((text) => term.paste(text))
    } else if (action.type === 'clear') {
      // ponytail: clears this view only; the daemon's scrollback comes back on the next reveal until ptyd gets a clear request
      term.clear()
    }
  }
  term.attachCustomKeyEventHandler((event) => {
    const action = terminalKey(event, IS_MAC)
    if (action.type === 'xterm') return true
    if (event.type === 'keydown') perform(action, event)
    // false: xterm leaves it alone and it bubbles to the app shell's window listeners
    return false
  })

  // Cmd-click (Ctrl-click on Linux) on a printed path; wrapped rows are joined when a path runs to the edge
  term.registerLinkProvider({
    provideLinks(row, callback) {
      const openFile = fileOpener()
      if (!openFile) return callback(undefined)
      const rowText = (index: number): string => term.buffer.active.getLine(index)?.translateToString(true) ?? ''
      const text = rowText(row - 1)
      const reachesEdge = (line: string): boolean => line.trimEnd().length >= term.cols - 3
      const before = row > 1 && reachesEdge(rowText(row - 2)) ? rowText(row - 2) : null
      const web = findWebLinks(text)
      const files = findRowFileLinks(text, before, reachesEdge(text) ? rowText(row) : null).filter((file) => !web.some((link) => file.start < link.end && file.end > link.start))
      callback(
        files.map(({ start, end, targets }) => ({
          text: text.slice(start, end),
          range: { start: { x: start + 1, y: row }, end: { x: end, y: row } },
          decorations: { underline: true, pointerCursor: true },
          activate: (event: MouseEvent) => {
            if (IS_MAC ? event.metaKey : event.ctrlKey) openFile(targets)
          }
        }))
      )
    }
  })

  let resizeTimer: ReturnType<typeof setTimeout> | undefined
  const observer = new ResizeObserver(() => {
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => fit.fit(), RESIZE_DEBOUNCE_MS)
  })
  observer.observe(host)
  const restyle = (): void => view.restyle()
  window.addEventListener('treeix-theme', restyle)

  return {
    term,
    close() {
      closed = true
      clearTimeout(resizeTimer)
      observer.disconnect()
      window.removeEventListener('treeix-theme', restyle)
      acks.flush()
      void attachment?.detach()
      view.dispose()
    }
  }
}
