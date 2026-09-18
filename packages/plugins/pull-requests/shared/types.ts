import type { FilePatch } from '@treeix/shared/types'

export type Provider = 'github' | 'gitlab'

export type PullRequestState = 'open' | 'merged' | 'closed'

export type PullRequest = {
  provider: Provider
  repoPath: string
  number: number
  title: string
  author: string
  authorAvatarUrl: string | null
  sourceBranch: string
  targetBranch: string
  state: PullRequestState
  draft: boolean
  updatedAt: string
  url: string
  additions: number | null
  deletions: number | null
  /** Null when the provider's list doesn't include it (GitLab has no file counts in its list) */
  changedFiles: number | null
  /** Conversation comments plus review threads */
  commentCount: number | null
  /** Your relation to an open GitHub PR; null when unknown (GitLab, closed, or the lookup failed) */
  review: ReviewStatus | null
  /** Open and can't merge cleanly into the target branch; false while the provider is still computing it */
  conflicts: boolean
}

/**
 * `requested`: your review is (re-)requested. `approved`/`changes`/`commented`: your latest review.
 * `newCommits` counts commits pushed after that review, which bring the PR back to your attention.
 */
export type ReviewStatus = { state: 'yours' | 'requested' | 'approved' | 'changes' | 'commented' | 'unreviewed'; newCommits: number }

export const REACTIONS = ['+1', '-1', 'laugh', 'hooray', 'confused', 'heart', 'rocket', 'eyes'] as const
export type Reaction = (typeof REACTIONS)[number]

export type ThreadComment = {
  /** `review:<id>` or `issue:<id>` on GitHub, `note:<id>` on GitLab */
  id: string
  author: string
  avatarUrl: string | null
  body: string
  createdAt: string
  reactions: Record<Reaction, number>
}

/** A reply when threadId is set, a line comment when path and line are set, otherwise a general comment */
export type PullRequestComment = {
  body: string
  threadId?: string
  path?: string
  line?: number
  side?: 'additions' | 'deletions'
}



/** A conversation thread; path is null for general discussion */
export type ReviewThread = {
  id: string
  path: string | null
  line: number | null
  side: 'additions' | 'deletions'
  comments: ThreadComment[]
  /** Null when the thread can't be resolved (general conversation, or the state lookup failed) */
  resolved: boolean | null
  /** GitHub review thread node id or GitLab discussion id, used to resolve it */
  resolveId: string | null
}

export type PullRequestDetail = {
  body: string
  patches: FilePatch[]
  threads: ReviewThread[]
  /** Paths marked viewed on GitHub; null where the provider has no API for it (GitLab keeps it in the browser) */
  viewedFiles: string[] | null
  reviewers: Reviewer[]
  /** Your login on the provider, to tell which comments you can edit; null when it couldn't be read */
  viewer: string | null
  /** Your own latest verdict; null when you haven't approved or requested changes */
  myReview: 'approved' | 'changes' | null
}

/** Someone asked to review or who reviewed; `requested` means their review is currently pending */
export type ReviewVerdict = 'approve' | 'changes'

export type MergeMethod = 'merge' | 'squash' | 'rebase'

export type Reviewer = { login: string; avatarUrl: string | null; state: 'requested' | 'approved' | 'changes' | 'commented' }

export type ImageResult = { dataUrl: string } | { error: string }

export type PullRequestList = {
  pullRequests: PullRequest[]
  errors: string[]
}
