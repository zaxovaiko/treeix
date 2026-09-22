import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import { type IPty, spawn } from 'node-pty'
import type { LiveTerminal, TerminalOptions } from '../shared/types'
import { withoutAgentVariables } from '@treeix/host/env'
import { coalesceOutput } from './coalesce'
import { attributePorts, parseCwds, parseListeners, parseParents, type SessionPortEntry } from './ports'

// Enough for a reloaded window to redraw the screen and recent scrollback
const MAX_BUFFERED_CHARS = 256_000
/** Reported for exited sessions, which have no pty size; the renderer spawns at the same size */
const SPAWN_COLS = 100
const SPAWN_ROWS = 30

type Entry = { pty: IPty | null; owner: WebContents; meta: string; chunks: string[]; size: number; exitCode: number | null }
const sessions = new Map<string, Entry>()
const watchedOwners = new WeakSet<WebContents>()
const output = coalesceOutput((id, data) => {
  const owner = sessions.get(id)?.owner
  if (owner && !owner.isDestroyed()) owner.send('plugin:terminal:data', id, data)
})

/** Sessions outlive page reloads (the new page reattaches via listTerminals) but not their window */
function killSessionsWithWindow(owner: WebContents): void {
  if (watchedOwners.has(owner)) return
  watchedOwners.add(owner)
  owner.once('destroyed', () => {
    for (const [id, entry] of sessions) if (entry.owner === owner) killTerminal(id)
  })
}

export function createTerminal(owner: WebContents, { cwd, command, cols, rows, meta, id: requested }: TerminalOptions, extraEnv: Record<string, string> = {}): string {
  const id = requested && !sessions.has(requested) ? requested : randomUUID()
  // Login shell so GUI launches still get the user's PATH (claude, codex, bun...)
  const pty = spawn(process.env.SHELL ?? '/bin/zsh', ['-l'], {
    name: 'xterm-256color',
    cwd,
    cols,
    rows,
    // Empty PROMPT_EOL_MARK: zsh otherwise prints an inverse % when the first fit resizes the fresh shell mid-line
    env: {
      ...withoutAgentVariables(process.env),
      ...extraEnv,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      // Apps opened from Finder get no locale, and without one shells mangle non-ASCII input
      LANG: process.env.LANG || 'en_US.UTF-8',
      PROMPT_EOL_MARK: ''
    }
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
    output.push(id, data)
  })
  pty.onExit(({ exitCode }) => {
    entry.pty = null
    entry.exitCode = exitCode
    output.flush(id)
    // Killed on purpose (ended by the user or the app quitting): don't report it, or quitting would mark every saved session as exited
    if (sessions.get(id) === entry && !entry.owner.isDestroyed()) entry.owner.send('plugin:terminal:exit', id, exitCode)
  })
  if (command) pty.write(`${command}\r`)
  return id
}

export function listTerminals(owner: WebContents): LiveTerminal[] {
  return [...sessions].map(([id, entry]) => {
    entry.owner = owner
    // The scrollback below already has it
    output.drop(id)
    const { cols, rows } = entry.pty ?? { cols: SPAWN_COLS, rows: SPAWN_ROWS }
    return { id, meta: entry.meta, output: entry.chunks.join('').slice(-MAX_BUFFERED_CHARS), exitCode: entry.exitCode, cols, rows }
  })
}

/** Where the session's shell is now, after any cd; null once it exited */
export function terminalCwd(id: string): Promise<string | null> {
  const pid = sessions.get(id)?.pty?.pid
  if (!pid) return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], (error, stdout) => {
      resolve(error ? null : (stdout.split('\n').find((line) => line.startsWith('n'))?.slice(1) ?? null))
    })
  })
}

/** stdout even when the command exits non-zero with output: lsof does when some files can't be read */
const run = (file: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => execFile(file, args, (error, stdout) => (error && !stdout ? reject(error) : resolve(stdout))))

/** TCP ports listened on by a live session's shell or anything it started, with the folder the listening process runs in */
export async function listeningPorts(): Promise<(SessionPortEntry & { cwd: string | null })[]> {
  const shells = new Map<string, number>()
  for (const [id, entry] of sessions) if (entry.pty) shells.set(id, entry.pty.pid)
  if (!shells.size) return []
  try {
    const [ps, lsof] = await Promise.all([run('/bin/ps', ['-A', '-o', 'pid=,ppid=']), run('/usr/sbin/lsof', ['-w', '-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'])])
    const found = attributePorts(shells, parseParents(ps), parseListeners(lsof))
    if (!found.length) return []
    const pids = [...new Set(found.map((entry) => entry.pid))].join(',')
    const cwds = parseCwds(await run('/usr/sbin/lsof', ['-w', '-a', '-p', pids, '-d', 'cwd', '-Fpn']).catch(() => ''))
    return found.map((entry) => ({ ...entry, cwd: cwds.get(entry.pid) ?? null }))
  } catch {
    // lsof exits 1 when nothing listens
    return []
  }
}

export const writeTerminal = (id: string, data: string): void => sessions.get(id)?.pty?.write(data)

export function resizeTerminal(id: string, cols: number, rows: number): void {
  if (cols > 0 && rows > 0) sessions.get(id)?.pty?.resize(cols, rows)
}

export function killTerminal(id: string): void {
  const pty = sessions.get(id)?.pty
  sessions.delete(id)
  output.drop(id)
  pty?.kill()
}

export function killAllTerminals(): void {
  for (const id of sessions.keys()) killTerminal(id)
}
