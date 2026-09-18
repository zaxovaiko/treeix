import type { WorkItem } from '../shared/types'

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

/** Most urgent first; equal priorities keep the query's order */
export const byPriority = (items: WorkItem[]): WorkItem[] =>
  items.map((item, index) => ({ item, index })).sort((a, b) => priorityRank(a.item.priority) - priorityRank(b.item.priority) || a.index - b.index).map(({ item }) => item)

export const projectOf = (item: WorkItem): string => item.key.split('-')[0]
