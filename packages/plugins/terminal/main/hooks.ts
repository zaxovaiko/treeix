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

/** Claude settings with hooks that report when it needs the user (a permission prompt or idle question) and when it works again */
export function withStatusHooks(settings: string): string {
  let parsed: Record<string, unknown> = {}
  try {
    const value: unknown = JSON.parse(settings)
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) parsed = value as Record<string, unknown>
  } catch {
    // Unreadable settings from a plugin still get the hooks
  }
  const working = report('working')
  const hooks = { Notification: [report('input')], UserPromptSubmit: [working], PreToolUse: [{ matcher: '*', ...working }], PostToolUse: [{ matcher: '*', ...working }], Stop: [working] }
  return JSON.stringify({ ...parsed, hooks })
}

const isHookStatus = (value: string): value is AgentHookStatus => value === 'input' || value === 'working'

/** Makes the folder hooks write to and calls `onStatus` for every report; the returned function removes it */
export async function watchStatuses(onStatus: (sessionId: string, status: AgentHookStatus) => void): Promise<{ folder: string; stop: () => void }> {
  const folder = await mkdtemp(join(tmpdir(), 'treeix-agent-status-'))
  const watcher = watch(folder, (_event, name) => {
    if (!name) return
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
