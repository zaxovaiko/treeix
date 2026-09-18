import { adfToMarkdown } from '@treeix/atlassian/main/adf'
import { acli, restFetch } from '@treeix/atlassian/main/cli'
import { loadCredentials } from '@treeix/atlassian/main/credentials'
import { IMAGE_HOST, isJson, object, orNull, text } from '@treeix/atlassian/shared'
import type { Page, PageList, Space } from '../shared/types'
import { cqlString, toPageSummaries } from './search'

const RESULT_LIMIT = 40

/** Space names by id; Confluence only gives pages a space id */
let spaces: Promise<Map<string, Space>> | null = null
export const spaceNames = (): Promise<Map<string, Space>> => {
  spaces ??= acli(['confluence', 'space', 'list', '--limit', '250', '--json'])
    .then((raw) => {
      const results = object(raw).results
      return new Map(
        (Array.isArray(results) ? results.filter(isJson) : []).map((space) => [text(space.id), { id: text(space.id), key: text(space.key), name: text(space.name) }])
      )
    })
    .catch(() => {
      spaces = null
      return new Map<string, Space>()
    })
  return spaces
}

export async function pageView(id: string): Promise<Page> {
  const [raw, knownSpaces] = await Promise.all([
    acli(['confluence', 'page', 'view', '--id', id, '--body-format', 'atlas_doc_format', '--include-direct-children', '--json']).then(object),
    spaceNames()
  ])
  const value = object(object(raw.body).atlas_doc_format).value
  let adf: unknown = null
  try {
    adf = typeof value === 'string' ? JSON.parse(value) : value
  } catch {
    adf = null
  }
  const links = new Set<string>()
  const pageLinks = object(raw._links)
  const children = object(raw.directChildren).results
  return {
    id,
    title: text(raw.title),
    space: knownSpaces.get(text(raw.spaceId))?.name ?? null,
    url: `${text(pageLinks.base)}${text(pageLinks.webui)}`,
    // Confluence images are page attachments, looked up by file id when shown
    body: adfToMarkdown(adf, {
      mediaSource: (attrs) => `${IMAGE_HOST}/confluence/${id}/${encodeURIComponent(text(attrs.id))}`,
      onLink: (url) => void links.add(url)
    }),
    parentId: orNull(text(raw.parentId)),
    children: (Array.isArray(children) ? children.filter(isJson) : []).filter((child) => child.type === 'page').map((child) => ({ id: text(child.id), title: text(child.title) })),
    updatedAt: orNull(text(object(raw.version).createdAt)),
    links: [...links]
  }
}

async function cqlSearch(cql: string): Promise<PageList> {
  try {
    const response = await restFetch(`/wiki/rest/api/search?cql=${encodeURIComponent(cql)}&limit=${RESULT_LIMIT}`, await loadCredentials())
    return { pages: toPageSummaries(await response.json()), error: null }
  } catch (reason) {
    return { pages: [], error: reason instanceof Error ? reason.message : String(reason) }
  }
}

export const recentPages = (): Promise<PageList> => cqlSearch('type = page AND id in recentlyViewedContent(40)')
export const searchPages = (query: string): Promise<PageList> => cqlSearch(`type = page AND siteSearch ~ ${cqlString(query)}`)
