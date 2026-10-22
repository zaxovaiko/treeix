import type { Repo } from '../../shared/types'
import { baseName, branchLabel } from './Sidebar'
import { type Agent, agentOr, isAgent, logoOf, useAgents } from './agents'
import { type Activity, agentActivity } from './activity'
import type { SessionKind, SessionStatus, SessionSummary } from '@treeix/sdk'

const STATUS_STYLE: Record<SessionStatus, { label: string; color: string }> = {
  input: { label: 'needs you', color: '#fbbf24' },
  running: { label: 'working', color: '#34d399' },
  watching: { label: 'watching what it left running', color: '#2dd4bf' },
  done: { label: 'finished, not seen yet', color: '#60a5fa' },
  idle: { label: 'idle', color: '#737373' },
  exited: { label: 'exited', color: '#f87171' },
  dormant: { label: 'not started', color: '#737373' }
}

/** Drag data of a session row, dropped on a terminal pane to open it beside that pane */
export const SESSION_MIME = 'application/x-treeix-session'

/** The project a folder belongs to: a worktree the app adds sits in its repository's .claude/worktrees */
export const projectOf = (worktreePath: string): string => worktreePath.replace(/[/\\]\.claude[/\\]worktrees[/\\][^/\\]+$/, '')

export function worktreeLabel(repos: Repo[] | null, worktreePath: string): string {
  if (worktreePath === window.api.home) return '~ home'
  const repo = repos?.find((candidate) => candidate.worktrees.some((worktree) => worktree.path === worktreePath))
  const worktree = repo?.worktrees.find((candidate) => candidate.path === worktreePath)
  return repo && worktree ? `${baseName(repo.path)} · ${branchLabel(worktree)}` : baseName(worktreePath)
}

/** An agent's mark in its colour: Claude's and Codex's logos, any other agent's glyph */
export function AgentGlyph({ agent, className = 'size-3' }: { agent: Agent; className?: string }): React.JSX.Element {
  const logo = logoOf(agent)
  if (!logo) return <span style={{ color: agent.color }}>{agent.mark}</span>
  return (
    <svg viewBox="0 0 24 24" aria-hidden style={{ color: agent.color }} className={`shrink-0 ${className}`}>
      <path d={logo} fill="currentColor" fillRule="evenodd" />
    </svg>
  )
}

export function KindBadge({ kind }: { kind: SessionKind }): React.JSX.Element {
  'use no memo' // agent mark is read from the agents list during render
  useAgents()
  const agent = agentOr(kind)
  return (
    <span
      className={`grid size-[18px] shrink-0 place-items-center overflow-hidden rounded-[5px] bg-foreground/5 whitespace-nowrap ${[...agent.mark].length > 1 ? 'text-[8px] tracking-tight' : 'text-[11px]'}`}
    >
      <AgentGlyph agent={agent} />
    </span>
  )
}

export function StatusDot({ session, withLabel = false }: { session: Pick<SessionSummary, 'status' | 'exitCode'>; withLabel?: boolean }): React.JSX.Element {
  const { label, color } = STATUS_STYLE[session.status]
  // Chats have no exit code; theirs is a lost connection
  const text = session.status !== 'exited' ? label : session.exitCode === null ? 'disconnected' : `exit ${session.exitCode}`
  return (
    <span style={{ color }} className="flex shrink-0 items-center gap-1.5 text-[11px]" title={text}>
      {session.status === 'running' ? (
        <span style={{ borderColor: color }} className="size-2 animate-spin rounded-full border-[1.5px] border-t-transparent!" />
      ) : (
        <span style={{ background: color }} className={`size-1.5 rounded-full ${session.status === 'input' ? 'ring-2 ring-amber-400/25' : ''}`} />
      )}
      {withLabel && text}
    </span>
  )
}

/** Agent sessions only: a shell printing output is no news */
export const activityOf = (sessions: Pick<SessionSummary, 'kind' | 'status'>[]): Activity =>
  agentActivity(sessions.filter((session) => isAgent(session.kind)).map((session) => session.status))
