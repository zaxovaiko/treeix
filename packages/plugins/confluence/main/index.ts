import { handleAtlassianShared } from '@treeix/atlassian/main/handlers'
import type { MainPlugin } from '@treeix/sdk/main'
import { pageView, recentPages, searchPages } from './pages'

const plugin: MainPlugin = {
  tools: [{ name: 'acli', purpose: 'Jira work items and Confluence pages', auth: false }],
  activate: (context) => {
    context.handle('page', (_, id: string) => pageView(id))
    context.handle('recent', () => recentPages())
    context.handle('search', (_, texts: string[], spaces: string[]) => searchPages(texts, spaces))
    handleAtlassianShared(context)
  }
}

export default plugin
