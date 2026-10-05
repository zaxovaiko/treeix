import { type AdfContext, adfToMarkdown, textToAdf } from '@treeix/atlassian/main/adf'
import { editedAdf } from '@treeix/atlassian/main/adfEdit'
import { acli, atlassianSite, failure, run } from '@treeix/atlassian/main/cli'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type AtlassianComment, IMAGE_HOST, type Json, type Mention, object, orNull, text } from '@treeix/atlassian/shared'
import { isString, list } from '@treeix/shared/json'
import type { Epic, WorkItem, WorkItemDetail, WorkItemEdit, WorkItemList } from '../shared/types'

const LIST_LIMIT = 200
// Search only allows the fields it can print; view takes any field
const SEARCH_FIELDS = 'key,summary,status,issuetype,priority,assignee'
const DETAIL_FIELDS = `${SEARCH_FIELDS},project,updated,description,reporter,labels,comment,attachment,parent`
/** acli processes started at once while listing epic children */
const EPIC_CONCURRENCY = 6

/** Public avatar image of a Jira user object */
export const avatarOf = (user: unknown): string | null => orNull(text(object(object(user).avatarUrls)['48x48']))

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
    assigneeId: orNull(text(object(fields.assignee).accountId)),
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
  const [raw, sprint, host] = await Promise.all([
    acli(['jira', 'workitem', 'search', '--jql', jql, '--fields', SEARCH_FIELDS, '--limit', `${LIST_LIMIT}`, '--json']),
    // `--fields key` alone prints nulls, so status rides along
    acli(['jira', 'workitem', 'search', '--jql', sprintJql(jql), '--fields', 'key,status', '--limit', `${LIST_LIMIT}`, '--json']).catch(() => null),
    atlassianSite()
  ])
  // acli prints null when nothing matches
  const issues = Array.isArray(raw) ? raw : []
  const sprintKeys = sprint === null ? null : Array.isArray(sprint) ? sprint.map((issue) => text(object(issue).key)) : []
  return { items: issues.map((issue) => toWorkItem(issue, host)), sprintKeys }
}

/** Inline images name their attachment by file name; the attachment list has the id to download it */
function attachmentSource(fields: Json): AdfContext['mediaSource'] {
  const attachments = (Array.isArray(fields.attachment) ? fields.attachment : []).map(object)
  return (attrs) => {
    const attachment = attachments.find((candidate) => text(candidate.filename) === text(attrs.alt))
    return attachment ? `${IMAGE_HOST}/jira/${text(attachment.id)}` : `${IMAGE_HOST}/missing/${encodeURIComponent(text(attrs.alt) || 'image')}`
  }
}

export async function workItemDetail(key: string): Promise<WorkItemDetail> {
  const [raw, host] = await Promise.all([acli(['jira', 'workitem', 'view', key, '--fields', DETAIL_FIELDS, '--json']), atlassianSite()])
  const fields = object(object(raw).fields)
  const links = new Set<string>()
  const context = { onLink: (url: string) => void links.add(url), mediaSource: attachmentSource(fields) }
  const comments = (Array.isArray(object(fields.comment).comments) ? (object(fields.comment).comments as unknown[]) : []).map(object)
  return {
    ...toWorkItem(raw, host),
    description: adfToMarkdown(fields.description, context),
    reporter: orNull(text(object(fields.reporter).displayName)),
    reporterAvatar: avatarOf(fields.reporter),
    parent: parentOf(fields.parent),
    labels: list(fields.labels, isString),
    comments: threadComments(
      comments.map((comment) => ({
        id: text(comment.id),
        author: text(object(comment.author).displayName),
        authorAvatar: avatarOf(comment.author),
        authorId: orNull(text(object(comment.author).accountId)),
        created: text(comment.created),
        body: adfToMarkdown(comment.body, context),
        replies: []
      }))
    ),
    links: [...links]
  }
}

/**
 * Jira has no threads, so a comment opening with a mention of an earlier commenter nests under the thread
 * of that person's latest comment, one level deep like Confluence
 */
export function threadComments(comments: AtlassianComment[]): AtlassianComment[] {
  const roots: AtlassianComment[] = []
  const threadOf = new Map<string, AtlassianComment>()
  for (const comment of comments) {
    const answered = [...threadOf.keys()].filter((name) => comment.body.startsWith(`@${name}`)).sort((a, b) => b.length - a.length)[0]
    const thread = answered ? threadOf.get(answered) : undefined
    if (thread) thread.replies?.push(comment)
    else roots.push(comment)
    threadOf.set(comment.author, thread ?? comment)
  }
  return roots
}

function parentOf(raw: unknown): WorkItemDetail['parent'] {
  const parent = object(raw)
  const key = text(parent.key)
  return key ? { key, summary: text(object(parent.fields).summary), type: text(object(object(parent.fields).issuetype).name) } : null
}

const PROJECT_KEY = /^[A-Z][A-Z0-9_]*$/

/**
 * Open epics in these projects with the keys under each. Search can't print an item's parent, so every
 * epic gets its own `parent = KEY` query instead.
 */
// ponytail: one acli call per epic, a REST search with the API token would do it in one when epics number in the hundreds
export async function openEpics(projects: string[]): Promise<Epic[]> {
  const keys = projects.filter((project) => PROJECT_KEY.test(project))
  if (keys.length === 0) return []
  const raw = await acli([
    'jira',
    'workitem',
    'search',
    '--jql',
    `project in (${keys.join(', ')}) AND issuetype = Epic AND statusCategory != Done ORDER BY updated DESC`,
    '--fields',
    'key,summary,status',
    '--limit',
    `${LIST_LIMIT}`,
    '--json'
  ])
  const epics = (Array.isArray(raw) ? raw : []).map((issue) => toWorkItem(issue, null))
  const result: Epic[] = []
  for (let start = 0; start < epics.length; start += EPIC_CONCURRENCY) {
    const batch = await Promise.all(
      epics.slice(start, start + EPIC_CONCURRENCY).map(async (epic) => {
        const children = await acli(['jira', 'workitem', 'search', '--jql', `parent = ${epic.key}`, '--fields', 'key,status', '--limit', `${LIST_LIMIT}`, '--json']).catch(
          () => null
        )
        return {
          key: epic.key,
          summary: epic.summary,
          status: epic.status,
          statusCategory: epic.statusCategory,
          children: (Array.isArray(children) ? children : []).map((child) => {
            const item = toWorkItem(child, null)
            return { key: item.key, done: item.statusCategory === 'done' }
          })
        }
      })
    )
    result.push(...batch)
  }
  return result
}

/** Keys of the projects the user can see, so terminals link only real work item keys */
export async function projectKeys(): Promise<string[]> {
  const raw = await acli(['jira', 'project', 'list', '--paginate', '--json'])
  return (Array.isArray(raw) ? raw : []).map((project) => text(object(project).key)).filter((key) => PROJECT_KEY.test(key))
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

/** acli reads ADF bodies from a file */
async function withAdfFile(doc: Json, use: (file: string) => Promise<unknown>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'treeix-adf-'))
  const file = join(dir, 'body.json')
  try {
    await writeFile(file, JSON.stringify(doc))
    await use(file)
  } catch (reason) {
    throw new Error(failure(reason), { cause: reason })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const COMMENT_ID = /^\d+$/
const checkedCommentId = (id: string): string => {
  if (!COMMENT_ID.test(id)) throw new Error(`Not a comment id: ${id}`)
  return id
}

/** A reply is a new comment that mentions who it answers, since Jira comments have no threads */
export const commentOnWorkItem = (key: string, body: string, mention: Mention | null): Promise<void> =>
  withAdfFile(textToAdf(body, mention), (file) => run(['jira', 'workitem', 'comment', 'create', '--key', checkedKey(key), '--body-file', file]))

export const updateComment = (key: string, id: string, body: string): Promise<void> =>
  withAdfFile(textToAdf(body), (file) => run(['jira', 'workitem', 'comment', 'update', '--key', checkedKey(key), '--id', checkedCommentId(id), '--body-adf', file]))

export async function deleteComment(key: string, id: string): Promise<void> {
  await run(['jira', 'workitem', 'comment', 'delete', '--key', checkedKey(key), '--id', checkedCommentId(id)])
}

const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-\d+$/
export const checkedKey = (key: string): string => {
  if (!ISSUE_KEY.test(key)) throw new Error(`Not a work item key: ${key}`)
  return key
}
const LABEL = /^[^\s,]+$/

export async function editWorkItem(key: string, changes: WorkItemEdit): Promise<void> {
  const labels = (list: string[] | undefined): string => (list ?? []).filter((label) => LABEL.test(label)).join(',')
  const args = [
    ...(changes.summary?.trim() ? ['--summary', changes.summary.trim()] : []),
    ...(changes.type?.trim() ? ['--type', changes.type.trim()] : []),
    ...(labels(changes.addLabels) ? ['--labels', labels(changes.addLabels)] : []),
    ...(labels(changes.removeLabels) ? ['--remove-labels', labels(changes.removeLabels)] : [])
  ]
  if (args.length === 0) return
  await run(['jira', 'workitem', 'edit', '--key', checkedKey(key), ...args, '--yes'])
}

/** `original` is the description's markdown the edit started from; a description changed since is refused */
export async function editDescription(key: string, original: string, edited: string): Promise<void> {
  const fields = object(object(await acli(['jira', 'workitem', 'view', checkedKey(key), '--fields', 'description,attachment', '--json'])).fields)
  const doc = editedAdf(fields.description, original, edited, attachmentSource(fields))
  await withAdfFile(doc, (file) => run(['jira', 'workitem', 'edit', '--key', checkedKey(key), '--description-file', file, '--yes']))
}

/** `accountId` null removes the assignee; '@me' is you */
export async function assignWorkItem(key: string, accountId: string | null): Promise<void> {
  await run(['jira', 'workitem', 'assign', '--key', checkedKey(key), ...(accountId ? ['--assignee', accountId] : ['--remove-assignee']), '--yes'])
}

export async function transitionWorkItem(key: string, status: string): Promise<void> {
  await run(['jira', 'workitem', 'transition', '--key', checkedKey(key), '--status', status, '--yes'])
}
