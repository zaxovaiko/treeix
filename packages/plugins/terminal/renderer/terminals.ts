import type { FitAddon } from '@xterm/addon-fit'
import type { Terminal } from '@xterm/xterm'
import { useSyncExternalStore } from 'react'
import { activeTheme, digitPressed, fontStack, getSettings, MONO_STACK, subscribeSettings } from '@treeix/app/settings'
import { agentOr, getAgent, isAgent, resumeCommandFor, startCommand } from '@treeix/app/agents'
import { findService, isPluginEnabled } from '@treeix/app/plugins'
import { terminalTitle } from './terminalTitle'
import { findFileLinks, findWebLinks } from './fileLinks'
import { THEMES } from '@treeix/app/themes'
import { type DropEdge, neighborPane, type PaneLayout, remapPanes } from './paneLayout'
import { activeTabOf, addTab, newTask, parseTasks, placeBeside, remapTasks, removeSession, shownPanes, type Task, taskOf, taskPanes, tasksFromSessions, tabPanes } from './tasks'
import { getCurrentWorkspaceId } from '@treeix/app/workspaces'
import { type ChatService, createBridge, type SessionKind, type SessionPort, type SessionStatus } from '@treeix/sdk'
import type { LiveTerminal } from '../shared/types'
import { isDefaultChatTitle, NEW_CHAT_TITLE, parseMeta, type SessionMeta, type SessionView } from './sessionMeta'

export { type SessionKind, type SessionStatus, type SessionView }

const bridge = createBridge('terminal')

// xterm is only needed once a session starts, so keep it out of the startup bundle
const loadXterm = (): Promise<[typeof import('@xterm/xterm'), typeof import('@xterm/addon-fit'), unknown]> =>
  Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit'), import('@xterm/xterm/css/xterm.css')])

export type TerminalSession = SessionMeta & {
  id: string
  view: 'terminal'
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

/** A chat with an agent, drawn by the chat plugin; `status` mirrors the chat's */
export type ChatSession = SessionMeta & { id: string; view: 'chat'; status: SessionStatus; exitCode: null; lastOutput: number }

export type Session = TerminalSession | ChatSession

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
  const { terminalFontSize, terminalFont, terminalScrollback } = getSettings()
  const fontFamily = fontStack(terminalFont, MONO_STACK)
  for (const session of state.sessions) {
    if (session.view !== 'terminal') continue
    session.terminal.options.theme = theme
    if (session.terminal.options.scrollback !== terminalScrollback) session.terminal.options.scrollback = terminalScrollback
    if (session.terminal.options.fontSize === terminalFontSize && session.terminal.options.fontFamily === fontFamily) continue
    Object.assign(session.terminal.options, { fontSize: terminalFontSize, fontFamily })
    fitSession(session.id)
  }
})

const ACTIVE_WINDOW_MS = 2000
// ponytail: screen-scraped prompt detection, switch to Claude Code hooks if it misfires
const WAITING_FOR_INPUT =
  /Do you want to|❯\s*1\.\s*Yes|Yes, and don't ask|\[y\/n\]|\(y\/n\)|Allow command|Would you like to run|Press Enter to continue/i

/** A closed session, kept so it can be started again; agent sessions resume their conversation, in their task when it still exists */
export type ClosedSession = SessionMeta & { id: string; endedAt: number; taskId?: string }

type State = {
  sessions: Session[]
  tasks: Task[]
  /** Task shown in each workspace, by workspace id */
  selected: Record<string, string>
  /** Pane filling its tab, like iTerm's maximize */
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

const HISTORY_KEY = 'terminals.history'
const HISTORY_LIMIT = 100

function parseClosedSession(value: unknown): ClosedSession | null {
  const meta = parseMeta(value)
  const { id, endedAt } = (meta ?? {}) as Partial<ClosedSession>
  return meta && typeof id === 'string' && typeof endedAt === 'number' ? (meta as ClosedSession) : null
}

function loadHistory(): ClosedSession[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.map(parseClosedSession).filter((entry) => entry !== null) : []
  } catch {
    return []
  }
}

let state: State = { sessions: [], tasks: [], selected: {}, zoomed: null, history: loadHistory() }
const listeners = new Set<() => void>()
/** Output of sessions not opened yet; sessions that never open (killed, another window's) must not grow it forever */
const pendingOutput = new Map<string, string>()
const PENDING_SESSIONS = 20
const PENDING_CHARS = 256_000

const notify = (): void => listeners.forEach((listener) => listener())

function update(next: Partial<State>): void {
  state = { ...state, ...next }
  notify()
  syncPortPolling()
}

const PORTS_POLL_MS = 3000
let ports: SessionPort[] = []
let portsTimer: ReturnType<typeof setInterval> | null = null
export const getPorts = (): SessionPort[] => ports

const samePorts = (a: SessionPort[], b: SessionPort[]): boolean => a.length === b.length && a.every((port, index) => port.sessionId === b[index].sessionId && port.port === b[index].port && port.cwd === b[index].cwd)

function setPorts(next: SessionPort[]): void {
  if (samePorts(ports, next)) return
  ports = next
  notify()
}

let polling = false

async function pollPorts(): Promise<void> {
  if (polling || document.hidden) return
  polling = true
  const found = await bridge.invoke<{ sessionId: string; port: number; cwd: string | null }[]>('ports').catch(() => null)
  polling = false
  if (found && portsTimer) setPorts(found.map(({ sessionId, port, cwd }) => ({ sessionId, port, cwd, url: `http://localhost:${port}` })).sort((a, b) => a.port - b.port))
}

/** Asks main for listening ports only while some session has a running process */
function syncPortPolling(): void {
  const live = state.sessions.some((session) => session.view === 'terminal' && session.status !== 'exited' && session.status !== 'dormant')
  if (live && !portsTimer) {
    portsTimer = setInterval(() => void pollPorts(), PORTS_POLL_MS)
    void pollPorts()
  } else if (!live && portsTimer) {
    clearInterval(portsTimer)
    portsTimer = null
    setPorts([])
  }
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const useTerminals = (): State => useSyncExternalStore(subscribe, () => state)
export const subscribeTerminals = subscribe
export const getTerminals = (): State => state

const findSession = (id: string): Session | undefined => state.sessions.find((session) => session.id === id)
const findTerminal = (id: string): TerminalSession | undefined => state.sessions.find((session): session is TerminalSession => session.id === id && session.view === 'terminal')

bridge.on('data', (id, data) => {
  if (typeof id !== 'string' || typeof data !== 'string') return
  const session = findTerminal(id)
  if (!session) {
    const buffered = ((pendingOutput.get(id) ?? '') + data).slice(-PENDING_CHARS)
    pendingOutput.delete(id)
    pendingOutput.set(id, buffered)
    if (pendingOutput.size > PENDING_SESSIONS) pendingOutput.delete(pendingOutput.keys().next().value ?? '')
    return
  }
  session.terminal.write(data)
  session.lastOutput = Date.now()
})

bridge.on('exit', (id, exitCode) => {
  if (typeof id !== 'string' || typeof exitCode !== 'number') return
  update({
    sessions: state.sessions.map((session) => (session.id === id && session.view === 'terminal' ? { ...session, status: 'exited', exitCode } : session))
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

function detectStatus(session: TerminalSession, screen: string): SessionStatus {
  if (session.status === 'exited' || session.status === 'dormant') return session.status
  if (isAgent(session.kind) && WAITING_FOR_INPUT.test(screen)) return 'input'
  return Date.now() - session.lastOutput < ACTIVE_WINDOW_MS ? 'running' : 'idle'
}

setInterval(() => {
  // Statuses only show on screen; a hidden window catches up within a second of showing
  if (document.hidden) return
  const next = state.sessions.map((session): Session => {
    // Chats take their status from the chat plugin
    if (session.view !== 'terminal') return session
    const screen = session.opened ? visibleScreen(session.terminal) : ''
    const status = detectStatus(session, screen)
    const planName = printedPlan(screen, session.planName)
    return status !== session.status || planName !== session.planName ? { ...session, status, planName } : session
  })
  if (next.some((session, index) => session !== state.sessions[index])) update({ sessions: next })
}, 1000)

const setTasks = (tasks: Task[], selected = state.selected): void => update({ tasks, selected })
const mapTask = (id: string, change: (task: Task) => Task): Task[] => state.tasks.map((task) => (task.id === id ? change(task) : task))

/** The task shown in the current workspace */
export const currentTask = (): Task | undefined => state.tasks.find((task) => task.id === state.selected[getCurrentWorkspaceId()])

export const selectTask = (id: string): void => {
  if (state.selected[getCurrentWorkspaceId()] !== id) update({ selected: { ...state.selected, [getCurrentWorkspaceId()]: id } })
}

/** Creates a task in the current workspace and shows it */
export function createTask(name: string, worktreePath: string): string {
  const task = newTask({ name, worktreePath, workspaceId: getCurrentWorkspaceId() })
  setTasks([...state.tasks, task], { ...state.selected, [task.workspaceId]: task.id })
  return task.id
}

export const renameTask = (id: string, name: string): void => setTasks(mapTask(id, (task) => ({ ...task, name })))

/** Ends the task's sessions, which stay in the history, and forgets the task; asks first when processes are running, since shells and dev servers can't be resumed */
export function deleteTask(id: string): void {
  const task = state.tasks.find((candidate) => candidate.id === id)
  if (!task) return
  const panes = taskPanes(task)
  const running = state.sessions.filter((session) => panes.includes(session.id) && session.status !== 'exited' && session.status !== 'dormant').length
  if (running > 0 && !window.confirm(`Delete the group and end its ${running} running ${running === 1 ? 'process' : 'processes'}?`)) return
  panes.forEach(killSession)
  setTasks(state.tasks.filter((candidate) => candidate.id !== id))
}

export const setActiveTab = (taskId: string, tabId: string): void => setTasks(mapTask(taskId, (task) => ({ ...task, activeTab: tabId })))

/** Remembers the pane last focused in its tab, so coming back to the tab lands there */
export function setTabFocus(sessionId: string): void {
  const task = taskOf(state.tasks, sessionId)
  const tab = task?.tabs.find((candidate) => tabPanes(candidate).includes(sessionId))
  if (!task || !tab || tab.focus === sessionId) return
  setTasks(mapTask(task.id, (current) => ({ ...current, tabs: current.tabs.map((candidate) => (candidate === tab ? { ...tab, focus: sessionId } : candidate)) })))
}

/** Shows the session's task and tab; a session in no tab opens as a new tab of the shown task */
export function revealSession(id: string): void {
  const task = taskOf(state.tasks, id)
  const tab = task?.tabs.find((candidate) => tabPanes(candidate).includes(id))
  void wakeSession(id)
  if (!task || !tab) return placeSession(id, currentTask()?.id)
  setTasks(
    mapTask(task.id, (current) => ({ ...current, activeTab: tab.id, tabs: current.tabs.map((candidate) => (candidate === tab ? { ...tab, focus: id } : candidate)) })),
    { ...state.selected, [getCurrentWorkspaceId()]: task.id }
  )
}

/**
 * Opens a session as a new tab: in `taskId`, else in the shown task when it is on the same folder, else in another
 * task of the workspace on that folder, else in a new task for the folder. `select` shows that task.
 */
function placeSession(id: string, taskId?: string, select = true): void {
  const session = findSession(id)
  if (!session) return
  const shown = state.tasks.find((task) => task.id === state.selected[session.workspaceId])
  const existing =
    state.tasks.find((task) => task.id === taskId) ??
    (shown?.worktreePath === session.worktreePath ? shown : state.tasks.find((task) => task.workspaceId === session.workspaceId && task.worktreePath === session.worktreePath))
  const task = existing ?? newTask({ workspaceId: session.workspaceId, worktreePath: session.worktreePath })
  const tasks = existing ? state.tasks : [...state.tasks, task]
  setTasks(
    tasks.map((candidate) => (candidate.id === task.id ? addTab(candidate, id) : candidate)),
    select ? { ...state.selected, [task.workspaceId]: task.id } : state.selected
  )
}

/** Drops sessions, a pane or a whole tab's, onto an edge of another pane */
export const placePane = (ids: string[], targetId: string, edge: DropEdge): void => setTasks(placeBeside(state.tasks, ids, targetId, edge))

/** Before its pane is fitted, xterm must match the pty: zsh pads its prompt marker to the pty width, and at xterm's default 80 columns that padding wraps and leaves a blank line above the prompt */
const SPAWN_SIZE = { cols: 100, rows: 30 }

/** `dormant` makes the terminal without a process behind it; `wakeSession` starts one */
async function openSession(id: string, meta: SessionMeta, output: string, exitCode: number | null, size = SPAWN_SIZE, dormant = false): Promise<void> {
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
    scrollback: getSettings().terminalScrollback,
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
    // ⌥ digits pick a pane; the tab and workspace digits are set in Settings
    const { tabs, workspaces } = getSettings().digitShortcuts
    const digitShortcut = (['alt', tabs, workspaces] as const).some((modifier) => digitPressed(event, modifier) !== null)
    return !event.metaKey && !digitShortcut
  })
  // Programs name their window (Claude Code: the conversation topic, zsh themes: command or folder); that names the session
  terminal.onTitleChange((raw) => {
    const title = terminalTitle(raw)
    if (title && findSession(id)?.title !== title) update({ sessions: state.sessions.map((session) => (session.id === id ? { ...session, title } : session)) })
  })
  const status: SessionStatus = dormant ? 'dormant' : exitCode === null ? 'running' : 'exited'
  const session: TerminalSession = { ...meta, view: 'terminal', id, status, exitCode, lastOutput: Date.now(), terminal, fit, element, opened: false, planName: null }
  update({ sessions: [...state.sessions, session] })
  terminal.write(output + (pendingOutput.get(id) ?? ''), () => (replaying = false))
  pendingOutput.delete(id)
}

const spawnSession = (meta: SessionMeta, command: string | undefined, id?: string, size = SPAWN_SIZE): Promise<string> =>
  bridge.invoke<string>('create', { cwd: meta.worktreePath, command, ...size, meta: JSON.stringify(meta), id })

const metaOf = ({ worktreePath, kind, title, startedAt, workspaceId, agentSessionId, view }: SessionMeta): SessionMeta => ({ worktreePath, kind, title, startedAt, workspaceId, agentSessionId, view })

function newMeta(worktreePath: string, kind: SessionKind, view: SessionView): SessionMeta {
  const same = state.sessions.filter((session) => session.worktreePath === worktreePath && session.kind === kind && session.view === view).length
  const agent = agentOr(kind)
  const title = view === 'chat' ? NEW_CHAT_TITLE : agent.label
  // Chats learn their conversation id from the agent once connected
  const agentSessionId = view === 'terminal' && agent.sessionIdFlag ? crypto.randomUUID() : null
  return { worktreePath, kind, title: `${title}${same ? ` ${same + 1}` : ''}`, startedAt: Date.now(), workspaceId: getCurrentWorkspaceId(), agentSessionId, view }
}

/** Starts a session without showing it anywhere yet */
async function startSession(worktreePath: string, kind: SessionKind, promptArgument?: string): Promise<string> {
  const meta = newMeta(worktreePath, kind, 'terminal')
  const id = await spawnSession(meta, startCommand(agentOr(kind), promptArgument, meta.agentSessionId))
  await openSession(id, meta, '', null)
  return id
}

/** Chat needs the chat plugin on and an agent with a chat command */
const canChat = (kind: SessionKind): boolean => isPluginEnabled('chat') && getAgent(kind)?.chat !== undefined

/** A chat that can't be one any more opens as a terminal, resuming the agent's conversation */
const openable = (meta: SessionMeta): SessionMeta => (meta.view === 'chat' && !canChat(meta.kind) ? { ...meta, view: 'terminal' } : meta)

/** Adds a chat, dormant: `wakeSession` connects it */
function openChat(id: string, meta: SessionMeta): void {
  const session: ChatSession = { ...meta, view: 'chat', id, status: 'dormant', exitCode: null, lastOutput: Date.now() }
  update({ sessions: [...state.sessions, session] })
}

/** A chat with the agent as a new tab, resuming the agent's conversation `resume` when given */
function startChat(worktreePath: string, kind: SessionKind, taskId?: string, resume: string | null = null): string {
  const id = crypto.randomUUID()
  openChat(id, { ...newMeta(worktreePath, kind, 'chat'), agentSessionId: resume })
  placeSession(id, taskId)
  void wakeSession(id)
  return id
}

/**
 * `promptArgument` is an already shell-quoted first prompt for agent terminals; the session opens as a new tab of `taskId`,
 * or of the task for its folder. A chat for an agent that can't chat opens as a terminal.
 */
export async function createSession(worktreePath: string, kind: SessionKind, promptArgument?: string, taskId?: string, view: SessionView = 'terminal'): Promise<string> {
  if (view === 'chat' && canChat(kind)) return startChat(worktreePath, kind, taskId)
  const id = await startSession(worktreePath, kind, promptArgument)
  placeSession(id, taskId)
  return id
}

/** An agent the user has since deleted has no command, so its session reopens as a plain shell in its folder */
function resumeCommand(meta: SessionMeta): string | undefined {
  const agent = getAgent(meta.kind)
  return agent ? resumeCommandFor(agent, meta.agentSessionId) : undefined
}

const SAVED_KEY = 'terminals.saved'
/** `layout` is from before tasks, read once to move those sessions into tasks */
type Saved = { sessions: (SessionMeta & { id: string })[]; layout: PaneLayout }
const TASKS_KEY = 'terminals.tasks'

function loadTasks(): { tasks: Task[]; selected: Record<string, string> } | null {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(TASKS_KEY) ?? 'null')
    if (typeof parsed !== 'object' || parsed === null) return null
    const { tasks, selected } = parsed as Record<string, unknown>
    const picks = typeof selected === 'object' && selected !== null ? Object.entries(selected).filter((entry): entry is [string, string] => typeof entry[1] === 'string') : []
    return { tasks: parseTasks(tasks), selected: Object.fromEntries(picks) }
  } catch {
    return null
  }
}

function loadSaved(): Saved {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SAVED_KEY) ?? 'null')
    if (typeof parsed !== 'object' || parsed === null) return { sessions: [], layout: [] }
    const { sessions, layout } = parsed as Partial<Saved>
    return {
      sessions: Array.isArray(sessions)
        ? sessions.flatMap((session) => {
            const meta = parseMeta(session)
            return meta && typeof session.id === 'string' ? [{ ...meta, id: session.id }] : []
          })
        : [],
      layout: Array.isArray(layout) ? layout.filter((column) => Array.isArray(column) && column.every((id) => typeof id === 'string')) : []
    }
  } catch {
    return { sessions: [], layout: [] }
  }
}

const parseMetaText = (text: string): SessionMeta | null => {
  try {
    return parseMeta(JSON.parse(text))
  } catch {
    return null
  }
}

const waking = new Map<string, Promise<void>>()

/**
 * Starts a dormant session under its own id, resuming its agent conversation; resolves once the process runs or the
 * chat connected. A chat waits while the chat plugin is still loading; its pane wakes it once the plugin is there.
 */
export function wakeSession(id: string): Promise<void> {
  const session = findSession(id)
  if (session?.status !== 'dormant') return Promise.resolve()
  const pending = waking.get(id)
  if (pending) return pending
  const started = session.view === 'chat' ? connectChat(session) : spawnTerminal(session)
  if (!started) return Promise.resolve()
  const tracked = started.finally(() => waking.delete(id))
  waking.set(id, tracked)
  return tracked
}

const spawnTerminal = (session: TerminalSession): Promise<void> =>
  spawnSession(metaOf(session), resumeCommand(session), session.id, { cols: session.terminal.cols, rows: session.terminal.rows }).then(() => {
    const { id } = session
    // Closed while starting: killSession had no process to end yet
    if (!findSession(id)) return bridge.send('kill', id)
    update({ sessions: state.sessions.map((candidate) => (candidate.id === id ? { ...candidate, status: 'running' } : candidate)) })
    fitSession(id)
  })

/** Chats connecting show as running; the chat plugin only knows them once connected */
const connecting = new Set<string>()

function connectChat(session: ChatSession): Promise<void> | null {
  const chat = findService('chat')
  const agent = getAgent(session.kind)
  if (!chat || !agent?.chat) return null
  followChats(chat)
  const { id } = session
  connecting.add(id)
  update({ sessions: state.sessions.map((candidate) => (candidate.id === id ? { ...candidate, status: 'running' } : candidate)) })
  return chat
    .start(id, { agent: agent.id, adapter: agent.chat.adapter, command: agent.chat.command, cwd: session.worktreePath, resume: session.agentSessionId })
    .then(
      (agentSessionId) => {
        // Closed while connecting
        if (!findSession(id)) return chat.stop(id)
        update({ sessions: state.sessions.map((candidate) => (candidate.id === id ? { ...candidate, agentSessionId } : candidate)) })
      },
      // The chat shows why, with Retry
      () => undefined
    )
    .finally(() => {
      connecting.delete(id)
      syncChats()
    })
}

let followed: ChatService | null = null
function followChats(chat: ChatService): void {
  if (followed === chat) return
  followed = chat
  chat.subscribe(syncChats)
}

/**
 * Chat statuses feed the sessions' own, so dots, badges and keep awake see chats like terminals; the conversation id and
 * first message are kept too. Without the chat plugin chats go dormant, and wake once it is back and they show.
 */
export function syncChats(): void {
  const chat = findService('chat')
  const next = state.sessions.map((session): Session => {
    if (session.view !== 'chat') return session
    if (!chat) return session.status === 'dormant' ? session : { ...session, status: 'dormant' }
    const status = session.status === 'dormant' ? 'dormant' : connecting.has(session.id) ? 'running' : chat.status(session.id)
    const agentSessionId = chat.agentSessionId(session.id) ?? session.agentSessionId
    const title = (isDefaultChatTitle(session.title) && chat.title(session.id)) || session.title
    const same = status === session.status && agentSessionId === session.agentSessionId && title === session.title
    return same ? session : { ...session, status, agentSessionId, title }
  })
  if (next.some((session, index) => session !== state.sessions[index])) update({ sessions: next })
}

let restored = false

/**
 * After a reload the processes are still running, so reattach. After a relaunch only the panes on screen start again,
 * resuming agent conversations; the rest stay dormant until shown, and stay dormant through reloads.
 */
async function restoreSessions(): Promise<void> {
  const saved = loadSaved()
  const savedTasks = loadTasks()
  const live = await bridge.invoke<LiveTerminal[]>('list')
  for (const terminal of live) {
    const meta = parseMetaText(terminal.meta)
    if (meta) await openSession(terminal.id, meta, terminal.output, terminal.exitCode, { cols: terminal.cols, rows: terminal.rows })
  }
  const eager = live.length === 0 && savedTasks ? shownPanes(savedTasks.tasks, savedTasks.selected, getCurrentWorkspaceId()) : []
  for (const { id, ...savedMeta } of saved.sessions) {
    if (findSession(id)) continue
    const meta = openable(savedMeta)
    // Chats connect once shown, from their pane
    if (meta.view === 'chat') {
      openChat(id, meta)
      continue
    }
    const dormant = !eager.includes(id)
    if (!dormant) await spawnSession(meta, resumeCommand(meta), id)
    await openSession(id, meta, '', null, SPAWN_SIZE, dormant)
  }
  const rename = (id: string): string | undefined => (findSession(id) ? id : undefined)
  const tasks = savedTasks
    ? remapTasks(savedTasks.tasks, rename)
    : tasksFromSessions(state.sessions.filter((session) => !taskOf(state.tasks, session.id)), remapPanes(saved.layout, rename).flat())
  const selected = savedTasks?.selected ?? Object.fromEntries([...tasks].reverse().map((task) => [task.workspaceId, task.id]))
  setTasks([...tasks, ...state.tasks], { ...selected, ...state.selected })
  placeOrphans()
  restored = true
}

/** Sessions in no tab open as tabs of the task for their folder, so every session stays reachable */
const placeOrphans = (): void => state.sessions.filter((session) => !taskOf(state.tasks, session.id)).forEach((session) => placeSession(session.id, undefined, false))

// Most updates (statuses, titles) change nothing saved, and localStorage writes are synchronous
const written = new Map<string, string>()
function store(key: string, json: string): void {
  if (written.get(key) === json) return
  written.set(key, json)
  localStorage.setItem(key, json)
}

subscribe(() => {
  if (!restored) return
  // A chat that lost its agent keeps its tab: it resumes with Retry or on the next launch
  const sessions = state.sessions.filter((session) => session.view === 'chat' || session.status !== 'exited').map((session) => ({ id: session.id, ...metaOf(session) }))
  const saved: Saved = { sessions, layout: [] }
  store(SAVED_KEY, JSON.stringify(saved))
  store(TASKS_KEY, JSON.stringify({ tasks: state.tasks, selected: state.selected }))
})

void restoreSessions().catch(() => {
  // The processes are out of reach, but the tasks stay
  const saved = loadTasks()
  if (saved) setTasks([...remapTasks(saved.tasks, () => undefined), ...state.tasks], { ...saved.selected, ...state.selected })
  // Sessions reattached before the failure
  placeOrphans()
  restored = true
})

/**
 * Draws with WebGL instead of DOM rows, which is what keeps a busy agent's redraws from lagging the window. A lost
 * context (the GPU reset, or Chromium dropping the oldest of its ~16 contexts) falls back to the DOM renderer
 */
// ponytail: one context per opened terminal; release contexts of hidden sessions if more than ~16 stay open
function drawWithGpu(terminal: import('@xterm/xterm').Terminal): void {
  void import('@xterm/addon-webgl')
    .then(({ WebglAddon }) => {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      terminal.loadAddon(webgl)
    })
    .catch(() => undefined)
}

/** Open the xterm lazily: it needs a mounted element to measure fonts */
export function attachSession(id: string, container: HTMLElement): void {
  const session = findTerminal(id)
  if (!session) return
  // Sessions started before this setting existed keep their old cursor until they are shown again
  session.terminal.options.cursorStyle = 'bar'
  session.terminal.options.cursorWidth = 2
  if (session.element.parentElement !== container) container.appendChild(session.element)
  if (!session.opened) {
    session.terminal.open(session.element)
    session.opened = true
    drawWithGpu(session.terminal)
  }
  fitSession(id)
  void wakeSession(id)
}

export function fitSession(id: string): void {
  const session = findTerminal(id)
  if (!session?.opened || !session.element.isConnected) return
  session.fit.fit()
  bridge.send('resize', id, session.terminal.cols, session.terminal.rows)
}

export function focusSession(id: string): void {
  const session = findSession(id)
  if (session?.view === 'chat') document.querySelector<HTMLElement>(`[data-session-id="${id}"] textarea`)?.focus()
  else session?.terminal.focus()
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
  // A dormant chat may still have an agent from before a reload
  if (session.view === 'chat') {
    const chat = findService('chat')
    chat?.stop(id)
    chat?.forget(id)
  } else {
    if (session.status !== 'dormant') bridge.send('kill', id)
    session.terminal.dispose()
  }
  const taskId = taskOf(state.tasks, id)?.id
  update({ sessions: state.sessions.filter((candidate) => candidate.id !== id), tasks: removeSession(state.tasks, id), zoomed: state.zoomed === id ? null : state.zoomed })
  setHistory([{ id, ...metaOf(session), taskId, endedAt: Date.now() }, ...state.history])
}

/** Closes every pane of a tab */
export function closeTab(taskId: string, tabId: string): void {
  state.tasks.find((task) => task.id === taskId)?.tabs.find((tab) => tab.id === tabId)?.layout.flat().forEach(killSession)
}

export const forgetClosedSession = (id: string): void => setHistory(state.history.filter((entry) => entry.id !== id))
/** Hides a closed chat from History */
export const archiveClosedSession = (id: string): void => setHistory(state.history.map((entry) => (entry.id === id ? { ...entry, archived: true } : entry)))
export const clearClosedSessions = (ids: string[]): void => setHistory(state.history.filter((entry) => !ids.includes(entry.id)))

/** Starts a closed session again in its folder, resuming the agent conversation, as a new tab of its task, and shows it */
export async function restoreClosedSession(entry: ClosedSession): Promise<string> {
  const { id: _closedId, endedAt: _endedAt, taskId, archived: _archived, ...closed } = entry
  const meta = openable(closed)
  let id: string
  if (meta.view === 'chat') {
    id = crypto.randomUUID()
    openChat(id, meta)
    void wakeSession(id)
  } else {
    id = await spawnSession(meta, resumeCommand(meta))
    await openSession(id, meta, '', null)
  }
  placeSession(id, taskId)
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
  // A chat takes drafts at any time
  if (findSession(id)?.view === 'chat') return Promise.resolve()
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

/** A chat gets the text as its draft, which the user sends; `submit` is for terminals */
export function sendText(id: string, text: string, submit: boolean): void {
  if (findSession(id)?.view === 'chat') {
    findService('chat')?.draft(id, text)
    return revealSession(id)
  }
  const write = (): void => {
    bridge.send('write', id, `\x1b[200~${text}\x1b[201~`)
    if (submit) setTimeout(() => bridge.send('write', id, '\r'), 150)
  }
  if (findSession(id)?.status === 'dormant') {
    // Listening before the process starts, so its first output counts
    const ready = whenReady(id)
    void wakeSession(id).then(() => ready).then(write)
  } else write()
  revealSession(id)
}

export const terminalSelection = (id: string): string => findTerminal(id)?.terminal.getSelection() ?? ''

/** xterm wraps pasted text in bracketed-paste markers when the program asked for them */
export async function pasteClipboard(id: string): Promise<void> {
  const session = findTerminal(id)
  if (session) session.terminal.paste(await navigator.clipboard.readText())
}

const shownTab = () => {
  const task = currentTask()
  return task && activeTabOf(task)
}

/** The pane holding keyboard focus, else the one last focused in the shown tab */
export function activePane(): Session | undefined {
  const focused = document.activeElement?.closest<HTMLElement>('[data-session-id]')?.dataset.sessionId
  return findSession(focused ?? '') ?? findSession(shownTab()?.focus ?? '')
}

/** Keyboard focus to the shown tab's pane, else to the start buttons of an empty task */
export function focusShown(): void {
  setTimeout(() => {
    const id = shownTab()?.focus
    const session = findSession(id ?? '')
    if (id && session && (session.view === 'chat' || session.opened)) focusSession(id)
    else document.querySelector<HTMLElement>('[data-terminal-empty] [data-zone-focus]')?.focus()
  }, 50)
}

/** Focuses the nth pane, in reading order, of the terminals holding keyboard focus */
export function focusPaneAt(position: number): void {
  const pane = document.activeElement?.closest('[data-terminal-panes]')?.querySelectorAll<HTMLElement>('[data-session-id]')[position - 1]
  if (pane?.dataset.sessionId) focusSession(pane.dataset.sessionId)
}

export const isTerminalFocused = (): boolean => document.activeElement?.closest('[data-session-id]') != null

/** New shell beside the active pane, in its folder, like iTerm's ⌘D and ⇧⌘D; with no pane, a new tab of the shown task */
export async function splitPane(edge: DropEdge, fallbackCwd: string): Promise<void> {
  const anchor = activePane()
  const task = currentTask()
  const id = await startSession(anchor?.worktreePath ?? task?.worktreePath ?? fallbackCwd, 'shell')
  if (anchor && taskOf(state.tasks, anchor.id)) setTasks(placeBeside(state.tasks, [id], anchor.id, edge))
  else placeSession(id, task?.id)
  setTimeout(() => focusSession(id))
}

/** Ends the session; it stays in the history, so an agent conversation can be resumed. Focus goes to the pane that takes its place */
export function closeActivePane(): void {
  const session = activePane()
  if (!session) return
  killSession(session.id)
  focusShown()
}

export function focusNeighbor(direction: DropEdge): void {
  const session = activePane()
  const tab = session && taskOf(state.tasks, session.id)?.tabs.find((candidate) => tabPanes(candidate).includes(session.id))
  const next = session && tab && neighborPane(tab.layout, session.id, direction)
  if (next) focusSession(next)
}

export function toggleZoom(): void {
  const session = activePane()
  if (!session) return
  update({ zoomed: state.zoomed === session.id ? null : session.id })
  setTimeout(() => focusSession(session.id))
}

export const selectAllTerminal = (id: string): void => findTerminal(id)?.terminal.selectAll()
export const clearTerminal = (id: string): void => findTerminal(id)?.terminal.clear()

/** The view a session can switch to: a chat to the terminal command its connection gives, an agent terminal with a known conversation to a chat */
export function otherView(session: Session): SessionView | null {
  const chat = findService('chat')
  if (!chat) return null
  if (session.view === 'chat') return chat.terminalCommand(session.id) ? 'terminal' : null
  return session.agentSessionId && getAgent(session.kind)?.chat ? 'chat' : null
}

/** Ends the session and opens the same conversation in the other view, in the same tab slot; only one view runs at a time */
export async function switchView(id: string): Promise<void> {
  const session = findSession(id)
  const chat = findService('chat')
  if (!session || !chat || !otherView(session)) return
  let next: string
  if (session.view === 'chat') {
    const command = chat.terminalCommand(id) ?? undefined
    const meta: SessionMeta = { ...metaOf(session), view: 'terminal' }
    // The chat keeps running if the terminal fails to start
    next = await spawnSession(meta, command)
    await openSession(next, meta, '', null)
    chat.stop(id)
  } else {
    if (session.status !== 'dormant') bridge.send('kill', id)
    session.terminal.dispose()
    next = crypto.randomUUID()
    openChat(next, { ...metaOf(session), view: 'chat' })
  }
  update({
    sessions: state.sessions.filter((candidate) => candidate.id !== id),
    tasks: remapTasks(state.tasks, (pane) => (pane === id ? next : pane)),
    zoomed: state.zoomed === id ? next : state.zoomed
  })
  void wakeSession(next)
  setTimeout(() => focusSession(next))
}
