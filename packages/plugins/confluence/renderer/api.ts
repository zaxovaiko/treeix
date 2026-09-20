import { atlassianBridge } from '@treeix/atlassian/renderer/atlassianBridge'
import { persistentCache } from '@treeix/atlassian/renderer/cache'
import { definePluginSettings } from '@treeix/sdk'
import type { Page, PageList } from '../shared/types'

export const confluenceBridge = atlassianBridge('confluence')
export const resolveImage = confluenceBridge.resolveImage

/** Pages and the recent list survive restarts, so the tab opens on what it showed last time */
export const pageCache = persistentCache<Page>('confluence.page', 40)
export const recentCache = persistentCache<PageList>('confluence.recent', 2)

export const TTL = { page: 30 * 60_000, recent: 10 * 60_000 }

export const confluenceApi = {
  page: (id: string) => confluenceBridge.invoke<Page>('page', id),
  // A failed lookup shouldn't be cached over the last good list
  recent: () =>
    confluenceBridge.invoke<PageList>('recent').then((list) => {
      if (list.error) throw new Error(list.error)
      return list
    }),
  search: (texts: string[], spaces: string[]) => confluenceBridge.invoke<PageList>('search', texts, spaces)
}

export const TAB_ID = 'confluence'

/** Page id and title slug from a Confluence page URL */
export function pageOfUrl(url: string): { id: string; title: string | null } | null {
  const match = url.match(/\/wiki\/spaces\/[^/]+\/pages\/(\d+)(?:\/([^?#]*))?/)
  if (!match) return null
  return { id: match[1], title: match[2] ? decodeURIComponent(match[2].replace(/\+/g, ' ')) : null }
}

/** Opening a page from elsewhere, e.g. a link preview; the Confluence tab picks it up */
export const openRequest = definePluginSettings('confluence-open', () => ({ id: null as string | null }))
