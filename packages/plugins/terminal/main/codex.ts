import { createReadStream } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

export type CodexConversation = { id: string; cwd: string; startedAt: number }

/** The session_meta line Codex writes first in each rollout file */
export function parseRolloutHead(head: string): CodexConversation | null {
  try {
    const line: unknown = JSON.parse(head.split('\n')[0])
    const payload = typeof line === 'object' && line !== null ? Reflect.get(line, 'payload') : null
    if (typeof payload !== 'object' || payload === null) return null
    const { id, cwd, timestamp } = payload as Record<string, unknown>
    const startedAt = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN
    return typeof id === 'string' && typeof cwd === 'string' && !Number.isNaN(startedAt) ? { id, cwd, startedAt } : null
  } catch {
    return null
  }
}

/** Rollout files can be megabytes; the first line, long with Codex's instructions, is all that's needed */
async function readHead(path: string): Promise<string> {
  const input = createReadStream(path, { encoding: 'utf8' })
  const lines = createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of lines) return line
    return ''
  } finally {
    lines.close()
    input.destroy()
  }
}

const pad = (value: number): string => String(value).padStart(2, '0')

/** Codex conversations started in `cwd` since `since`, oldest first; Codex keeps them under ~/.codex/sessions/YYYY/MM/DD */
export async function codexConversations(cwd: string, since: number): Promise<CodexConversation[]> {
  const days = new Set<string>()
  // A day either side covers the UTC dates in the folder names and a session started just before midnight
  for (let time = since - 86_400_000; time <= Date.now() + 86_400_000; time += 86_400_000) {
    const day = new Date(time)
    days.add(join(homedir(), '.codex', 'sessions', String(day.getFullYear()), pad(day.getMonth() + 1), pad(day.getDate())))
  }
  const found: CodexConversation[] = []
  for (const folder of days) {
    const names = await readdir(folder).catch(() => [])
    for (const name of names.filter((entry) => entry.startsWith('rollout-') && entry.endsWith('.jsonl'))) {
      const conversation = parseRolloutHead(await readHead(join(folder, name)).catch(() => ''))
      if (conversation && conversation.cwd === cwd && conversation.startedAt >= since) found.push(conversation)
    }
  }
  return found.sort((a, b) => a.startedAt - b.startedAt)
}
