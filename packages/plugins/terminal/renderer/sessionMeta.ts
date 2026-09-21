import type { SessionKind } from '@treeix/sdk'
import { type Agent, viewFor } from '@treeix/app/agents'

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
  /** Hidden from History */
  archived?: boolean
}

/** Keeps the value's other fields, e.g. a saved session's id; sessions saved before chats have no view and are terminals */
export function parseMeta(value: unknown): SessionMeta | null {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as Partial<SessionMeta>
  if (typeof candidate.worktreePath !== 'string' || typeof candidate.title !== 'string' || typeof candidate.kind !== 'string') return null
  return { ...(value as SessionMeta), view: candidate.view === 'chat' ? 'chat' : 'terminal' }
}

export const NEW_CHAT_TITLE = 'New chat'

/** A chat still titled "New chat" or "New chat 2" takes its first message as its title */
export const isDefaultChatTitle = (title: string): boolean => new RegExp(`^${NEW_CHAT_TITLE}( \\d+)?$`).test(title)

export const unarchived = <T extends { archived?: boolean }>(entries: T[]): T[] => entries.filter((entry) => !entry.archived)

export type NewTabEntry = { agent: string; view: SessionView; label: string; secondary: boolean }

/** Each agent in its default view, then its other view when it has a chat command */
export const newTabEntries = (agents: Agent[], views: Record<string, SessionView>): NewTabEntry[] =>
  agents.flatMap((agent) => {
    const view = viewFor(agent, views)
    const main: NewTabEntry = { agent: agent.id, view, label: agent.label, secondary: false }
    if (!agent.chat) return [main]
    const other: NewTabEntry = view === 'chat' ? { agent: agent.id, view: 'terminal', label: `${agent.label} in terminal`, secondary: true } : { agent: agent.id, view: 'chat', label: `${agent.label} chat`, secondary: true }
    return [main, other]
  })
