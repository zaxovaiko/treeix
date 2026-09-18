import type { Repo } from '../../shared/types'
import { baseName, branchLabel } from './Sidebar'
import { SESSION_KINDS, type SessionKind, type SessionStatus, type SessionSummary } from '@treeix/sdk'

export const STATUS_STYLE: Record<SessionStatus, { label: string; color: string }> = {
  input: { label: 'needs input', color: '#fbbf24' },
  running: { label: 'running', color: '#34d399' },
  idle: { label: 'idle', color: '#737373' },
  exited: { label: 'exited', color: '#f87171' }
}

export function worktreeLabel(repos: Repo[] | null, worktreePath: string): string {
  if (worktreePath === window.api.home) return '~ home'
  const repo = repos?.find((candidate) => candidate.worktrees.some((worktree) => worktree.path === worktreePath))
  const worktree = repo?.worktrees.find((candidate) => candidate.path === worktreePath)
  return repo && worktree ? `${baseName(repo.path)} · ${branchLabel(worktree)}` : baseName(worktreePath)
}

export function KindBadge({ kind }: { kind: SessionKind }): React.JSX.Element {
  const { mark, color } = SESSION_KINDS[kind]
  return (
    <span style={{ color }} className="grid size-[18px] shrink-0 place-items-center rounded-[5px] bg-foreground/5 text-[11px]">
      {mark}
    </span>
  )
}

export function StatusDot({ session, withLabel = false }: { session: Pick<SessionSummary, 'status' | 'exitCode'>; withLabel?: boolean }): React.JSX.Element {
  const { label, color } = STATUS_STYLE[session.status]
  const text = session.status === 'exited' ? `exit ${session.exitCode ?? ''}` : label
  return (
    <span style={{ color }} className="flex shrink-0 items-center gap-1.5 text-[11px]" title={text}>
      <span
        style={{ background: color }}
        className={`size-1.5 rounded-full ${session.status === 'input' ? 'animate-pulse ring-2 ring-amber-400/25' : ''}`}
      />
      {withLabel && text}
    </span>
  )
}

