import type { Epic, WorkItem } from '../shared/types'

/** Grouped by whose move it is, not by Jira's status category */
export const BUCKETS = {
  mine: 'My move',
  next: 'Up next',
  waiting: 'Waiting on others',
  blocked: 'Blocked',
  later: 'Later',
  done: 'Done'
} as const
export type Bucket = keyof typeof BUCKETS
export const isBucket = (value: unknown): value is Bucket => typeof value === 'string' && Object.hasOwn(BUCKETS, value)

// ponytail: status names guessed by keyword; per-status overrides cover custom workflows
// QA Blocked means QA found a problem to fix; plain Blocked waits on something outside the team's flow
const BACK_TO_ME = /qa.?blocked|reopen|changes|fix|rejected|failed/i
const BLOCKED = /block|on hold|impediment/i
const WITH_OTHERS = /review|test|qa|merge|deploy|stage|verif|approv|release/i

export function bucketOf(item: WorkItem, inSprint: boolean | null, overrides: Record<string, Bucket>): Bucket {
  const override = overrides[item.status]
  if (override) return override
  if (item.statusCategory === 'done') return 'done'
  if (BACK_TO_ME.test(item.status)) return 'mine'
  if (BLOCKED.test(item.status)) return 'blocked'
  if (WITH_OTHERS.test(item.status)) return 'waiting'
  if (item.statusCategory === 'indeterminate') return 'mine'
  if (/backlog/i.test(item.status) || inSprint === false) return 'later'
  return 'next'
}

const PRIORITY_RANK: [RegExp, number][] = [
  [/highest|blocker|critical|urgent/i, 0],
  [/high|major/i, 1],
  [/lowest|trivial/i, 4],
  [/low|minor/i, 3]
]
const priorityRank = (priority: string | null): number => PRIORITY_RANK.find(([pattern]) => priority && pattern.test(priority))?.[1] ?? 2

export const SORTS = { status: 'Status', priority: 'Priority', updated: 'Updated', created: 'Created' } as const
export type ItemSort = keyof typeof SORTS
export const isItemSort = (value: unknown): value is ItemSort => typeof value === 'string' && Object.hasOwn(SORTS, value)

const IN_PROGRESS = /progress|doing|develop/i
/** Work under way first, then started items that came back or stalled, then not started */
const statusRank = (item: WorkItem): number => {
  if (item.statusCategory === 'indeterminate') return IN_PROGRESS.test(item.status) && !BACK_TO_ME.test(item.status) ? 0 : 1
  return item.statusCategory === 'new' ? 2 : 3
}

/** Updated and created come from the query's ORDER BY, so they keep the order Jira returned */
export function sortItems(items: WorkItem[], sort: ItemSort): WorkItem[] {
  const rank = (item: WorkItem): number =>
    sort === 'status' ? statusRank(item) * 10 + priorityRank(item.priority) : sort === 'priority' ? priorityRank(item.priority) : 0
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => rank(a.item) - rank(b.item) || a.index - b.index)
    .map(({ item }) => item)
}

/** Most urgent first; equal priorities keep the query's order */
export const byPriority = (items: WorkItem[]): WorkItem[] => sortItems(items, 'priority')

export const projectOf = (item: WorkItem): string => item.key.split('-')[0]

export type EpicGroup = { epic: Epic | null; items: WorkItem[] }

/** Which open epic each item sits under */
export function epicIndex(epics: Epic[]): Map<string, Epic> {
  const index = new Map<string, Epic>()
  for (const epic of epics) for (const child of epic.children) index.set(child.key, epic)
  return index
}

/**
 * Items under their epic, epics with the most to do first, then items with no open epic. Epics themselves
 * head their group instead of sitting in it. Order inside a group is kept.
 */
export function groupByEpic(items: WorkItem[], epics: Epic[]): EpicGroup[] {
  const index = epicIndex(epics)
  const epicKeys = new Set(epics.map((epic) => epic.key))
  const groups = new Map<string, EpicGroup>()
  const loose: WorkItem[] = []
  for (const item of items) {
    if (epicKeys.has(item.key)) continue
    const epic = index.get(item.key)
    if (!epic) {
      loose.push(item)
      continue
    }
    const group = groups.get(epic.key) ?? { epic, items: [] }
    group.items.push(item)
    groups.set(epic.key, group)
  }
  const sorted = [...groups.values()].sort((a, b) => b.items.length - a.items.length)
  return loose.length ? [...sorted, { epic: null, items: loose }] : sorted
}
