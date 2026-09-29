import { type FilterGroup, FilterSearch as GenericFilterSearch, type FilterToken, matchesTokens, parseTokens } from '@treeix/app/FilterSearch'
import { Icon } from '@treeix/app/Icon'
import { baseName } from '@treeix/app/Sidebar'
import type { PullRequest } from '../shared/types'
import { prefix, ProviderMark, REVIEW_MARKS, UserAvatar } from './pullRequestUtils'

type ReviewKey = keyof typeof REVIEW_MARKS

/** Someone asking for changes outranks your own state, as it blocks the merge */
const reviewOf = (pr: PullRequest): ReviewKey | null =>
  pr.review?.changesRequested ? 'changes' : pr.review && pr.review.state !== 'unreviewed' ? pr.review.state : null
const isReviewKey = (value: string): value is ReviewKey => Object.hasOwn(REVIEW_MARKS, value)

const COMMENT_BUCKETS = [
  { max: 0, label: 'No comments' },
  { max: 5, label: '1-5 comments' },
  { max: 20, label: '6-20 comments' },
  { max: Infinity, label: 'Over 20 comments' }
] as const
// Lists cached by an older version have no count, hence the ??
const commentBucket = (pr: PullRequest): string | null => {
  const count = pr.commentCount ?? null
  return count === null ? null : (COMMENT_BUCKETS.find((bucket) => count <= bucket.max)?.label ?? null)
}

export type PullRequestFilter = FilterToken

const GROUPS: FilterGroup<PullRequest>[] = [
  { kind: 'author', label: 'People', valueOf: (pr) => pr.author, mark: (value, sample) => <UserAvatar name={value} url={sample?.authorAvatarUrl ?? null} size="size-4" /> },
  {
    kind: 'repo',
    label: 'Repositories',
    valueOf: (pr) => pr.repoPath,
    labelOf: baseName,
    mark: (_value, sample) => (sample ? <ProviderMark provider={sample.provider} className="size-3.5" /> : null)
  },
  {
    kind: 'review',
    label: 'Review',
    valueOf: reviewOf,
    labelOf: (value) => (isReviewKey(value) ? REVIEW_MARKS[value].label : value),
    mark: (value) => <Icon name={(isReviewKey(value) && REVIEW_MARKS[value].icon) || 'eye'} className="size-3.5 text-muted-foreground" />
  },
  { kind: 'comments', label: 'Comments', valueOf: commentBucket, mark: () => <Icon name="comment" className="size-3.5 text-muted-foreground" /> },
  { kind: 'branch', label: 'Target branches', valueOf: (pr) => pr.targetBranch, mark: () => <Icon name="branch" className="size-3.5 text-muted-foreground" /> },
  {
    kind: 'text',
    label: 'Text',
    valueOf: () => null,
    mark: () => <Icon name="search" className="size-3 text-muted-foreground" />,
    freeText: (pr, needle) => `${prefix(pr)}${pr.number} ${pr.title} ${pr.sourceBranch} ${pr.author}`.toLowerCase().includes(needle)
  }
]

export const parseFilters = (stored: unknown): PullRequestFilter[] => parseTokens(stored, GROUPS.map((group) => group.kind))

export const matchesFilters = (pr: PullRequest, filters: PullRequestFilter[]): boolean => matchesTokens(pr, filters, GROUPS)

export function FilterSearch({
  pullRequests,
  filters,
  onChange
}: {
  pullRequests: PullRequest[]
  filters: PullRequestFilter[]
  onChange: (filters: PullRequestFilter[]) => void
}): React.JSX.Element {
  return <GenericFilterSearch items={pullRequests} groups={GROUPS} tokens={filters} onChange={onChange} placeholder="Search, or filter by person, repository, review, comments, branch" />
}
