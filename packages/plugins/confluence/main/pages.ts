import { acli, restFetch } from '@treeix/atlassian/main/cli'
import { loadCredentials } from '@treeix/atlassian/main/credentials'
import { object, orNull, text } from '@treeix/atlassian/shared'
import { list } from '@treeix/shared/json'
import type { Page, PageList, Space } from '../shared/types'
import { editedAdf } from '@treeix/atlassian/main/adfEdit'
import { checkedId } from './comments'
import { bodyDoc, bodyMarkdown, pageImageSource } from './commentTree'
import { searchCql, toPageSummaries } from './search'

const RESULT_LIMIT = 40

/** Space names by id; Confluence only gives pages a space id */
let spaces: Promise<Map<string, Space>> | null = null
const spaceNames = (): Promise<Map<string, Space>> => {
  spaces ??= acli(['confluence', 'space', 'list', '--limit', '250', '--json'])
    .then((raw) => {
      const results = object(raw).results
      return new Map(list(results).map((space) => [text(space.id), { id: text(space.id), key: text(space.key), name: text(space.name) }]))
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
  const links = new Set<string>()
  const pageLinks = object(raw._links)
  const children = object(raw.directChildren).results
  return {
    id,
    title: text(raw.title),
    space: knownSpaces.get(text(raw.spaceId))?.name ?? null,
    url: `${text(pageLinks.base)}${text(pageLinks.webui)}`,
    body: bodyMarkdown(raw.body, id, (url) => void links.add(url)),
    parentId: orNull(text(raw.parentId)),
    children: list(children)
      .filter((child) => child.type === 'page')
      .map((child) => ({ id: text(child.id), title: text(child.title) })),
    updatedAt: orNull(text(object(raw.version).createdAt)),
    links: [...links]
  }
}

/** `original` is the body's markdown the edit started from; a page changed since is refused */
export async function editPage(id: string, original: string, edited: string): Promise<void> {
  const credentials = await loadCredentials()
  const path = `/wiki/api/v2/pages/${checkedId(id)}`
  const raw = object(await (await restFetch(`${path}?body-format=atlas_doc_format`, credentials)).json())
  const doc = editedAdf(bodyDoc(raw.body), original, edited, pageImageSource(id))
  await restFetch(path, credentials, {
    method: 'PUT',
    json: {
      id,
      status: 'current',
      title: text(raw.title),
      body: { representation: 'atlas_doc_format', value: JSON.stringify(doc) },
      version: { number: Number(object(raw.version).number) + 1 }
    }
  })
}

async function cqlSearch(cql: string): Promise<PageList> {
  const response = await restFetch(`/wiki/rest/api/search?cql=${encodeURIComponent(cql)}&limit=${RESULT_LIMIT}`, await loadCredentials())
  return { pages: toPageSummaries(await response.json()) }
}

export const recentPages = (): Promise<PageList> => cqlSearch('type = page AND id in recentlyViewedContent(40)')
/** Pages only know their space's name, so the names are looked up as keys; an unknown one is left to the list's own filter */
export async function searchPages(texts: string[], spaces: string[]): Promise<PageList> {
  const known = [...(await spaceNames()).values()]
  const keys = known.filter((space) => spaces.includes(space.name)).map((space) => space.key)
  return cqlSearch(searchCql(texts, keys))
}
