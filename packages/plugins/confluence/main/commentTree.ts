import { type AdfContext, adfToMarkdown } from '@treeix/atlassian/main/adf'
import { type AtlassianComment, IMAGE_HOST, object, orNull, text } from '@treeix/atlassian/shared'
import { list, parseJson } from '@treeix/shared/json'

/** A page or comment body, whose ADF comes as a JSON string, as markdown; images are the page's attachments */
export const bodyMarkdown = (body: unknown, pageId: string, onLink?: (url: string) => void): string =>
  adfToMarkdown(bodyDoc(body), { mediaSource: pageImageSource(pageId), onLink })

export function bodyDoc(body: unknown): unknown {
  const value = object(object(body).atlas_doc_format).value
  return typeof value === 'string' ? parseJson(value) : value
}

export const pageImageSource =
  (pageId: string): AdfContext['mediaSource'] =>
  (attrs) =>
    `${IMAGE_HOST}/confluence/${pageId}/${encodeURIComponent(text(attrs.id))}`

/** v1 content results with history, ancestors and inline properties, nested under the comment each one answers */
export function toCommentTree(raw: unknown, pageId: string, host: string | null): AtlassianComment[] {
  const results = object(raw).results
  const roots: AtlassianComment[] = []
  const byId = new Map<string, AtlassianComment>()
  const parents = new Map<string, string>()
  for (const result of list(results)) {
    const author = object(object(result.history).createdBy)
    const avatar = text(object(author.profilePicture).path)
    const comment: AtlassianComment = {
      id: text(result.id),
      author: text(author.displayName) || text(author.publicName),
      authorAvatar: avatar.startsWith('http') ? avatar : avatar && host ? `https://${host}${avatar}` : null,
      authorId: orNull(text(author.accountId)),
      created: text(object(result.history).createdDate),
      body: bodyMarkdown(result.body, pageId),
      quote: text(object(object(result.extensions).inlineProperties).originalSelection) || undefined,
      replies: []
    }
    byId.set(comment.id, comment)
    const parent = list(result.ancestors)
      .filter((ancestor) => ancestor.type === 'comment')
      .at(-1)
    if (parent) parents.set(comment.id, text(parent.id))
  }
  for (const comment of byId.values()) {
    const parent = byId.get(parents.get(comment.id) ?? '')
    if (parent) parent.replies?.push(comment)
    else roots.push(comment)
  }
  return roots
}
