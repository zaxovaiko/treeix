import { atlassianBridge } from '@treeix/atlassian/renderer/atlassianBridge'
import { persistentCache } from '@treeix/atlassian/renderer/cache'
import { definePluginSettings } from '@treeix/sdk'
import { type Bucket, isBucket } from './buckets'
import type { Epic, JiraPerson, WorkItem, WorkItemDetail, WorkItemEdit, WorkItemList } from '../shared/types'

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
  edit: (key: string, changes: WorkItemEdit) => jiraBridge.invoke<void>('edit', key, changes),
  assign: (key: string, accountId: string | null) => jiraBridge.invoke<void>('assign', key, accountId),
  assignable: (key: string, query: string) => jiraBridge.invoke<JiraPerson[]>('assignable', key, query),
  me: () => jiraBridge.invoke<string | null>('me'),
  /** Keyed by comma-joined project keys, the form the cache needs */
  epics: (projects: string) => jiraBridge.invoke<Epic[]>('epics', projects.split(',').filter(Boolean))
}

/** Stands for the signed-in user in the assignee filter, since Jira needs an account id, not a name */
export const ME = '@me'

/** Kept on disk so the Tasks tab opens on what it showed last time while fresh data loads behind it */
export const listCache = persistentCache<WorkItemList>('jira.list', 8)
export const detailCache = persistentCache<WorkItemDetail>('jira.detail', 40)
export const summaryCache = persistentCache<WorkItem>('jira.summary', 80)

/** How long each kind of answer is used before it is fetched again in the background */
export const meCache = persistentCache<string | null>('jira.me', 1)
export const epicCache = persistentCache<Epic[]>('jira.epics', 4)

/** Rows one query returns; the list says so when it fills up */
export const LIST_LIMIT = 200

export const TTL = { list: 3 * 60_000, detail: 5 * 60_000, summary: 30 * 60_000, me: 24 * 60 * 60_000, epics: 15 * 60_000 }

/** Selecting an item from elsewhere, e.g. a link preview; the Tasks list picks it up */
export const selection = definePluginSettings('jira-selection', () => ({ key: null as string | null }))

export const DEFAULT_JQL = 'statusCategory != Done ORDER BY updated DESC'

/** Older settings kept the assignee in the query; the Mine / Anyone switch adds it now */
export const withoutAssignee = (jql: string): string => jql.replace(/\bassignee\s*=\s*currentUser\(\)\s*(AND\s*)?/i, '').trim() || DEFAULT_JQL

/**
 * The saved query narrowed by the filters Jira itself can apply, so the row limit isn't spent on items
 * the list would drop anyway. Statuses and text are still matched here, on what comes back.
 */
export function scopedJql(jql: string, { mine, projects, texts = [] }: { mine: boolean; projects: string[]; texts?: string[] }): string {
  const [where, order] = jql.split(/\border\s+by\b/i)
  const searches = texts.map(textClause).filter((clause) => clause !== null)
  const clauses = [
    ...(mine ? ['assignee = currentUser()'] : []),
    ...(projects.length ? [`project in (${projects.join(', ')})`] : []),
    ...searches,
    // A search looks through everything, finished items too, not just what the saved query shows
    ...(where.trim() && searches.length === 0 ? [`(${where.trim()})`] : [])
  ]
  const query = clauses.join(' AND ')
  return order ? `${query} ORDER BY${order}` : query
}

/** Newest updated or created first, in place of the saved query's own ORDER BY */
export const orderedJql = (jql: string, by: 'updated' | 'created' | null): string => (by ? `${jql.split(/\border\s+by\b/i)[0].trim()} ORDER BY ${by} DESC` : jql)

const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-\d+$/i

/** Text typed in the filter as JQL: an issue key matches that item, anything else Jira's text search with a prefix match */
export function textClause(text: string): string | null {
  const trimmed = text.trim()
  // Lucene syntax characters would turn words into operators, and quotes would end the JQL string
  const words = trimmed.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, ' ').replace(/\s+/g, ' ').trim()
  if (ISSUE_KEY.test(trimmed)) return `(key = ${trimmed.toUpperCase()} OR text ~ "${words}")`
  return words ? `text ~ "${words}*"` : null
}

export const jiraSettings = definePluginSettings('jira', (stored) => ({
  jql: typeof stored.jql === 'string' && stored.jql.trim() ? withoutAssignee(stored.jql) : DEFAULT_JQL,
  /** Statuses moved to another bucket by hand, by status name */
  statusBuckets: Object.fromEntries(
    Object.entries(typeof stored.statusBuckets === 'object' && stored.statusBuckets !== null ? stored.statusBuckets : {}).filter((entry): entry is [string, Bucket] => isBucket(entry[1]))
  )
}))
