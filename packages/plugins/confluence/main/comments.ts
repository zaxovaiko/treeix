import { textToAdf } from '@treeix/atlassian/main/adf'
import { atlassianSite, restFetch } from '@treeix/atlassian/main/cli'
import { loadCredentials } from '@treeix/atlassian/main/credentials'
import { object } from '@treeix/atlassian/shared'
import type { CommentList } from '../shared/types'
import { toCommentTree } from './commentTree'

const ID = /^\d+$/
const checkedId = (id: string): string => {
  if (!ID.test(id)) throw new Error(`Not a Confluence id: ${id}`)
  return id
}

// ponytail: first 250 footer comments, page through _links.next if pages outgrow that
export async function pageComments(pageId: string): Promise<CommentList> {
  try {
    const [response, host] = await Promise.all([
      restFetch(`/wiki/rest/api/content/${checkedId(pageId)}/child/comment?location=footer&depth=all&limit=250&expand=body.atlas_doc_format,history,ancestors`, await loadCredentials()),
      atlassianSite()
    ])
    return { comments: toCommentTree(await response.json(), pageId, host), error: null }
  } catch (reason) {
    return { comments: [], error: reason instanceof Error ? reason.message : String(reason) }
  }
}

const adfBody = (body: string): { representation: string; value: string } => ({ representation: 'atlas_doc_format', value: JSON.stringify(textToAdf(body)) })

/** On the page, or under the comment it answers */
export async function addComment(pageId: string, body: string, parentId: string | null): Promise<void> {
  await restFetch('/wiki/api/v2/footer-comments', await loadCredentials(), {
    method: 'POST',
    json: { ...(parentId ? { parentCommentId: checkedId(parentId) } : { pageId: checkedId(pageId) }), body: adfBody(body) }
  })
}

/** Confluence wants the next version number, so the current one is read first */
export async function updateComment(id: string, body: string): Promise<void> {
  const credentials = await loadCredentials()
  const current = object(await (await restFetch(`/wiki/api/v2/footer-comments/${checkedId(id)}`, credentials)).json())
  const version = Number(object(current.version).number) || 1
  await restFetch(`/wiki/api/v2/footer-comments/${id}`, credentials, { method: 'PUT', json: { version: { number: version + 1 }, body: adfBody(body) } })
}

export async function deleteComment(id: string): Promise<void> {
  await restFetch(`/wiki/api/v2/footer-comments/${checkedId(id)}`, await loadCredentials(), { method: 'DELETE' })
}
