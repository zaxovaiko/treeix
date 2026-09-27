import { handleAtlassianShared } from '@treeix/atlassian/main/handlers'
import type { MainPlugin } from '@treeix/sdk/main'
import type { Mention } from '@treeix/atlassian/shared'
import type { WorkItemEdit } from '../shared/types'
import { assignWorkItem, commentOnWorkItem, currentUserName, deleteComment, updateComment, editWorkItem, openEpics, projectKeys, searchWorkItems, transitionWorkItem, workItemDetail, workItemSummary } from './acli'
import { assignableUsers } from './people'

const plugin: MainPlugin = {
  tools: [{ name: 'acli', purpose: 'Jira work items and Confluence pages', auth: false }],
  activate: (context) => {
    context.handle('search', (_, jql: string) => searchWorkItems(jql))
    context.handle('detail', (_, key: string) => workItemDetail(key))
    context.handle('summary', (_, key: string) => workItemSummary(key))
    context.handle('me', () => currentUserName())
    context.handle('projects', () => projectKeys().catch(() => []))
    context.handle('epics', (_, projects: string[]) => openEpics(Array.isArray(projects) ? projects.filter((project) => typeof project === 'string') : []))
    context.handle('transition', (_, key: string, status: string) => transitionWorkItem(key, status))
    context.handle('comment', (_, key: string, body: string, mention: Mention | null) => commentOnWorkItem(key, body, mention ?? null))
    context.handle('updateComment', (_, key: string, id: string, body: string) => updateComment(key, id, body))
    context.handle('deleteComment', (_, key: string, id: string) => deleteComment(key, id))
    context.handle('edit', (_, key: string, changes: WorkItemEdit) => editWorkItem(key, typeof changes === 'object' && changes !== null ? changes : {}))
    context.handle('assign', (_, key: string, accountId: unknown) => assignWorkItem(key, typeof accountId === 'string' ? accountId : null))
    context.handle('assignable', (_, key: string, query: unknown) => assignableUsers(key, typeof query === 'string' ? query : ''))
    handleAtlassianShared(context)
  }
}

export default plugin
