/** Placeholder host for attachment images; nothing is ever requested from it */
export const IMAGE_HOST = 'https://treeix.invalid'

export type ImageResult = { dataUrl: string } | { error: string }

export type CredentialsStatus = { email: string | null; hasToken: boolean }

export type Credentials = { email: string; token: string }

export type Json = Record<string, unknown>
export const isJson = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
export const object = (value: unknown): Json => (isJson(value) ? value : {})
export const text = (value: unknown): string => (typeof value === 'string' ? value : '')
export const orNull = (value: string): string | null => value || null

/** A Jira or Confluence comment; Jira has no threads, so its replies are guessed from leading mentions */
export type AtlassianComment = {
  id: string
  author: string
  authorAvatar: string | null
  authorId: string | null
  created: string
  /** Markdown; attachment images point at IMAGE_HOST sources */
  body: string
  replies?: AtlassianComment[]
}

/** Who a reply answers, mentioned at its start in Jira */
export type Mention = { id: string; name: string }
