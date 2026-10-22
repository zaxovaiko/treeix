import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager'
import type { Api, Attachment, SessionInfo, SessionStatus } from '../../ipc/api'
import { ackBatcher, attachStream } from './stream'
import { type KeyAction, terminalKey } from './keys'
import { findRowFileLinks, findWebLinks } from './fileLinks'
import { dropText } from './drop'
import type { Renderer } from './renderer'
import { FindBar, SessionBar } from './bars'
import { IS_MAC, openXterm, searchDecorations, webglFor, type Xterm } from './xterm'
import { settingsNow } from '../../features/agents/settings'

export interface TerminalPaneProps {
  api: Api
  sessionId: string
  /** On screen: attached, WebGL alive. Hidden panes detach and free their renderer */
  visible: boolean
  focused: boolean
  onFocus(): void
  /** Cmd-click on a printed file path; without it paths aren't links */
  onOpenFile?(targets: { path: string; line: number | null }[]): void
  /** `auto` (default): WebGL, except the DOM renderer on Linux */
  renderer?: Renderer
}

const RESIZE_DEBOUNCE_MS = 50
const IN_TAURI = '__TAURI_INTERNALS__' in window
/** No process behind the session: the bar offers Restart and Close */
const GONE = new Set<SessionStatus>(['exited', 'restored', 'crashed'])

if (import.meta.env.DEV) void import('./bench')

interface SessionState {
  status: SessionStatus
  exitCode: number | null
}

/** What a live view calls back into the pane with */
interface PaneHooks {
  openFile(): TerminalPaneProps['onOpenFile']
  attached(info: SessionInfo): void
  find(): void
  /** Input is dropped while the session is gone; Enter restarts it, like the prototype */
  gone(): boolean
  restart(): void
  focus(): void
}

export function TerminalPane({ api, sessionId, visible, focused, onFocus, onOpenFile, renderer = 'auto' }: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<Xterm | null>(null)
  const [session, setSession] = useState<SessionState | null>(null)
  /** Bumped by Cmd+F so an open find bar selects its query again; 0 is closed */
  const [find, setFind] = useState(0)
  const gone = session !== null && GONE.has(session.status)

  const restart = (): void => {
    const before = session
    setSession({ status: 'running', exitCode: null })
    view?.term.focus()
    api.restart(sessionId).catch((error: unknown) => {
      setSession(before)
      view?.term.write(`\r\n\x1b[31m[Could not restart: ${String(error)}]\x1b[0m\r\n`)
    })
  }

  const hooks: PaneHooks = {
    openFile: useEffectEvent(() => onOpenFile),
    attached: useEffectEvent((info: SessionInfo) => setSession({ status: info.status, exitCode: info.exitCode })),
    find: useEffectEvent(() => setFind((n) => n + 1)),
    gone: useEffectEvent(() => gone),
    restart: useEffectEvent(restart),
    focus: useEffectEvent(onFocus)
  }

  useEffect(() => {
    const host = hostRef.current
    if (!visible || !host) return
    const shown = showSession(host, api, sessionId, webglFor(renderer), hooks)
    setView(shown.view)
    return () => {
      setView(null)
      shown.close()
    }
  }, [api, sessionId, visible, renderer])

  useEffect(
    () =>
      api.onEvent((e) => {
        if (e.type === 'exit' && e.session === sessionId) setSession({ status: 'exited', exitCode: e.code })
        else if (e.type === 'status' && e.session === sessionId) setSession((s) => ({ status: e.status, exitCode: e.status === 'exited' ? (s?.exitCode ?? null) : null }))
      }),
    [api, sessionId]
  )

  useEffect(() => {
    if (visible && focused) view?.term.focus()
  }, [visible, focused, view])

  const closeFind = (): void => {
    setFind(0)
    view?.search.clearDecorations()
    view?.term.focus()
  }

  return (
    <div className="term" hidden={!visible} data-session-id={sessionId} onMouseDown={onFocus}>
      <div ref={hostRef} className="term-host" />
      {view && find > 0 && <FindBar search={view.search} decorations={() => searchDecorations(view.term.element ?? document.body)} signal={find} onClose={closeFind} />}
      {session && gone && <SessionBar status={session.status} exitCode={session.exitCode} onRestart={restart} onClose={() => void api.remove(sessionId)} />}
    </div>
  )
}

/** A live xterm attached to the session; `close` detaches and frees everything, hidden sessions cost no JS */
function showSession(host: HTMLElement, api: Api, sessionId: string, webgl: boolean, hooks: PaneHooks) {
  const view = openXterm(host, webgl)
  const { term, fit } = view
  let closed = false
  let attachment: Attachment | null = null
  const acks = ackBatcher((bytes) => void attachment?.ack(bytes))
  const stream = attachStream(term, (bytes) => bytes > 0 && acks.rendered(bytes))
  // Restart reuses this attachment: ptyd keeps the session's clients and its seq runs on
  api
    .attach(sessionId, stream.onData)
    .then((attached) => {
      if (closed) return void attached.detach()
      attachment = attached
      stream.snapshot(attached.snapshot, attached.seq)
      hooks.attached(attached.info)
      if (attached.info.cols !== term.cols || attached.info.rows !== term.rows) void api.resize(sessionId, term.cols, term.rows)
    })
    .catch((error: unknown) => closed || term.write(`\r\n\x1b[31m[Could not attach: ${String(error)}]\x1b[0m\r\n`))

  const send = (data: string | Uint8Array): void => void api.write(sessionId, data)
  // Listeners and link providers go with term.dispose()
  term.onData((data) => {
    if (!hooks.gone()) send(data)
    else if (data === '\r') hooks.restart()
  })
  term.onBinary((data) => hooks.gone() || send(Uint8Array.from(data, (char) => char.charCodeAt(0))))
  term.onResize(({ cols, rows }) => void api.resize(sessionId, cols, rows))
  const copy = (text: string): Promise<void> => (IN_TAURI ? writeText(text) : navigator.clipboard.writeText(text))
  term.onSelectionChange(() => {
    if (settingsNow()?.terminal.copyOnSelect && term.hasSelection()) void copy(term.getSelection())
  })

  const perform = (action: KeyAction, event: KeyboardEvent): void => {
    if (action.type === 'send') {
      event.preventDefault()
      send(action.data)
    } else if (action.type === 'copy' && term.hasSelection()) {
      event.preventDefault()
      void copy(term.getSelection())
    } else if (action.type === 'paste' && IN_TAURI) {
      // Linux Ctrl+Shift+V; a browser pastes natively. term.paste adds the bracketed-paste markers when the program asked for them
      event.preventDefault()
      void readText().then((text) => term.paste(text))
    } else if (action.type === 'find') {
      event.preventDefault()
      hooks.find()
    } else if (action.type === 'clear' && term.buffer.active.type === 'normal') {
      // Like the daemon (and Ghostty): the alternate screen belongs to the running TUI
      term.clear()
      void api.clear(sessionId)
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
      const openFile = hooks.openFile()
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

  // Files dropped on this pane type their escaped paths, like Ghostty. Tauri takes over drops, so a browser ignores them
  const stopDrop = IN_TAURI
    ? getCurrentWebview().onDragDropEvent(({ payload }) => {
        if (payload.type !== 'drop' || hooks.gone()) return
        // Physical pixels from the webview's top-left
        const { x, y } = payload.position.toLogical(window.devicePixelRatio)
        if (!host.contains(document.elementFromPoint(x, y))) return
        hooks.focus()
        term.focus()
        send(dropText(payload.paths))
      })
    : null

  let resizeTimer: ReturnType<typeof setTimeout> | undefined
  const observer = new ResizeObserver(() => {
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => fit.fit(), RESIZE_DEBOUNCE_MS)
  })
  observer.observe(host)
  // The --term-* tokens hang off the root's data-mode and data-ui; the theme event covers token changes without them
  const restyle = (): void => view.restyle()
  const themeObserver = new MutationObserver(restyle)
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode', 'data-ui', 'style', 'class'] })
  window.addEventListener('treeix-theme', restyle)

  return {
    view,
    close() {
      closed = true
      clearTimeout(resizeTimer)
      observer.disconnect()
      themeObserver.disconnect()
      window.removeEventListener('treeix-theme', restyle)
      void stopDrop?.then((stop) => stop())
      acks.flush()
      void attachment?.detach()
      view.dispose()
    }
  }
}
