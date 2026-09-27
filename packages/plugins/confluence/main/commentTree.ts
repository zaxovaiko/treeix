import { adfToMarkdown } from '@treeix/atlassian/main/adf'
import { type AtlassianComment, IMAGE_HOST, isJson, object, orNull, text } from '@treeix/atlassian/shared'

function parseAdf(value: unknown): unknown {
  try {
    return typeof value === 'string' ? JSON.parse(value) : value
  } catch {
    return null
  }
}

/** v1 content results with history and ancestors, nested under the comment each one answers */
export function toCommentTree(raw: unknown, pageId: string, host: string | null): AtlassianComment[] {
  const results = object(raw).results
  const roots: AtlassianComment[] = []
  const byId = new Map<string, AtlassianComment>()
  const parents = new Map<string, string>()
  for (const result of Array.isArray(results) ? results.filter(isJson) : []) {
    const author = object(object(result.history).createdBy)
    const avatar = text(object(author.profilePicture).path)
    const comment: AtlassianComment = {
      id: text(result.id),
      author: text(author.displayName) || text(author.publicName),
      authorAvatar: avatar.startsWith('http') ? avatar : avatar && host ? `https://${host}${avatar}` : null,
      authorId: orNull(text(author.accountId)),
      created: text(object(result.history).createdDate),
      body: adfToMarkdown(parseAdf(object(object(result.body).atlas_doc_format).value), {
        mediaSource: (attrs) => `${IMAGE_HOST}/confluence/${pageId}/${encodeURIComponent(text(attrs.id))}`
      }),
      replies: []
    }
    byId.set(comment.id, comment)
    const parent = (Array.isArray(result.ancestors) ? result.ancestors.filter(isJson) : []).filter((ancestor) => ancestor.type === 'comment').at(-1)
    if (parent) parents.set(comment.id, text(parent.id))
  }
  for (const comment of byId.values()) {
    const parent = byId.get(parents.get(comment.id) ?? '')
    if (parent) parent.replies?.push(comment)
    else roots.push(comment)
  }
  return roots
}
