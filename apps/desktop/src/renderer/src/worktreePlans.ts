import type { SessionKind } from '@treeix/sdk'
import type { Branch, Repo, Worktree } from '../../shared/types'

/** One worktree per agent; alone an agent keeps the branch name as typed */
export const raceBranches = (name: string, sessions: SessionKind[]): { branch: string; session: SessionKind | null }[] =>
  sessions.length <= 1 ? [{ branch: name, session: sessions[0] ?? null }] : sessions.map((session) => ({ branch: `${name}-${session}`, session }))

const STALE_DAYS = 30
/** A branch with no commits of its own also counts as merged, so a fresh one is only offered checked after a week */
const MERGED_QUIET_DAYS = 7

/** `suggested`: starts checked */
export type CleanupCandidate = { repo: Repo; worktree: Worktree; reason: string; suggested: boolean }

/** Worktrees other than the main one whose branch was merged, lost its upstream, or saw no commit for a month */
export function cleanupCandidates(repos: Repo[], branches: Map<string, Branch[]>, nowSeconds: number): CleanupCandidate[] {
  return repos.flatMap((repo) =>
    repo.worktrees.flatMap((worktree): CleanupCandidate[] => {
      if (worktree.path === repo.path || !worktree.branch) return []
      const branch = branches.get(repo.path)?.find((candidate) => !candidate.remote && candidate.name === worktree.branch)
      if (!branch) return []
      const idleDays = Math.floor((nowSeconds - branch.committedAt) / 86_400)
      const reason = branch.merged ? 'merged' : branch.gone ? 'upstream gone' : idleDays >= STALE_DAYS ? `no commits for ${idleDays} days` : null
      const suggested = worktree.changedFiles === 0 && (!branch.merged || branch.gone || idleDays >= MERGED_QUIET_DAYS)
      return reason ? [{ repo, worktree, reason, suggested }] : []
    })
  )
}
