import type { FitAddon } from '@xterm/addon-fit'
import type { Terminal } from '@xterm/xterm'
import { useSyncExternalStore } from 'react'
import { activeTheme, digitPressed, fontStack, getSettings, MONO_STACK, subscribeSettings } from '@treeix/app/settings'
import { terminalTitle } from './terminalTitle'
import { findFileLinks, findWebLinks } from './fileLinks'
import { THEMES } from '@treeix/app/themes'
import { addPane, type DropEdge, neighborPane, type PaneLayout, placePane as placeInLayout, remapPanes, removePane } from './paneLayout'
import { getCurrentWorkspaceId } from '@treeix/app/workspaces'
import { createBridge, SESSION_KINDS, type SessionKind, type SessionStatus } from '@treeix/sdk'
import type { LiveTerminal } from '../shared/types'

export { SESSION_KINDS, type SessionKind, type SessionStatus }

const bridge = createBridge('terminal')

// xterm is only needed once a session starts, so keep it out of the startup bundle
const loadXterm = (): Promise<[typeof import('@xterm/xterm'), typeof import('@xterm/addon-fit'), unknown]> =>
  Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit'), import('@xterm/xterm/css/xterm.css')])

/** What survives a reload or relaunch; the process itself does not survive quitting */
type SessionMeta = {
  worktreePath: string
  kind: SessionKind
  title: string
  startedAt: number
  /** Workspace active when the session started */
  workspaceId: string
  /** Claude conversation id chosen at start, so a relaunch resumes exactly this conversation */
  agentSessionId: string | null
}

export type Session = SessionMeta & {
  id: string
  status: SessionStatus
  exitCode: number | null
  lastOutput: number
  terminal: Terminal
  fit: FitAddon
  element: HTMLDivElement
  opened: boolean
  /** Last Claude plan file the session printed, e.g. when Claude runs inside a shell session */
  planName: string | null
}

/** Readline control codes that ⌘ arrows and ⌘⌫ send in macOS terminals */
const LINE_KEYS: Record<string, string> = { ArrowLeft: '\x01', ArrowRight: '\x05', Backspace: '\x15' }

type TerminalTheme = Record<string, string>

// VS Code's light terminal palette; xterm's default ANSI colors assume a dark background
const LIGHT_ANSI: TerminalTheme = {
  black: '#000000', red: '#cd3131', green: '#107c10', yellow: '#949800', blue: '#0451a5', magenta: '#bc05bc', cyan: '#0598bc', white: '#555555',
  brightBlack: '#666666', brightRed: '#cd3131', brightGreen: '#14ce14', brightYellow: '#b5ba00', brightBlue: '#0451a5', brightMagenta: '#bc05bc', brightCyan: '#0598bc', brightWhite: '#a5a5a5'
}

function terminalTheme(): TerminalTheme {
  const { foreground, mode } = THEMES[activeTheme()]
  // Transparent so the pane's own background fills the space the fitted grid leaves over
  const base = { background: '#00000000', foreground, cursor: foreground, selectionBackground: mode === 'light' ? '#0000002e' : '#ffffff33' }
  return mode === 'light' ? { ...base, ...LIGHT_ANSI } : base
}

subscribeSettings(() => {
  const theme = terminalTheme()
  const { terminalFontSize, terminalFont } = getSettings()
  const fontFamily = fontStack(terminalFont, MONO_STACK)
  for (const session of state.sessions) {
    session.terminal.options.theme = theme
    if (session.terminal.options.fontSize === terminalFontSize && session.terminal.options.fontFamily === fontFamily) continue
    Object.assign(session.terminal.options, { fontSize: terminalFontSize, fontFamily })
    fitSession(session.id)
  }
})

const ACTIVE_WINDOW_MS = 2000
// ponytail: screen-scraped prompt detection, switch to Claude Code hooks if it misfires
const WAITING_FOR_INPUT =
  /Do you want to|❯\s*1\.\s*Yes|Yes, and don't ask|\[y\/n\]|\(y\/n\)|Allow command|Would you like to run|Press Enter to continue/i

/** A closed session, kept so it can be started again; agent sessions resume their conversation */
export type ClosedSession = SessionMeta & { id: string; endedAt: number }

/** `panes` is the flat list of shown sessions; `layout` arranges them in columns */
type State = {
  sessions: Session[]
  panes: string[]
  layout: PaneLayout
  listOpen: boolean
  /** Pane filling the whole area, like iTerm's maximize */
  zoomed: string | null
  /** Newest first */
  history: ClosedSession[]
}

/** Opens a path ⌘-clicked in a session; set by the plugin, which knows where files show */
let fileLinkHandler: ((sessionId: string, path: string, line: number | null) => void) | null = null
export const setFileLinkHandler = (handler: typeof fileLinkHandler): void => {
  fileLinkHandler = handler
}

/** Opens a web address ⌘-clicked in a session, in the app when a plugin knows it, else in the browser */
let webLinkHandler: ((url: string) => void) | null = null
export const setWebLinkHandler = (handler: typeof webLinkHandler): void => {
  webLinkHandler = handler
}

const LIST_OPEN_KEY = 'terminal.listOpen'
const HISTORY_KEY = 'terminals.history'
const HISTORY_LIMIT = 100

function isClosedSession(value: unknown): value is ClosedSession {
  if (!isSessionMeta(value)) return false
  const { id, endedAt } = value as Partial<ClosedSession>
  return typeof id === 'string' && typeof endedAt === 'number'
}

function loadHistory(): ClosedSession[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter(isClosedSession) : []
  } catch {
    return []
  }
}

let state: State = { sessions: [], panes: [], layout: [], listOpen: localStorage.getItem(LIST_OPEN_KEY) === 'true', zoomed: null, history: loadHistory() }
const listeners = new Set<() => void>()
const pendingOutput = new Map<string, string>()

function update(next: Partial<State>): void {
  state = { ...state, ...next }
  listeners.forEach((listener) => listener())
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const useTerminals = (): State => useSyncExternalStore(subscribe, () => state)
export const subscribeTerminals = subscribe
export const getTerminals = (): State => state

const findSession = (id: string): Session | undefined => state.sessions.find((session) => session.id === id)

bridge.on('data', (id, data) => {
  if (typeof id !== 'string' || typeof data !== 'string') return
  const session = findSession(id)
  if (!session) {
    pendingOutput.set(id, (pendingOutput.get(id) ?? '') + data)
    return
  }
  session.terminal.write(data)
  session.lastOutput = Date.now()
})

bridge.on('exit', (id, exitCode) => {
  if (typeof id !== 'string' || typeof exitCode !== 'number') return
  update({
    sessions: state.sessions.map((session) => (session.id === id ? { ...session, status: 'exited', exitCode } : session))
  })
})

/** Wrapped rows are joined back into their line, so long paths stay whole */
function visibleScreen(terminal: Terminal): string {
  const buffer = terminal.buffer.active
  let text = ''
  for (let row = buffer.viewportY; row < buffer.viewportY + terminal.rows; row++) {
    const line = buffer.getLine(row)
    text += (row > buffer.viewportY && !line?.isWrapped ? '\n' : '') + (line?.translateToString(true) ?? '')
  }
  return text
}

const PLAN_PATH = /\.claude\/plans\/([\w.-]+\.md)/g
const printedPlan = (screen: string, current: string | null): string | null => [...screen.matchAll(PLAN_PATH)].at(-1)?.[1] ?? current

function detectStatus(session: Session, screen: string): SessionStatus {
  if (session.status === 'exited') return 'exited'
  if (session.kind !== 'shell' && WAITING_FOR_INPUT.test(screen)) return 'input'
  return Date.now() - session.lastOutput < ACTIVE_WINDOW_MS ? 'running' : 'idle'
}

setInterval(() => {
  const next = state.sessions.map((session) => {
    const screen = session.opened ? visibleScreen(session.terminal) : ''
    return { session, status: detectStatus(session, screen), planName: printedPlan(screen, session.planName) }
  })
  const changed = next.some(({ session, status, planName }) => status !== session.status || planName !== session.planName)
  if (changed) update({ sessions: next.map(({ session, status, planName }) => ({ ...session, status, planName })) })
}, 1000)

const setLayout = (layout: PaneLayout): void => update({ layout, panes: layout.flat(), zoomed: layout.flat().includes(state.zoomed ?? '') ? state.zoomed : null })

export const showPane = (id: string): void => setLayout(addPane(state.layout, id))

/** Drops a session onto an edge of another pane */
export const placePane = (id: string, targetId: string, edge: DropEdge): void => setLayout(placeInLayout(state.layout, id, targetId, edge))

/** The session list column beside the terminals */
export const setSessionListOpen = (listOpen: boolean): void => {
  localStorage.setItem(LIST_OPEN_KEY, String(listOpen))
  update({ listOpen })
}

export const hidePane = (id: string): void => setLayout(removePane(state.layout, id))

/** Before its pane is fitted, xterm must match the pty: zsh pads its prompt marker to the pty width, and at xterm's default 80 columns that padding wraps and leaves a blank line above the prompt */
const SPAWN_SIZE = { cols: 100, rows: 30 }

async function openSession(id: string, meta: SessionMeta, output: string, exitCode: number | null, size = SPAWN_SIZE): Promise<void> {
  const [{ Terminal }, { FitAddon }] = await loadXterm()
  const terminal = new Terminal({
    ...size,
    fontFamily: fontStack(getSettings().terminalFont, MONO_STACK),
    fontSize: getSettings().terminalFontSize,
    lineHeight: 1.15,
    cursorBlink: true,
    cursorStyle: 'bar',
    cursorWidth: 2,
    allowTransparency: true,
    // ⌥ types characters like ą and ś on Polish and other layouts; ⌥ arrows and ⌥⌫ still move and delete by word
    macOptionIsMeta: false,
    scrollback: 5000,
    theme: terminalTheme()
  })
  const fit = new FitAddon()
  terminal.loadAddon(fit)
  // ⌘-click on a printed path opens it in the app; wrapped lines are read one row at a time
  terminal.registerLinkProvider({
    provideLinks: (row, callback) => {
      const text = terminal.buffer.active.getLine(row - 1)?.translateToString(true) ?? ''
      const webLinks = findWebLinks(text)
      // A path inside a web address (…/merge_requests/437) belongs to the address
      const fileLinks = findFileLinks(text).filter((file) => !webLinks.some((web) => file.start < web.end && file.end > web.start))
      const range = (start: number, end: number) => ({ start: { x: start + 1, y: row }, end: { x: end, y: row } })
      callback([
        ...fileLinks.map((link) => ({
          text: text.slice(link.start, link.end),
          range: range(link.start, link.end),
          decorations: { underline: true, pointerCursor: true },
          activate: (event: MouseEvent) => {
            if (event.metaKey) fileLinkHandler?.(id, link.path, link.line)
          }
        })),
        ...webLinks.map((link) => ({
          text: link.url,
          range: range(link.start, link.end),
          decorations: { underline: true, pointerCursor: true },
          activate: (event: MouseEvent) => {
            if (event.metaKey) webLinkHandler?.(link.url)
          }
        }))
      ])
    }
  })
  const element = document.createElement('div')
  element.className = 'h-full w-full'
  // Replayed output still contains the programs' old terminal queries (device attributes, colors);
  // xterm answers them while parsing, and those answers would land in the shell as text like 1;2c
  let replaying = true
  terminal.onData((data) => {
    if (!replaying) bridge.send('write', id, data)
  })
  // ⌘ combos are app shortcuts (split, zoom, close); xterm would otherwise send keys like ⇧⌘↵ to the shell and swallow the event
  terminal.attachCustomKeyEventHandler((event) => {
    // xterm sends a plain Enter for Shift+Enter, which submits in Claude Code; Esc+Enter (Option+Enter) inserts a newline there and in zsh
    if (event.key === 'Enter' && event.shiftKey && !event.metaKey && !event.altKey && !event.ctrlKey) {
      if (event.type === 'keydown') bridge.send('write', id, '\x1b\r')
      return false
    }
    // ⌘←, ⌘→ and ⌘⌫ edit the line like in iTerm and Terminal.app: start of line, end of line, delete to start
    const lineKey = event.metaKey && !event.altKey && !event.ctrlKey && !event.shiftKey ? LINE_KEYS[event.key] : undefined
    if (lineKey) {
      if (event.type === 'keydown') bridge.send('write', id, lineKey)
      return false
    }
    // ⌃- and ⌃⇧- are the app's Go Back and Go Forward, not terminal input
    if (event.ctrlKey && event.code === 'Minus') return false
    const { panes, tabs, workspaces } = getSettings().digitShortcuts
    const digitShortcut = [panes, tabs, workspaces].some((modifier) => digitPressed(event, modifier) !== null)
    return !event.metaKey && !digitShortcut
  })
  // Programs name their window (Claude Code: the conversation topic, zsh themes: command or folder); that names the session
  terminal.onTitleChange((raw) => {
    const title = terminalTitle(raw)
    if (title && findSession(id)?.title !== title) update({ sessions: state.sessions.map((session) => (session.id === id ? { ...session, title } : session)) })
  })
  const status: SessionStatus = exitCode === null ? 'running' : 'exited'
  const session: Session = { ...meta, id, status, exitCode, lastOutput: Date.now(), terminal, fit, element, opened: false, planName: null }
  update({ sessions: [...state.sessions, session] })
  terminal.write(output + (pendingOutput.get(id) ?? ''), () => (replaying = false))
  pendingOutput.delete(id)
}

/** The usage-limits plugin fills the variable with its status line bridge; the terminal plugin's main module defaults it to `{}` */
const CLAUDE = 'claude --settings "$TREEIX_CLAUDE_SETTINGS"'

const spawnSession = (meta: SessionMeta, command: string | undefined): Promise<string> =>
  bridge.invoke<string>('create', { cwd: meta.worktreePath, command, ...SPAWN_SIZE, meta: JSON.stringify(meta) })

/** `promptArgument` is an already shell-quoted first prompt for agent sessions */
export async function createSession(worktreePath: string, kind: SessionKind, promptArgument?: string): Promise<string> {
  const sameKind = state.sessions.filter((session) => session.worktreePath === worktreePath && session.kind === kind)
  const agentSessionId = kind === 'claude' ? crypto.randomUUID() : null
  const meta: SessionMeta = {
    worktreePath,
    kind,
    title: `${SESSION_KINDS[kind].label}${sameKind.length ? ` ${sameKind.length + 1}` : ''}`,
    startedAt: Date.now(),
    workspaceId: getCurrentWorkspaceId(),
    agentSessionId
  }
  const base = agentSessionId ? `${CLAUDE} --session-id ${agentSessionId}` : (SESSION_KINDS[kind].command ?? undefined)
  // A shell session takes the argument as the command line to run
  const command = base ? (promptArgument ? `${base} ${promptArgument}` : base) : promptArgument
  const id = await spawnSession(meta, command)
  await openSession(id, meta, '', null)
  showPane(id)
  return id
}

// ponytail: Codex can't be given an id up front, so relaunch resumes its latest conversation; read ~/.codex/sessions if two Codex sessions clash
function resumeCommand(meta: SessionMeta): string | undefined {
  if (meta.kind === 'codex') return 'codex resume --last'
  if (meta.kind !== 'claude' || !meta.agentSessionId) return SESSION_KINDS[meta.kind].command ?? undefined
  const id = meta.agentSessionId
  // A session closed before its first message has no transcript, and --resume would fail on it
  return `if ls ~/.claude/projects/*/${id}.jsonl >/dev/null 2>&1; then ${CLAUDE} --resume ${id}; else ${CLAUDE} --session-id ${id}; fi`
}

const SAVED_KEY = 'terminals.saved'
type Saved = { sessions: (SessionMeta & { id: string })[]; layout: PaneLayout }

function isSessionMeta(value: unknown): value is SessionMeta {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<SessionMeta>
  return typeof candidate.worktreePath === 'string' && typeof candidate.title === 'string' && (candidate.kind === 'claude' || candidate.kind === 'codex' || candidate.kind === 'shell')
}

function loadSaved(): Saved {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SAVED_KEY) ?? 'null')
    if (typeof parsed !== 'object' || parsed === null) return { sessions: [], layout: [] }
    const { sessions, layout } = parsed as Partial<Saved>
    return {
      sessions: Array.isArray(sessions) ? sessions.filter((session) => isSessionMeta(session) && typeof session.id === 'string') : [],
      layout: Array.isArray(layout) ? layout.filter((column) => Array.isArray(column) && column.every((id) => typeof id === 'string')) : []
    }
  } catch {
    return { sessions: [], layout: [] }
  }
}

const parseMeta = (text: string): SessionMeta | null => {
  try {
    const parsed: unknown = JSON.parse(text)
    return isSessionMeta(parsed) ? parsed : null
  } catch {
    return null
  }
}

let restored = false

/** After a reload the processes are still running, so reattach; after a relaunch start them again, resuming agent conversations */
async function restoreSessions(): Promise<void> {
  const saved = loadSaved()
  const live = await bridge.invoke<LiveTerminal[]>('list')
  const ids = new Map<string, string>()
  if (live.length > 0) {
    for (const terminal of live) {
      const meta = parseMeta(terminal.meta)
      if (!meta) continue
      await openSession(terminal.id, meta, terminal.output, terminal.exitCode, { cols: terminal.cols, rows: terminal.rows })
      ids.set(terminal.id, terminal.id)
    }
  } else {
    for (const { id: savedId, ...meta } of saved.sessions) {
      const id = await spawnSession(meta, resumeCommand(meta))
      await openSession(id, meta, '', null)
      ids.set(savedId, id)
    }
  }
  setLayout(remapPanes(saved.layout, (id) => ids.get(id)))
  restored = true
}

subscribe(() => {
  if (!restored) return
  const sessions = state.sessions
    .filter((session) => session.status !== 'exited')
    .map(({ id, worktreePath, kind, title, startedAt, workspaceId, agentSessionId }) => ({ id, worktreePath, kind, title, startedAt, workspaceId, agentSessionId }))
  const saved: Saved = { sessions, layout: remapPanes(state.layout, (id) => (sessions.some((session) => session.id === id) ? id : undefined)) }
  localStorage.setItem(SAVED_KEY, JSON.stringify(saved))
})

void restoreSessions().catch(() => {
  restored = true
})

/** Open the xterm lazily: it needs a mounted element to measure fonts */
export function attachSession(id: string, container: HTMLElement): void {
  const session = findSession(id)
  if (!session) return
  // Sessions started before this setting existed keep their old cursor until they are shown again
  session.terminal.options.cursorStyle = 'bar'
  session.terminal.options.cursorWidth = 2
  container.appendChild(session.element)
  if (!session.opened) {
    session.terminal.open(session.element)
    session.opened = true
  }
  fitSession(id)
}

export function fitSession(id: string): void {
  const session = findSession(id)
  if (!session?.opened || !session.element.isConnected) return
  session.fit.fit()
  bridge.send('resize', id, session.terminal.cols, session.terminal.rows)
}

export function focusSession(id: string): void {
  findSession(id)?.terminal.focus()
}

const setHistory = (history: ClosedSession[]): void => {
  const kept = history.slice(0, HISTORY_LIMIT)
  localStorage.setItem(HISTORY_KEY, JSON.stringify(kept))
  update({ history: kept })
}

/** Ends the process and moves the session to the history */
export function killSession(id: string): void {
  const session = findSession(id)
  if (!session) return
  bridge.send('kill', id)
  session.terminal.dispose()
  const layout = removePane(state.layout, id)
  const { worktreePath, kind, title, startedAt, workspaceId, agentSessionId } = session
  update({ sessions: state.sessions.filter((candidate) => candidate.id !== id), layout, panes: layout.flat() })
  setHistory([{ id, worktreePath, kind, title, startedAt, workspaceId, agentSessionId, endedAt: Date.now() }, ...state.history])
}

export const forgetClosedSession = (id: string): void => setHistory(state.history.filter((entry) => entry.id !== id))
export const clearClosedSessions = (ids: string[]): void => setHistory(state.history.filter((entry) => !ids.includes(entry.id)))

/** Starts a closed session again in its folder, resuming the agent conversation, and shows it */
export async function restoreClosedSession(entry: ClosedSession): Promise<string> {
  const { id: _closedId, endedAt: _endedAt, ...meta } = entry
  const id = await spawnSession(meta, resumeCommand(meta))
  await openSession(id, meta, '', null)
  showPane(id)
  forgetClosedSession(entry.id)
  return id
}

/** Paste as one bracketed block so TUIs like Claude Code keep newlines inside the prompt */
const STARTUP_QUIET_MS = 1500
const STARTUP_TIMEOUT_MS = 20_000

/**
 * Resolves once a freshly started session has printed something and then gone quiet, i.e. its prompt is up.
 * ponytail: output-silence heuristic, switch to Claude Code's SessionStart hook if pastes land too early
 */
export function whenReady(id: string): Promise<void> {
  const startedAt = Date.now()
  return new Promise((resolve) => {
    const check = (): void => {
      const session = findSession(id)
      const quiet = session !== undefined && session.lastOutput > startedAt && Date.now() - session.lastOutput > STARTUP_QUIET_MS
      if (quiet || Date.now() - startedAt > STARTUP_TIMEOUT_MS) resolve()
      else setTimeout(check, 250)
    }
    check()
  })
}

export function sendText(id: string, text: string, submit: boolean): void {
  bridge.send('write', id, `\x1b[200~${text}\x1b[201~`)
  if (submit) setTimeout(() => bridge.send('write', id, '\r'), 150)
  showPane(id)
}

export const terminalSelection = (id: string): string => findSession(id)?.terminal.getSelection() ?? ''

/** xterm wraps pasted text in bracketed-paste markers when the program asked for them */
export async function pasteClipboard(id: string): Promise<void> {
  findSession(id)?.terminal.paste(await navigator.clipboard.readText())
}

/** The pane holding keyboard focus, else the last one shown */
export function activePane(): Session | undefined {
  const focused = document.activeElement?.closest<HTMLElement>('[data-session-id]')?.dataset.sessionId
  return findSession(focused ?? '') ?? findSession(state.panes.at(-1) ?? '')
}

/** Focuses the nth pane on screen, in reading order; false when no terminal is shown */
export function focusPaneAt(position: number): boolean {
  const pane = document.querySelectorAll<HTMLElement>('[data-session-id]')[position - 1]
  if (pane?.dataset.sessionId) focusSession(pane.dataset.sessionId)
  return document.querySelector('[data-session-id]') !== null
}

export const isTerminalFocused = (): boolean => document.activeElement?.closest('[data-session-id]') != null

/** New shell beside the active pane, in its folder, like iTerm's ⌘D and ⇧⌘D */
export async function splitPane(edge: DropEdge, fallbackCwd: string): Promise<void> {
  const anchor = activePane()
  const id = await createSession(anchor?.worktreePath ?? fallbackCwd, 'shell')
  if (anchor) setLayout(placeInLayout(state.layout, id, anchor.id, edge))
  setTimeout(() => focusSession(id))
}

/** Ends the session; it stays in the history, so an agent conversation can be resumed */
export function closeActivePane(): void {
  const session = activePane()
  if (!session) return
  const next = neighborPane(state.layout, session.id, 'top') ?? neighborPane(state.layout, session.id, 'left') ?? neighborPane(state.layout, session.id, 'bottom') ?? neighborPane(state.layout, session.id, 'right')
  killSession(session.id)
  if (next) setTimeout(() => focusSession(next))
}

export function focusNeighbor(direction: DropEdge): void {
  const session = activePane()
  const next = session && neighborPane(state.layout, session.id, direction)
  if (next) focusSession(next)
}

export function toggleZoom(): void {
  const session = activePane()
  if (!session) return
  update({ zoomed: state.zoomed === session.id ? null : session.id })
  setTimeout(() => focusSession(session.id))
}

export const selectAllTerminal = (id: string): void => findSession(id)?.terminal.selectAll()
export const clearTerminal = (id: string): void => findSession(id)?.terminal.clear()
