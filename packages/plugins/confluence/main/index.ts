import { handleAtlassianShared } from '@treeix/atlassian/main/handlers'
import type { MainPlugin } from '@treeix/sdk/main'
import { addComment, deleteComment, pageComments, updateComment } from './comments'
import { pageView, recentPages, searchPages } from './pages'

const plugin: MainPlugin = {
  tools: [{ name: 'acli', purpose: 'Jira work items and Confluence pages', auth: false }],
  activate: (context) => {
    context.handle('page', (_, id: string) => pageView(id))
    context.handle('recent', () => recentPages())
    context.handle('search', (_, texts: string[], spaces: string[]) => searchPages(texts, spaces))
    context.handle('comments', (_, pageId: string) => pageComments(pageId))
    context.handle('addComment', (_, pageId: string, body: string, parentId: string | null) => addComment(pageId, body, parentId ?? null))
    context.handle('updateComment', (_, id: string, body: string) => updateComment(id, body))
    context.handle('deleteComment', (_, id: string) => deleteComment(id))
    handleAtlassianShared(context)
  }
}

export default plugin
