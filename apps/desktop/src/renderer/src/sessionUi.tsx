import type { Repo } from '../../shared/types'
import { baseName, branchLabel } from './Sidebar'
import { agentOr, isAgent } from './agents'
import { type Activity, agentActivity } from './activity'
import type { SessionKind, SessionStatus, SessionSummary } from '@treeix/sdk'

const STATUS_STYLE: Record<SessionStatus, { label: string; color: string }> = {
  input: { label: 'needs you', color: '#fbbf24' },
  running: { label: 'working', color: '#34d399' },
  done: { label: 'finished, not seen yet', color: '#60a5fa' },
  idle: { label: 'idle', color: '#737373' },
  exited: { label: 'exited', color: '#f87171' },
  dormant: { label: 'not started', color: '#737373' }
}

export function worktreeLabel(repos: Repo[] | null, worktreePath: string): string {
  if (worktreePath === window.api.home) return '~ home'
  const repo = repos?.find((candidate) => candidate.worktrees.some((worktree) => worktree.path === worktreePath))
  const worktree = repo?.worktrees.find((candidate) => candidate.path === worktreePath)
  return repo && worktree ? `${baseName(repo.path)} · ${branchLabel(worktree)}` : baseName(worktreePath)
}

export function KindBadge({ kind }: { kind: SessionKind }): React.JSX.Element {
  const { mark, color } = agentOr(kind)
  return (
    <span style={{ color }} className="grid size-[18px] shrink-0 place-items-center rounded-[5px] bg-foreground/5 text-[11px]">
      {mark}
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
