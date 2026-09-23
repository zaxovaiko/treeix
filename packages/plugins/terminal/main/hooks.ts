import { watch } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentHookStatus } from '../shared/types'

/**
 * Claude runs hooks without a terminal, so they report by writing the status to a file named after the session, in a
 * folder every session gets in TREEIX_AGENT_STATUS; a failed write must never show as a hook error
 */
const report = (status: AgentHookStatus): { hooks: { type: 'command'; command: string }[] } => ({
  hooks: [{ type: 'command', command: `[ -n "$TREEIX_SESSION_ID" ] && printf ${status} > "$TREEIX_AGENT_STATUS/$TREEIX_SESSION_ID" 2>/dev/null; true` }]
})

/** Claude settings with hooks that report when it needs the user (a permission prompt or idle question), works again, or ends its turn */
export function withStatusHooks(settings: string): string {
  let parsed: Record<string, unknown> = {}
  try {
    const value: unknown = JSON.parse(settings)
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) parsed = value as Record<string, unknown>
  } catch {
    // Unreadable settings from a plugin still get the hooks
  }
  const working = report('working')
  const hooks = { Notification: [report('input')], UserPromptSubmit: [working], PreToolUse: [{ matcher: '*', ...working }], PostToolUse: [{ matcher: '*', ...working }], Stop: [report('done')] }
  return JSON.stringify({ ...parsed, hooks })
}

/** The usage-limits plugin's status line bridge keeps each session's last status line input here as `usage-<session id>` */
export const USAGE_PREFIX = 'usage-'

/** Claude's own running cost of the session, from its last status line input */
export async function claudeCost(folder: string, sessionId: string): Promise<number | undefined> {
  try {
    const input: unknown = JSON.parse(await readFile(join(folder, `${USAGE_PREFIX}${sessionId}`), 'utf8'))
    const cost = typeof input === 'object' && input !== null ? Reflect.get(input, 'cost') : null
    const total = typeof cost === 'object' && cost !== null ? Reflect.get(cost, 'total_cost_usd') : null
    return typeof total === 'number' ? total : undefined
  } catch {
    return undefined
  }
}

const isHookStatus = (value: string): value is AgentHookStatus => value === 'input' || value === 'working' || value === 'done'

/** Makes the folder hooks write to and calls `onStatus` for every report; the returned function removes it */
export async function watchStatuses(onStatus: (sessionId: string, status: AgentHookStatus) => void): Promise<{ folder: string; stop: () => void }> {
  const folder = await mkdtemp(join(tmpdir(), 'treeix-agent-status-'))
  const watcher = watch(folder, (_event, name) => {
    if (!name || name.startsWith(USAGE_PREFIX)) return
    void readFile(join(folder, name), 'utf8')
      .then((text) => isHookStatus(text.trim()) && onStatus(name, text.trim() as AgentHookStatus))
      .catch(() => undefined)
  })
  return {
    folder,
    stop: () => {
      watcher.close()
      void rm(folder, { recursive: true, force: true })
    }
  }
}
