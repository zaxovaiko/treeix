import type { Repo } from '@treeix/shared/types'
import type { PullRequest, PullRequestState, ReviewStatus, ReviewThread } from '../shared/types'
import { Icon } from '@treeix/app/Icon'
export { timeAgo, untilLabel } from '@treeix/app/time'
export { UserAvatar } from '@treeix/app/ui'

export const pullRequestKey = (pr: PullRequest): string => `${pr.repoPath}#${pr.number}`
export const prefix = (pr: PullRequest): string => (pr.provider === 'github' ? '#' : '!')

export const STATE_STYLE: Record<PullRequestState | 'draft', { label: string; className: string }> = {
  open: { label: 'Open', className: 'bg-emerald-400/12 text-emerald-400' },
  draft: { label: 'Draft', className: 'bg-foreground/8 text-muted-foreground' },
  merged: { label: 'Merged', className: 'bg-violet-400/14 text-violet-400' },
  closed: { label: 'Closed', className: 'bg-red-400/12 text-red-400' }
}

/** GitLab links uploads relative to the project page */
const COMMENT_ANCHORS: Record<string, string> = { review: 'discussion_r', issue: 'issuecomment-', note: 'note_' }

/** Where a thread lives on the web, from its first comment's id (`review:1`, `issue:1`, `note:1`) */
export function threadUrl(pr: PullRequest, thread: ReviewThread): string {
  const [kind = '', id = ''] = thread.comments[0]?.id.split(':') ?? []
  const anchor = COMMENT_ANCHORS[kind]
  return anchor && id ? `${pr.url}#${anchor}${id}` : pr.url
}

/** A pointer to a review thread the agent opens itself; no comment bodies or code are copied */
export function threadReference(pr: PullRequest, thread: ReviewThread): string {
  const where = thread.path ? `${thread.path}${thread.line ? `:${thread.line}${thread.side === 'deletions' ? ' (old)' : ''}` : ''}` : 'conversation'
  const author = thread.comments[0] ? ` by @${thread.comments[0].author}` : ''
  return `${pr.provider === 'github' ? 'PR' : 'MR'} ${prefix(pr)}${pr.number} ${pr.url} review thread${author} on ${where}: ${threadUrl(pr, thread)}`
}

export const markdownBase = (pr: PullRequest): string | undefined => (pr.provider === 'gitlab' ? pr.url.split('/-/')[0] : undefined)

export const localWorktreeFor = (repos: Repo[] | null, pr: PullRequest): string | null =>
  repos?.find((repo) => repo.path === pr.repoPath)?.worktrees.find((worktree) => worktree.branch === pr.sourceBranch)?.path ?? null

// Brand marks from Simple Icons (CC0)
const PROVIDER_ICONS = {
  github: {
    // Follows the theme: the mark is black on light backgrounds and white on dark ones
    color: 'var(--color-foreground)',
    path: 'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12'
  },
  gitlab: {
    color: '#fc6d26',
    path: 'm23.6004 9.5927-.0337-.0862L20.3.9814a.851.851 0 0 0-.3362-.405.8748.8748 0 0 0-.9997.0539.8748.8748 0 0 0-.29.4399l-2.2055 6.748H7.5375l-2.2057-6.748a.8573.8573 0 0 0-.29-.4412.8748.8748 0 0 0-.9997-.0537.8585.8585 0 0 0-.3362.4049L.4332 9.5015l-.0325.0862a6.0657 6.0657 0 0 0 2.0119 7.0105l.0113.0087.03.0213 4.976 3.7264 2.462 1.8633 1.4995 1.1321a1.0085 1.0085 0 0 0 1.2197 0l1.4995-1.1321 2.4619-1.8633 5.006-3.7489.0125-.01a6.0682 6.0682 0 0 0 2.0094-7.003z'
  }
} as const

export function ProviderMark({ provider, className = 'size-4' }: { provider: PullRequest['provider']; className?: string }): React.JSX.Element {
  const { color, path } = PROVIDER_ICONS[provider]
  return (
    <svg viewBox="0 0 24 24" role="img" aria-label={provider === 'github' ? 'GitHub' : 'GitLab'} className={`shrink-0 ${className}`}>
      <path d={path} fill={color} />
    </svg>
  )
}

export function StateBadge({ pr }: { pr: PullRequest }): React.JSX.Element {
  const style = STATE_STYLE[pr.draft && pr.state === 'open' ? 'draft' : pr.state]
  return <span className={`shrink-0 rounded-full px-2 py-px text-[11px] font-medium ${style.className}`}>{style.label}</span>
}

/** Reviewed by you, or your own, with nothing pushed since: the list dims these so the rest stands out */
// Lists cached or sent by an older main process have no review field, hence the optional
export const reviewSettled = (review?: ReviewStatus | null): boolean =>
  !!review && review.newCommits === 0 && ['yours', 'approved', 'changes', 'commented'].includes(review.state)

/** Yours, asked of you, or reviewed by you; GitHub only, GitLab lists carry no review state */
export const involvesYou = (pr: PullRequest): boolean => !!pr.review && pr.review.state !== 'unreviewed'

export type PullRequestGroup = { id: 'ready' | 'settled' | 'drafts' | 'conflicts'; label: string; pullRequests: PullRequest[] }

/** Open pull requests you can review now come first; ones already reviewed, drafts, then conflicts, which can't merge anyway. Order inside a group is kept */
export function groupPullRequests(pullRequests: PullRequest[]): PullRequestGroup[] {
  const groups: PullRequestGroup[] = [
    { id: 'ready', label: 'Ready to review', pullRequests: [] },
    { id: 'settled', label: 'Reviewed or yours', pullRequests: [] },
    { id: 'drafts', label: 'Drafts', pullRequests: [] },
    { id: 'conflicts', label: 'Conflicts', pullRequests: [] }
  ]
  const groupOf = (pr: PullRequest): PullRequestGroup['id'] => (pr.conflicts ? 'conflicts' : pr.draft ? 'drafts' : reviewSettled(pr.review) ? 'settled' : 'ready')
  for (const pr of pullRequests) groups.find((group) => group.id === groupOf(pr))?.pullRequests.push(pr)
  return groups.filter((group) => group.pullRequests.length > 0)
}

const REVIEW_MARKS: Record<Exclude<ReviewStatus['state'], 'unreviewed'>, { label: string; className: string; icon?: 'check' | 'alert' | 'comment' }> = {
  requested: { label: 'Review requested', className: 'bg-amber-400/15 text-amber-400' },
  approved: { label: 'Approved', className: 'bg-emerald-400/12 text-emerald-400', icon: 'check' },
  changes: { label: 'Changes requested', className: 'bg-red-400/12 text-red-400', icon: 'alert' },
  commented: { label: 'Commented', className: 'bg-foreground/5 text-muted-foreground', icon: 'comment' },
  yours: { label: 'Yours', className: 'bg-foreground/5 text-muted-foreground' }
}

/** Your review state, or a new-commits pill when the author pushed after your review, plus another reviewer's request for changes */
export function ReviewMark({ review }: { review?: ReviewStatus | null }): React.JSX.Element | null {
  if (!review) return null
  // On your own PR the request replaces "Yours"; on a PR you asked changes of, yours already says it
  const othersAskChanges = !!review.changesRequested && review.state !== 'changes'
  const own = review.state === 'yours' && othersAskChanges ? null : <OwnReviewMark review={review} />
  return (
    <>
      {own}
      {othersAskChanges && <Mark state="changes" title="A reviewer asked for changes" />}
    </>
  )
}

function OwnReviewMark({ review }: { review: ReviewStatus }): React.JSX.Element | null {
  if (review.newCommits > 0) {
    return (
      <span
        title={`${review.newCommits} commit${review.newCommits === 1 ? '' : 's'} since your review`}
        className="flex shrink-0 items-center gap-1 rounded-full bg-foreground/10 px-1.5 text-[10.5px] font-medium text-foreground tabular-nums"
      >
        <span className="size-1.5 rounded-full bg-foreground" />
        {review.newCommits} new
      </span>
    )
  }
  return review.state === 'unreviewed' ? null : <Mark state={review.state} />
}

function Mark({ state, title }: { state: keyof typeof REVIEW_MARKS; title?: string }): React.JSX.Element {
  const mark = REVIEW_MARKS[state]
  return (
    <span title={title} className={`flex shrink-0 items-center gap-1 rounded px-1.5 text-[10.5px] font-medium whitespace-nowrap ${mark.className}`}>
      {mark.icon && <Icon name={mark.icon} className="size-2.5" />}
      {mark.label}
    </span>
  )
}

export function ConflictMark({ pr }: { pr: PullRequest }): React.JSX.Element | null {
  if (!pr.conflicts || pr.state !== 'open') return null
  return (
    <span
      title={`Conflicts with ${pr.targetBranch}`}
      className="flex shrink-0 items-center rounded bg-red-500/12 px-1.5 text-[10.5px] font-medium whitespace-nowrap text-red-400"
    >
      Conflicts
    </span>
  )
}

export const PULL_REQUEST_SORTS = {
  updated: 'Recently updated',
  oldest: 'Least recently updated',
  fewestFiles: 'Fewest files changed',
  fewestChanges: 'Fewest lines changed',
  mostComments: 'Most comments'
} as const
export type PullRequestSort = keyof typeof PULL_REQUEST_SORTS
export const isPullRequestSort = (value: unknown): value is PullRequestSort => typeof value === 'string' && Object.hasOwn(PULL_REQUEST_SORTS, value)

const changedLines = (pr: PullRequest): number | null => (pr.additions === null || pr.deletions === null ? null : pr.additions + pr.deletions)

/** Pull requests without the counted number (GitLab has no file or line counts) go last, most recently updated first */
export function sortPullRequests(pullRequests: PullRequest[], sort: PullRequestSort): PullRequest[] {
  const byUpdated = (a: PullRequest, b: PullRequest): number => b.updatedAt.localeCompare(a.updatedAt)
  const ascending = (value: (pr: PullRequest) => number | null, direction: 1 | -1) => (a: PullRequest, b: PullRequest): number => {
    const [first, second] = [value(a), value(b)]
    if (first === null || second === null) return first === second ? byUpdated(a, b) : first === null ? 1 : -1
    return (first - second) * direction || byUpdated(a, b)
  }
  const compare = {
    updated: byUpdated,
    oldest: (a: PullRequest, b: PullRequest) => -byUpdated(a, b),
    fewestFiles: ascending((pr) => pr.changedFiles ?? null, 1),
    fewestChanges: ascending(changedLines, 1),
    mostComments: ascending((pr) => pr.commentCount ?? null, -1)
  }[sort]
  return [...pullRequests].sort(compare)
}
