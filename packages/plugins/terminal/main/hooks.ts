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

/** Tools that wait for the user, a question or a plan to approve, report input; the rest report work. The tool's JSON comes on stdin */
const toolReport = {
  hooks: [
    {
      type: 'command',
      command: `[ -n "$TREEIX_SESSION_ID" ] && { if grep -Eq '"tool_name": ?"(AskUserQuestion|ExitPlanMode)"'; then printf input; else printf working; fi > "$TREEIX_AGENT_STATUS/$TREEIX_SESSION_ID"; } 2>/dev/null; true`
    }
  ]
}

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
  const hooks = {
    // Not idle_prompt: Claude's reminder a minute after its turn ended is no question
    Notification: [{ matcher: 'permission_prompt|elicitation_dialog', ...report('input') }],
    UserPromptSubmit: [working],
    PreToolUse: [{ matcher: '*', ...toolReport }],
    PostToolUse: [{ matcher: '*', ...working }],
    Stop: [report('done')]
  }
  return JSON.stringify({ ...parsed, hooks })
}

/** The usage-limits plugin's status line bridge keeps each session's last status line input here as `usage-<session id>` */
const USAGE_PREFIX = 'usage-'

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

/** The conversation Claude writes to now: `/clear`, a resume or a plan's fresh start each begin a new one in the same terminal */
export function statusLineConversation(text: string): string | null {
  try {
    const input: unknown = JSON.parse(text)
    const id = typeof input === 'object' && input !== null ? Reflect.get(input, 'session_id') : null
    return typeof id === 'string' && id ? id : null
  } catch {
    return null
  }
}

const isHookStatus = (value: string): value is AgentHookStatus => value === 'input' || value === 'working' || value === 'done'

/** Makes the folder hooks write to and calls `onStatus` for every report and `onConversation` for every status line; the returned function removes it */
export async function watchStatuses(
  onStatus: (sessionId: string, status: AgentHookStatus) => void,
  onConversation: (sessionId: string, conversation: string) => void
): Promise<{ folder: string; stop: () => void }> {
  const folder = await mkdtemp(join(tmpdir(), 'treeix-agent-status-'))
  const watcher = watch(folder, (_event, name) => {
    if (!name) return
    void readFile(join(folder, name), 'utf8')
      .then((text) => {
        if (!name.startsWith(USAGE_PREFIX)) return isHookStatus(text.trim()) && onStatus(name, text.trim() as AgentHookStatus)
        const conversation = statusLineConversation(text)
        if (conversation) onConversation(name.slice(USAGE_PREFIX.length), conversation)
      })
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
