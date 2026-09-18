import { IMAGE_HOST, type ImageResult, isJson } from '../shared'
import { restFetch } from './cli'
import { loadCredentials } from './credentials'

const MAX_CACHED = 60
const cache = new Map<string, string>()

async function confluenceDownloadLink(pageId: string, fileId: string): Promise<string> {
  const response = await restFetch(`/wiki/api/v2/pages/${pageId}/attachments?limit=250`, await loadCredentials())
  const body: unknown = await response.json()
  const results = isJson(body) && Array.isArray(body.results) ? body.results.filter(isJson) : []
  const attachment = results.find((candidate) => candidate.fileId === fileId)
  if (!attachment || typeof attachment.downloadLink !== 'string') throw new Error('The image is no longer attached to the page')
  return `/wiki${attachment.downloadLink}`
}

/** Downloads an attachment image behind a placeholder source and returns it as a data URL */
export async function loadImage(source: string): Promise<ImageResult> {
  const cached = cache.get(source)
  if (cached) return { dataUrl: cached }
  const [kind, first, second] = source.replace(`${IMAGE_HOST}/`, '').split('/').map(decodeURIComponent)
  if (kind === 'missing') return { error: `${first} is not attached here` }
  try {
    const path = kind === 'jira' ? `/rest/api/3/attachment/content/${first}` : await confluenceDownloadLink(first, second)
    const response = await restFetch(path, await loadCredentials())
    const type = response.headers.get('content-type') ?? 'image/png'
    const dataUrl = `data:${type};base64,${Buffer.from(await response.arrayBuffer()).toString('base64')}`
    cache.set(source, dataUrl)
    if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value ?? '')
    return { dataUrl }
  } catch (reason) {
    return { error: reason instanceof Error ? reason.message : String(reason) }
  }
}
