import type { FitAddon } from '@xterm/addon-fit'
import type { Terminal } from '@xterm/xterm'
import { useSyncExternalStore } from 'react'
import { activeTheme, digitPressed, fontStack, getSettings, MONO_STACK, subscribeSettings } from '@treeix/app/settings'
import { agentOr, getAgent, isAgent, resumeCommandFor, startCommand } from '@treeix/app/agents'
import { terminalTitle } from './terminalTitle'
import { findFileLinks, findWebLinks } from './fileLinks'
import { THEMES } from '@treeix/app/themes'
import { type DropEdge, neighborPane, type PaneLayout, remapPanes } from './paneLayout'
import { activeTabOf, addTab, newTask, parseTasks, placeBeside, remapTasks, removeSession, shownPanes, type Task, taskOf, taskPanes, tasksFromSessions, tabPanes } from './tasks'
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
  const { terminalFontSize, terminalFont, terminalScrollback } = getSettings()
  const fontFamily = fontStack(terminalFont, MONO_STACK)
  for (const session of state.sessions) {
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

let state: State = { sessions: [], tasks: [], selected: {}, zoomed: null, history: loadHistory() }
const listeners = new Set<() => void>()
/** Output of sessions not opened yet; sessions that never open (killed, another window's) must not grow it forever */
const pendingOutput = new Map<string, string>()
const PENDING_SESSIONS = 20
const PENDING_CHARS = 256_000

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
  if (session.status === 'exited' || session.status === 'dormant') return session.status
  if (isAgent(session.kind) && WAITING_FOR_INPUT.test(screen)) return 'input'
  return Date.now() - session.lastOutput < ACTIVE_WINDOW_MS ? 'running' : 'idle'
}

setInterval(() => {
  // Statuses only show on screen; a hidden window catches up within a second of showing
  if (document.hidden) return
  const next = state.sessions.map((session) => {
    const screen = session.opened ? visibleScreen(session.terminal) : ''
    return { session, status: detectStatus(session, screen), planName: printedPlan(screen, session.planName) }
  })
  const changed = next.some(({ session, status, planName }) => status !== session.status || planName !== session.planName)
  if (changed) update({ sessions: next.map(({ session, status, planName }) => ({ ...session, status, planName })) })
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
  const session: Session = { ...meta, id, status, exitCode, lastOutput: Date.now(), terminal, fit, element, opened: false, planName: null }
  update({ sessions: [...state.sessions, session] })
  terminal.write(output + (pendingOutput.get(id) ?? ''), () => (replaying = false))
  pendingOutput.delete(id)
}

const spawnSession = (meta: SessionMeta, command: string | undefined, id?: string, size = SPAWN_SIZE): Promise<string> =>
  bridge.invoke<string>('create', { cwd: meta.worktreePath, command, ...size, meta: JSON.stringify(meta), id })

const metaOf = ({ worktreePath, kind, title, startedAt, workspaceId, agentSessionId }: SessionMeta): SessionMeta => ({ worktreePath, kind, title, startedAt, workspaceId, agentSessionId })

/** Starts a session without showing it anywhere yet */
async function startSession(worktreePath: string, kind: SessionKind, promptArgument?: string): Promise<string> {
  const sameKind = state.sessions.filter((session) => session.worktreePath === worktreePath && session.kind === kind)
  const agent = agentOr(kind)
  const agentSessionId = agent.sessionIdFlag ? crypto.randomUUID() : null
  const meta: SessionMeta = {
    worktreePath,
    kind,
    title: `${agent.label}${sameKind.length ? ` ${sameKind.length + 1}` : ''}`,
    startedAt: Date.now(),
    workspaceId: getCurrentWorkspaceId(),
    agentSessionId
  }
  const id = await spawnSession(meta, startCommand(agent, promptArgument, agentSessionId))
  await openSession(id, meta, '', null)
  return id
}

/** `promptArgument` is an already shell-quoted first prompt for agent sessions; the session opens as a new tab of `taskId`, or of the task for its folder */
export async function createSession(worktreePath: string, kind: SessionKind, promptArgument?: string, taskId?: string): Promise<string> {
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

function isSessionMeta(value: unknown): value is SessionMeta {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<SessionMeta>
  return typeof candidate.worktreePath === 'string' && typeof candidate.title === 'string' && typeof candidate.kind === 'string'
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

const waking = new Map<string, Promise<void>>()

/** Starts a dormant session's process under its own id, resuming its agent conversation; resolves once the process runs */
function wakeSession(id: string): Promise<void> {
  const session = findSession(id)
  if (session?.status !== 'dormant') return Promise.resolve()
  const pending = waking.get(id)
  if (pending) return pending
  const started = spawnSession(metaOf(session), resumeCommand(session), id, { cols: session.terminal.cols, rows: session.terminal.rows })
    .then(() => {
      // Closed while starting: killSession had no process to end yet
      if (!findSession(id)) return bridge.send('kill', id)
      update({ sessions: state.sessions.map((candidate) => (candidate.id === id ? { ...candidate, status: 'running' } : candidate)) })
      fitSession(id)
    })
    .finally(() => waking.delete(id))
  waking.set(id, started)
  return started
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
    const meta = parseMeta(terminal.meta)
    if (meta) await openSession(terminal.id, meta, terminal.output, terminal.exitCode, { cols: terminal.cols, rows: terminal.rows })
  }
  const eager = live.length === 0 && savedTasks ? shownPanes(savedTasks.tasks, savedTasks.selected, getCurrentWorkspaceId()) : []
  for (const { id, ...meta } of saved.sessions) {
    if (findSession(id)) continue
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
  const sessions = state.sessions.filter((session) => session.status !== 'exited').map((session) => ({ id: session.id, ...metaOf(session) }))
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
  void wakeSession(id)
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
  if (session.status !== 'dormant') bridge.send('kill', id)
  session.terminal.dispose()
  const taskId = taskOf(state.tasks, id)?.id
  update({ sessions: state.sessions.filter((candidate) => candidate.id !== id), tasks: removeSession(state.tasks, id), zoomed: state.zoomed === id ? null : state.zoomed })
  setHistory([{ id, ...metaOf(session), taskId, endedAt: Date.now() }, ...state.history])
}

/** Closes every pane of a tab */
export function closeTab(taskId: string, tabId: string): void {
  state.tasks.find((task) => task.id === taskId)?.tabs.find((tab) => tab.id === tabId)?.layout.flat().forEach(killSession)
}

export const forgetClosedSession = (id: string): void => setHistory(state.history.filter((entry) => entry.id !== id))
export const clearClosedSessions = (ids: string[]): void => setHistory(state.history.filter((entry) => !ids.includes(entry.id)))

/** Starts a closed session again in its folder, resuming the agent conversation, as a new tab of its task, and shows it */
export async function restoreClosedSession(entry: ClosedSession): Promise<string> {
  const { id: _closedId, endedAt: _endedAt, taskId, ...meta } = entry
  const id = await spawnSession(meta, resumeCommand(meta))
  await openSession(id, meta, '', null)
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

export const terminalSelection = (id: string): string => findSession(id)?.terminal.getSelection() ?? ''

/** xterm wraps pasted text in bracketed-paste markers when the program asked for them */
export async function pasteClipboard(id: string): Promise<void> {
  findSession(id)?.terminal.paste(await navigator.clipboard.readText())
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
    if (id && findSession(id)?.opened) focusSession(id)
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

export const selectAllTerminal = (id: string): void => findSession(id)?.terminal.selectAll()
export const clearTerminal = (id: string): void => findSession(id)?.terminal.clear()
