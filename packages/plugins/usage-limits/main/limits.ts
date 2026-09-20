import { type FSWatcher, mkdirSync, unwatchFile, watch, watchFile } from 'node:fs'
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AgentLimits, LimitWindow, UsageLimits } from '../shared/types'

// LimitBar's Claude Code status line bridge caches the subscription windows here
const CLAUDE_LIMITS = join(homedir(), 'Library', 'Application Support', 'LimitBar', 'claude', 'latest.json')
// The Claude desktop app samples plan usage every few minutes while it runs
const CLAUDE_DESKTOP_USAGE = join(homedir(), 'Library', 'Application Support', 'Claude', 'plan-usage-history.json')
const DESKTOP_POLL_MS = 2000
const CODEX_SESSIONS = join(homedir(), '.codex', 'sessions')
const TAIL_BYTES = 256 * 1024
const FIVE_HOURS_MIN = 300
const WEEK_MIN = 10_080

type Json = Record<string, unknown>
const isJson = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

/** A window whose reset time has passed starts over at 0% */
export function toWindow(usedPercent: number | null, resetsAtSeconds: number | null, now = Date.now()): LimitWindow | null {
  if (usedPercent === null) return null
  const resetsAt = resetsAtSeconds === null ? null : resetsAtSeconds * 1000
  const expired = resetsAt !== null && resetsAt <= now
  return { usedPercent: expired ? 0 : Math.round(usedPercent), resetsAt: expired ? null : resetsAt }
}

export function parseClaudeLimits(raw: unknown, now = Date.now()): AgentLimits | null {
  if (!isJson(raw)) return null
  const window = (value: unknown): LimitWindow | null => (isJson(value) ? toWindow(num(value.usedPercent), num(value.resetsAt), now) : null)
  const capturedAt = num(raw.capturedAt)
  return { fiveHour: window(raw.fiveHour), weekly: window(raw.weekly), updatedAt: capturedAt === null ? null : capturedAt * 1000 }
}

/** Claude Code's status line input: `rate_limits` windows with 0-100 `used_percentage` and epoch-second `resets_at` */
export function parseStatusLineLimits(raw: unknown, updatedAt: number, now = Date.now()): AgentLimits | null {
  const limits = isJson(raw) && isJson(raw.rate_limits) ? raw.rate_limits : null
  if (!limits) return null
  const window = (value: unknown): LimitWindow | null => (isJson(value) ? toWindow(num(value.used_percentage), num(value.resets_at), now) : null)
  return { fiveHour: window(limits.five_hour), weekly: window(limits.seven_day), updatedAt }
}

/** Newest sample of the Claude desktop app's usage history: `t` in ms, `u.fh`/`u.sd` percents, no reset times */
export function parseDesktopUsage(raw: unknown): AgentLimits | null {
  const samples = isJson(raw) && Array.isArray(raw.samples) ? raw.samples : []
  const latest = samples.filter(isJson).at(-1)
  const usage = latest && isJson(latest.u) ? latest.u : null
  const updatedAt = latest ? num(latest.t) : null
  if (!usage || updatedAt === null) return null
  const window = (percent: number | null): LimitWindow | null => (percent === null ? null : { usedPercent: Math.round(percent), resetsAt: null })
  return { fiveHour: window(num(usage.fh)), weekly: window(num(usage.sd)), updatedAt }
}

/** Newest reading wins; a window without a reset time borrows one from an older reading that hasn't reset yet */
export function newestLimits(candidates: (AgentLimits | null)[], now = Date.now()): AgentLimits | null {
  const sorted = candidates.filter((limits): limits is AgentLimits => limits !== null).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  const [newest] = sorted
  if (!newest) return null
  const resetFor = (key: 'fiveHour' | 'weekly', window: LimitWindow | null): LimitWindow | null => {
    if (!window || window.resetsAt !== null) return window
    const resetsAt = sorted.map((limits) => limits[key]?.resetsAt ?? null).find((time): time is number => time !== null && time > now) ?? null
    return { ...window, resetsAt }
  }
  return { ...newest, fiveHour: resetFor('fiveHour', newest.fiveHour), weekly: resetFor('weekly', newest.weekly) }
}

/** Finds the newest `rate_limits` payload in Codex rollout lines */
export function parseCodexLimits(lines: string[], now = Date.now()): AgentLimits | null {
  for (const line of [...lines].reverse()) {
    if (!line.includes('"rate_limits"')) continue
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    const payload = isJson(event) && isJson(event.payload) ? event.payload : null
    const limits = payload && isJson(payload.rate_limits) ? payload.rate_limits : null
    if (!limits) continue
    const windows = [limits.primary, limits.secondary].filter(isJson)
    const byLength = (minutes: number): LimitWindow | null => {
      const match = windows.find((candidate) => num(candidate.window_minutes) === minutes)
      return match ? toWindow(num(match.used_percent), num(match.resets_at), now) : null
    }
    const timestamp = isJson(event) && typeof event.timestamp === 'string' ? Date.parse(event.timestamp) : NaN
    return { fiveHour: byLength(FIVE_HOURS_MIN), weekly: byLength(WEEK_MIN), updatedAt: Number.isNaN(timestamp) ? null : timestamp }
  }
  return null
}

async function readJson(path: string): Promise<unknown> {
  const text = await readFile(path, 'utf8').catch(() => null)
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Treeix's status line bridge, LimitBar's cache and the Claude desktop app; whichever saw usage last */
async function readClaude(statusFile: string): Promise<AgentLimits | null> {
  const [status, modified, limitBar, desktop] = await Promise.all([readJson(statusFile), stat(statusFile).catch(() => null), readJson(CLAUDE_LIMITS), readJson(CLAUDE_DESKTOP_USAGE)])
  return newestLimits([modified ? parseStatusLineLimits(status, modified.mtimeMs) : null, parseClaudeLimits(limitBar), parseDesktopUsage(desktop)])
}

const newestNames = async (dir: string): Promise<string[]> => (await readdir(dir).catch(() => [])).sort().reverse()

/** Rollouts live in sessions/YYYY/MM/DD; only the newest day folders are read */
async function recentRollouts(limit: number): Promise<string[]> {
  const files: string[] = []
  for (const year of await newestNames(CODEX_SESSIONS)) {
    for (const month of await newestNames(join(CODEX_SESSIONS, year))) {
      for (const day of await newestNames(join(CODEX_SESSIONS, year, month))) {
        const dir = join(CODEX_SESSIONS, year, month, day)
        const names = (await readdir(dir).catch(() => [])).filter((name) => name.endsWith('.jsonl'))
        const withTimes = await Promise.all(names.map(async (name) => ({ path: join(dir, name), mtime: (await stat(join(dir, name))).mtimeMs })))
        files.push(...withTimes.sort((a, b) => b.mtime - a.mtime).map((file) => file.path))
        if (files.length >= limit) return files.slice(0, limit)
      }
    }
  }
  return files
}

/** Tails by path, reused while the file's mtime and size stay put: every Codex write triggers a read of all recent rollouts */
let tails = new Map<string, { mtimeMs: number; size: number; lines: string[] }>()

async function tailLines(path: string): Promise<string[]> {
  const { mtimeMs, size } = await stat(path)
  const cached = tails.get(path)
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.lines
  const file = await open(path)
  try {
    const start = Math.max(0, size - TAIL_BYTES)
    const { buffer, bytesRead } = await file.read(Buffer.alloc(size - start), 0, size - start, start)
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n')
    tails.set(path, { mtimeMs, size, lines })
    return lines
  } finally {
    await file.close()
  }
}

async function readCodex(): Promise<AgentLimits | null> {
  const paths = await recentRollouts(5)
  // Only the rollouts still read stay cached
  tails = new Map([...tails].filter(([path]) => paths.includes(path)))
  for (const path of paths) {
    const limits = parseCodexLimits(await tailLines(path).catch(() => []))
    if (limits) return limits
  }
  return null
}

export async function usageLimits(statusFile: string): Promise<UsageLimits> {
  const [claude, codex] = await Promise.all([readClaude(statusFile), readCodex()])
  return { claude, codex }
}

const CHANGE_DEBOUNCE_MS = 300
// A running agent writes its rollout many times a second, and each call back makes every window re-read the sources
const CHANGE_THROTTLE_MS = 5000

/** Calls back shortly after any limits source is written, at most once per throttle window, so the title bar updates without waiting for a poll */
export function watchUsageSources(statusFile: string, onChange: () => void): () => void {
  let timer: NodeJS.Timeout | null = null
  let lastCall = -Infinity
  const changed = (): void => {
    if (timer) return
    timer = setTimeout(
      () => {
        timer = null
        lastCall = Date.now()
        onChange()
      },
      Math.max(CHANGE_DEBOUNCE_MS, lastCall + CHANGE_THROTTLE_MS - Date.now())
    )
  }
  // Folders, not files: the bridges replace their file by renaming, which would orphan a file watch
  const targets: [string, boolean][] = [
    [dirname(statusFile), false],
    [dirname(CLAUDE_LIMITS), false],
    [CODEX_SESSIONS, true]
  ]
  mkdirSync(dirname(statusFile), { recursive: true })
  const watchers = targets.flatMap(([path, recursive]): FSWatcher[] => {
    try {
      return [watch(path, { recursive, persistent: false }, changed).on('error', () => undefined)]
    } catch {
      return []
    }
  })
  // Its folder churns with browser storage writes, so this one file is polled instead
  watchFile(CLAUDE_DESKTOP_USAGE, { interval: DESKTOP_POLL_MS, persistent: false }, changed)
  return () => {
    if (timer) clearTimeout(timer)
    watchers.forEach((watcher) => watcher.close())
    unwatchFile(CLAUDE_DESKTOP_USAGE, changed)
  }
}
