import type { SessionKind } from '@treeix/sdk'
import { type Agent, isChatOnly } from '@treeix/app/agents'

export { sessionFolder } from '../shared/types'

export type SessionView = 'terminal' | 'chat'

/** What survives a reload or relaunch; the process itself does not survive quitting */
export type SessionMeta = {
  worktreePath: string
  kind: SessionKind
  title: string
  startedAt: number
  /** Workspace active when the session started */
  workspaceId: string
  /** Agent conversation id: chosen at start for terminals, given by the agent for chats; a relaunch resumes exactly it */
  agentSessionId: string | null
  view: SessionView
  /** Named by the user, so the program's own titles no longer replace it */
  renamed?: boolean
}

/** Keeps the value's other fields, e.g. a saved session's id; sessions saved before chats have no view and are terminals */
export function parseMeta(value: unknown): SessionMeta | null {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as Partial<SessionMeta>
  if (typeof candidate.worktreePath !== 'string' || typeof candidate.title !== 'string' || typeof candidate.kind !== 'string') return null
  return { ...(value as SessionMeta), view: candidate.view === 'chat' ? 'chat' : 'terminal' }
}

export type ClosedSession = SessionMeta & { id: string; endedAt: number }

/** History entries archived by older versions stayed hidden, so they are dropped */
export function parseClosedSession(value: unknown): ClosedSession | null {
  const meta = parseMeta(value)
  const { id, endedAt, archived } = (meta ?? {}) as Partial<ClosedSession> & { archived?: boolean }
  return meta && typeof id === 'string' && typeof endedAt === 'number' && archived !== true ? (meta as ClosedSession) : null
}

export const NEW_CHAT_TITLE = 'New chat'

/** A chat still titled "New chat" or "New chat 2" takes its first message as its title */
export const isDefaultChatTitle = (title: string): boolean => new RegExp(`^${NEW_CHAT_TITLE}( \\d+)?$`).test(title)

/** Agents with a key of their own for a new tab */
export const NEW_TAB_ACTIONS: Record<string, string> = { shell: 'terminal.newTab', claude: 'terminal.newClaudeTab' }

export type NewTabEntry = { agent: string; view: SessionView; label: string }

/** Each agent in a terminal (chat-only ones as a chat), then one chat, with `chat` the agent it starts with; the chat picks its agent itself */
export const newTabEntries = (agents: Agent[], chat: Agent | undefined): NewTabEntry[] => [
  ...agents.map((agent): NewTabEntry => ({ agent: agent.id, view: isChatOnly(agent) ? 'chat' : 'terminal', label: agent.label })),
  ...(chat ? [{ agent: chat.id, view: 'chat' as const, label: 'Chat' }] : [])
]

/** What xterm sends on its own, not the user: focus in and out, cursor position and device reports, color replies */
export const isTerminalReply = (data: string): boolean => /^\x1b(?:\[[?>]?[\d;]*[IORcnt]|\][^\x07\x1b]*(?:\x07|\x1b\\))$/.test(data)
