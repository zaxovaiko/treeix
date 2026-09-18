import { adfToMarkdown } from '@treeix/atlassian/main/adf'
import { acli, atlassianSite, failure, run } from '@treeix/atlassian/main/cli'
import { IMAGE_HOST, type Json, object, orNull, text } from '@treeix/atlassian/shared'
import type { WorkItem, WorkItemDetail, WorkItemList } from '../shared/types'

const LIST_LIMIT = 200
// Search only allows the fields it can print; view takes any field
const SEARCH_FIELDS = 'key,summary,status,issuetype,priority,assignee'
const DETAIL_FIELDS = `${SEARCH_FIELDS},project,updated,description,reporter,labels,comment,attachment`

/** Public avatar image of a Jira user object */
const avatarOf = (user: unknown): string | null => orNull(text(object(object(user).avatarUrls)['48x48']))

const CATEGORIES: Record<string, WorkItem['statusCategory']> = { new: 'new', indeterminate: 'indeterminate', done: 'done' }

/** Jira REST issue JSON, which `acli --json` prints */
export function toWorkItem(raw: unknown, site: string | null): WorkItem {
  const issue = object(raw)
  const fields = object(issue.fields)
  const status = object(fields.status)
  const key = text(issue.key)
  return {
    key,
    summary: text(fields.summary),
    status: text(status.name),
    statusCategory: CATEGORIES[text(object(status.statusCategory).key)] ?? 'new',
    type: text(object(fields.issuetype).name),
    priority: orNull(text(object(fields.priority).name)),
    assignee: orNull(text(object(fields.assignee).displayName)),
    assigneeAvatar: avatarOf(fields.assignee),
    // Search can't return the project, so the key prefix stands in until the detail loads
    project: text(object(fields.project).name) || key.split('-')[0],
    updatedAt: text(fields.updated),
    url: site && key ? `https://${site}/browse/${key}` : null
  }
}

/** The same query narrowed to open sprints; ORDER BY has to stay last */
export function sprintJql(jql: string): string {
  const [where, order] = jql.split(/\border\s+by\b/i)
  return `(${where.trim() || 'assignee = currentUser()'}) AND sprint in openSprints()${order ? ` ORDER BY${order}` : ''}`
}

export async function searchWorkItems(jql: string): Promise<WorkItemList> {
  try {
    const [raw, sprint, host] = await Promise.all([
      acli(['jira', 'workitem', 'search', '--jql', jql, '--fields', SEARCH_FIELDS, '--limit', `${LIST_LIMIT}`, '--json']),
      // `--fields key` alone prints nulls, so status rides along
      acli(['jira', 'workitem', 'search', '--jql', sprintJql(jql), '--fields', 'key,status', '--limit', `${LIST_LIMIT}`, '--json']).catch(() => null),
      atlassianSite()
    ])
    // acli prints null when nothing matches
    const issues = Array.isArray(raw) ? raw : []
    const sprintKeys = sprint === null ? null : Array.isArray(sprint) ? sprint.map((issue) => text(object(issue).key)) : []
    return { items: issues.map((issue) => toWorkItem(issue, host)), sprintKeys, error: null }
  } catch (reason) {
    return { items: [], sprintKeys: null, error: failure(reason) }
  }
}

export async function workItemDetail(key: string): Promise<WorkItemDetail> {
  const [raw, host] = await Promise.all([
    acli(['jira', 'workitem', 'view', key, '--fields', DETAIL_FIELDS, '--json']),
    atlassianSite()
  ])
  const fields = object(object(raw).fields)
  // Inline images name their attachment by file name; the attachment list has the id to download it
  const attachments = (Array.isArray(fields.attachment) ? fields.attachment : []).map(object)
  const links = new Set<string>()
  const context = {
    onLink: (url: string) => void links.add(url),
    mediaSource: (attrs: Json): string | null => {
      const attachment = attachments.find((candidate) => text(candidate.filename) === text(attrs.alt))
      return attachment ? `${IMAGE_HOST}/jira/${text(attachment.id)}` : `${IMAGE_HOST}/missing/${encodeURIComponent(text(attrs.alt) || 'image')}`
    }
  }
  const comments = (Array.isArray(object(fields.comment).comments) ? (object(fields.comment).comments as unknown[]) : []).map(object)
  return {
    ...toWorkItem(raw, host),
    description: adfToMarkdown(fields.description, context),
    reporter: orNull(text(object(fields.reporter).displayName)),
    reporterAvatar: avatarOf(fields.reporter),
    labels: Array.isArray(fields.labels) ? fields.labels.filter((label): label is string => typeof label === 'string') : [],
    comments: comments.map((comment) => ({ author: text(object(comment.author).displayName), authorAvatar: avatarOf(comment.author), created: text(comment.created), body: adfToMarkdown(comment.body, context) })),
    links: [...links]
  }
}

/** Your own display name, for the Mine filter; acli only reports the account email */
export async function currentUserName(): Promise<string | null> {
  const raw = await acli(['jira', 'workitem', 'search', '--jql', 'assignee = currentUser() ORDER BY updated DESC', '--fields', 'assignee', '--limit', '1', '--json'])
  const first = Array.isArray(raw) ? object(raw[0]) : {}
  return orNull(text(object(object(first.fields).assignee).displayName))
}

/** Just the list fields of one item, for link previews */
export async function workItemSummary(key: string): Promise<WorkItem> {
  const [raw, host] = await Promise.all([acli(['jira', 'workitem', 'view', key, '--fields', SEARCH_FIELDS, '--json']), atlassianSite()])
  return toWorkItem(raw, host)
}

export async function commentOnWorkItem(key: string, body: string): Promise<void> {
  await run(['jira', 'workitem', 'comment', 'create', '--key', key, '--body', body]).catch((reason: unknown) => {
    throw new Error(failure(reason))
  })
}

export async function transitionWorkItem(key: string, status: string): Promise<void> {
  await run(['jira', 'workitem', 'transition', '--key', key, '--status', status, '--yes']).catch((reason: unknown) => {
    throw new Error(failure(reason))
  })
}
