import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import { type IPty, spawn } from 'node-pty'
import type { LiveTerminal, TerminalOptions } from '../shared/types'
import { withoutAgentVariables } from '@treeix/host/env'

// Enough for a reloaded window to redraw the screen and recent scrollback
const MAX_BUFFERED_CHARS = 256_000
/** Reported for exited sessions, which have no pty size; the renderer spawns at the same size */
const SPAWN_COLS = 100
const SPAWN_ROWS = 30

type Entry = { pty: IPty | null; owner: WebContents; meta: string; chunks: string[]; size: number; exitCode: number | null }
const sessions = new Map<string, Entry>()
const watchedOwners = new WeakSet<WebContents>()

/** Sessions outlive page reloads (the new page reattaches via listTerminals) but not their window */
function killSessionsWithWindow(owner: WebContents): void {
  if (watchedOwners.has(owner)) return
  watchedOwners.add(owner)
  owner.once('destroyed', () => {
    for (const [id, entry] of sessions) if (entry.owner === owner) killTerminal(id)
  })
}

export function createTerminal(owner: WebContents, { cwd, command, cols, rows, meta }: TerminalOptions, extraEnv: Record<string, string> = {}): string {
  const id = randomUUID()
  // Login shell so GUI launches still get the user's PATH (claude, codex, bun...)
  const pty = spawn(process.env.SHELL ?? '/bin/zsh', ['-l'], {
    name: 'xterm-256color',
    cwd,
    cols,
    rows,
    // Empty PROMPT_EOL_MARK: zsh otherwise prints an inverse % when the first fit resizes the fresh shell mid-line
    env: { ...withoutAgentVariables(process.env), ...extraEnv, TERM: 'xterm-256color', COLORTERM: 'truecolor', PROMPT_EOL_MARK: '' }
  })
  const entry: Entry = { pty, owner, meta, chunks: [], size: 0, exitCode: null }
  sessions.set(id, entry)
  killSessionsWithWindow(owner)
  pty.onData((data) => {
    // Append-only with an occasional trim: slicing a 256k string on every chunk showed up in main-process profiles
    entry.chunks.push(data)
    entry.size += data.length
    if (entry.size > MAX_BUFFERED_CHARS * 2) {
      const kept = entry.chunks.join('').slice(-MAX_BUFFERED_CHARS)
      entry.chunks = [kept]
      entry.size = kept.length
    }
    if (!entry.owner.isDestroyed()) entry.owner.send('plugin:terminal:data', id, data)
  })
  pty.onExit(({ exitCode }) => {
    entry.pty = null
    entry.exitCode = exitCode
    // Killed on purpose (ended by the user or the app quitting): don't report it, or quitting would mark every saved session as exited
    if (sessions.get(id) === entry && !entry.owner.isDestroyed()) entry.owner.send('plugin:terminal:exit', id, exitCode)
  })
  if (command) pty.write(`${command}\r`)
  return id
}

export function listTerminals(owner: WebContents): LiveTerminal[] {
  return [...sessions].map(([id, entry]) => {
    entry.owner = owner
    const { cols, rows } = entry.pty ?? { cols: SPAWN_COLS, rows: SPAWN_ROWS }
    return { id, meta: entry.meta, output: entry.chunks.join('').slice(-MAX_BUFFERED_CHARS), exitCode: entry.exitCode, cols, rows }
  })
}

export const writeTerminal = (id: string, data: string): void => sessions.get(id)?.pty?.write(data)

export function resizeTerminal(id: string, cols: number, rows: number): void {
  if (cols > 0 && rows > 0) sessions.get(id)?.pty?.resize(cols, rows)
}

export function killTerminal(id: string): void {
  const pty = sessions.get(id)?.pty
  sessions.delete(id)
  pty?.kill()
}

export function killAllTerminals(): void {
  for (const id of sessions.keys()) killTerminal(id)
}
