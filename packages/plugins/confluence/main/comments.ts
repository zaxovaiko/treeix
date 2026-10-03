import { textToAdf } from '@treeix/atlassian/main/adf'
import { atlassianSite, restFetch } from '@treeix/atlassian/main/cli'
import { loadCredentials } from '@treeix/atlassian/main/credentials'
import { type Credentials, object } from '@treeix/atlassian/shared'
import type { CommentList } from '../shared/types'
import { toCommentTree } from './commentTree'

const ID = /^\d+$/
const checkedId = (id: string): string => {
  if (!ID.test(id)) throw new Error(`Not a Confluence id: ${id}`)
  return id
}

// ponytail: first 250 comments, page through _links.next if pages outgrow that
/** Footer and open inline comments; resolved ones are a location of their own, so they stay out */
export async function pageComments(pageId: string): Promise<CommentList> {
  const [response, host] = await Promise.all([
    restFetch(
      `/wiki/rest/api/content/${checkedId(pageId)}/child/comment?location=footer&location=inline&depth=all&limit=250&expand=body.atlas_doc_format,history,ancestors,extensions.inlineProperties`,
      await loadCredentials()
    ),
    atlassianSite()
  ])
  return { comments: toCommentTree(await response.json(), pageId, host) }
}

const adfBody = (body: string): { representation: string; value: string } => ({ representation: 'atlas_doc_format', value: JSON.stringify(textToAdf(body)) })

/** v2 splits footer and inline comments, so the v1 view of a comment says which endpoint owns it */
async function commentEndpoint(id: string, credentials: Credentials | null): Promise<{ path: string; version: number }> {
  const raw = object(await (await restFetch(`/wiki/rest/api/content/${checkedId(id)}?expand=version`, credentials)).json())
  const location = object(raw.extensions).location === 'inline' ? 'inline' : 'footer'
  return { path: `/wiki/api/v2/${location}-comments`, version: Number(object(raw.version).number) || 1 }
}

/** On the page, or under the comment it answers */
export async function addComment(pageId: string, body: string, parentId: string | null): Promise<void> {
  const credentials = await loadCredentials()
  const path = parentId ? (await commentEndpoint(parentId, credentials)).path : '/wiki/api/v2/footer-comments'
  await restFetch(path, credentials, {
    method: 'POST',
    json: { ...(parentId ? { parentCommentId: checkedId(parentId) } : { pageId: checkedId(pageId) }), body: adfBody(body) }
  })
}

/** Confluence wants the next version number, so the current one is read first */
export async function updateComment(id: string, body: string): Promise<void> {
  const credentials = await loadCredentials()
  const { path, version } = await commentEndpoint(id, credentials)
  await restFetch(`${path}/${id}`, credentials, { method: 'PUT', json: { version: { number: version + 1 }, body: adfBody(body) } })
}

export async function deleteComment(id: string): Promise<void> {
  const credentials = await loadCredentials()
  await restFetch(`${(await commentEndpoint(id, credentials)).path}/${id}`, credentials, { method: 'DELETE' })
}
