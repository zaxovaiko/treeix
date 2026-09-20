import { type FilterGroup, FilterSearch as GenericFilterSearch, type FilterToken, matchesTokens, parseTokens } from '@treeix/app/FilterSearch'
import { Icon } from '@treeix/app/Icon'
import { baseName } from '@treeix/app/Sidebar'
import type { PullRequest } from '../shared/types'
import { prefix, ProviderMark, UserAvatar } from './pullRequestUtils'

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
  return <GenericFilterSearch items={pullRequests} groups={GROUPS} tokens={filters} onChange={onChange} placeholder="Search, or filter by person, repository, branch" />
}
