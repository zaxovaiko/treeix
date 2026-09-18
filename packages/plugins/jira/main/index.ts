import { handleAtlassianShared } from '@treeix/atlassian/main/handlers'
import type { MainPlugin } from '@treeix/sdk/main'
import { commentOnWorkItem, currentUserName, searchWorkItems, transitionWorkItem, workItemDetail, workItemSummary } from './acli'

const plugin: MainPlugin = {
  tools: [{ name: 'acli', purpose: 'Jira work items and Confluence pages', auth: false }],
  activate: (context) => {
    context.handle('search', (_, jql: string) => searchWorkItems(jql))
    context.handle('detail', (_, key: string) => workItemDetail(key))
    context.handle('summary', (_, key: string) => workItemSummary(key))
    context.handle('me', () => currentUserName())
    context.handle('transition', (_, key: string, status: string) => transitionWorkItem(key, status))
    context.handle('comment', (_, key: string, body: string) => commentOnWorkItem(key, body))
    handleAtlassianShared(context)
  }
}

export default plugin
