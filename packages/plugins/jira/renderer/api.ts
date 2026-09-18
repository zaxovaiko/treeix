import { atlassianBridge } from '@treeix/atlassian/renderer/atlassianBridge'
import { persistentCache } from '@treeix/atlassian/renderer/cache'
import { definePluginSettings } from '@treeix/sdk'
import { type Bucket, isBucket } from './buckets'
import type { WorkItem, WorkItemDetail, WorkItemList } from '../shared/types'

export const jiraBridge = atlassianBridge('jira')
export const resolveImage = jiraBridge.resolveImage

export const jiraApi = {
  // acli failures come back as an error field; throwing keeps them out of the cache
  search: (jql: string) =>
    jiraBridge.invoke<WorkItemList>('search', jql).then((list) => {
      if (list.error) throw new Error(list.error)
      return list
    }),
  detail: (key: string) => jiraBridge.invoke<WorkItemDetail>('detail', key),
  summary: (key: string) => jiraBridge.invoke<WorkItem>('summary', key),
  transition: (key: string, status: string) => jiraBridge.invoke<void>('transition', key, status),
  comment: (key: string, body: string) => jiraBridge.invoke<void>('comment', key, body),
  me: () => jiraBridge.invoke<string | null>('me')
}

/** Stands for the signed-in user in the assignee filter, since Jira needs an account id, not a name */
export const ME = '@me'

/** Kept on disk so the Tasks tab opens on what it showed last time while fresh data loads behind it */
export const listCache = persistentCache<WorkItemList>('jira.list', 8)
export const detailCache = persistentCache<WorkItemDetail>('jira.detail', 40)
export const summaryCache = persistentCache<WorkItem>('jira.summary', 80)

/** How long each kind of answer is used before it is fetched again in the background */
export const meCache = persistentCache<string | null>('jira.me', 1)

/** Rows one query returns; the list says so when it fills up */
export const LIST_LIMIT = 200

export const TTL = { list: 3 * 60_000, detail: 5 * 60_000, summary: 30 * 60_000, me: 24 * 60 * 60_000 }

/** Selecting an item from elsewhere, e.g. a link preview; the Tasks list picks it up */
export const selection = definePluginSettings('jira-selection', () => ({ key: null as string | null }))

export const DEFAULT_JQL = 'statusCategory != Done ORDER BY updated DESC'

/** Older settings kept the assignee in the query; the Mine / Anyone switch adds it now */
export const withoutAssignee = (jql: string): string => jql.replace(/\bassignee\s*=\s*currentUser\(\)\s*(AND\s*)?/i, '').trim() || DEFAULT_JQL

/**
 * The saved query narrowed by the filters Jira itself can apply, so the row limit isn't spent on items
 * the list would drop anyway. Statuses and text are still matched here, on what comes back.
 */
export function scopedJql(jql: string, { mine, projects }: { mine: boolean; projects: string[] }): string {
  const [where, order] = jql.split(/\border\s+by\b/i)
  const clauses = [
    ...(mine ? ['assignee = currentUser()'] : []),
    ...(projects.length ? [`project in (${projects.join(', ')})`] : []),
    ...(where.trim() ? [`(${where.trim()})`] : [])
  ]
  const query = clauses.join(' AND ')
  return order ? `${query} ORDER BY${order}` : query
}

export const jiraSettings = definePluginSettings('jira', (stored) => ({
  jql: typeof stored.jql === 'string' && stored.jql.trim() ? withoutAssignee(stored.jql) : DEFAULT_JQL,
  /** Statuses moved to another bucket by hand, by status name */
  statusBuckets: Object.fromEntries(
    Object.entries(typeof stored.statusBuckets === 'object' && stored.statusBuckets !== null ? stored.statusBuckets : {}).filter((entry): entry is [string, Bucket] => isBucket(entry[1]))
  )
}))
