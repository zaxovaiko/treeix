import { type FilterGroup, FilterSearch as GenericFilterSearch, type FilterToken, matchesTokens, parseTokens } from '@treeix/app/FilterSearch'
import { Icon } from '@treeix/app/Icon'
import { baseName } from '@treeix/app/Sidebar'
import type { PullRequest } from '../shared/types'
import { ProviderMark, UserAvatar } from './pullRequestUtils'

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
  { kind: 'branch', label: 'Target branches', valueOf: (pr) => pr.targetBranch, mark: () => <Icon name="branch" className="size-3.5 text-muted-foreground" /> }
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
  return <GenericFilterSearch items={pullRequests} groups={GROUPS} tokens={filters} onChange={onChange} placeholder="Filter by person, repository, branch" />
}
